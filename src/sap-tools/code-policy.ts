/** 局部替换与完整覆盖互斥，空 newString 可用于删除文本。 */
export function validateSourceMode(args: { fullSource?: unknown; oldString?: unknown; newString?: unknown }): void {
  if (args.fullSource !== undefined) {
    if (args.oldString !== undefined || args.newString !== undefined) throw new Error("参数无效：fullSource 与 oldString/newString 不能混传。")
    if (typeof args.fullSource !== "string" || !args.fullSource.trim()) throw new Error("参数无效：fullSource 不能为空。")
  } else if (typeof args.oldString !== "string" || !args.oldString || typeof args.newString !== "string") {
    throw new Error("参数缺失：局部替换需要非空 oldString 和字符串 newString；整段覆盖请仅传 fullSource。")
  }
}

/** 跳过 ABAP 与 CDS 注释，同时保留字符串字面量供后续扫描。 */
function codeWithoutComments(line: string, blockComment: boolean): { code: string; blockComment: boolean } {
  // ABAP 的 * 注释必须位于首列；CDS DDL 还支持 // 和 /* ... */。
  if (!blockComment && line.startsWith("*")) return { code: "", blockComment: false }
  let code = ""
  let literal: "'" | "`" | null = null
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    const next = line[i + 1]
    if (blockComment) {
      if (char === "*" && next === "/") { blockComment = false; i++ }
      continue
    }
    if (literal) {
      code += char
      if (char === literal) {
        if (next === literal) { code += next; i++ } // ABAP 中 '' 和 `` 是字面量内的转义
        else literal = null
      }
      continue
    }
    if (char === "'" || char === "`") { literal = char; code += char; continue }
    if (char === '"' || (char === "/" && next === "/")) break
    if (char === "/" && next === "*") { blockComment = true; i++; continue }
    code += char
  }
  return { code, blockComment }
}

/**
 * 扫描 ABAP 代码：硬编码中文文案是阻断项；结构/表字段的裸内置类型只提示。
 * 程序内局部变量/临时量（DATA、方法参数、函数接口等）不需要提示。
 */
export function scanCodeIssues(code: string): { violations: string[]; warnings: string[] } {
  const violations: string[] = []
  const warnings: string[] = []
  if (!code) return { violations, warnings }
  const lines = code.split(/\r?\n/)

  const bareTypes = new Set([
    "c", "n", "i", "p", "string", "xstring", "d", "t", "decfloat16", "decfloat34",
    "int1", "int2", "int4", "int8", "char1", "char2", "char3", "char4",
    "char10", "char12", "char20", "char30", "char40", "char50", "char60",
    "char80", "char100", "char120", "char132", "char133", "char200", "char255",
    "numc2", "numc3", "numc4", "numc5", "numc6", "numc8", "numc10",
    "dats", "tims", "tstmp", "raw", "rawstring", "unit", "curr", "quan",
  ])
  let typeDefDepth = 0 // TYPES: BEGIN OF ... END OF 嵌套深度
  let inDefineBlock = false // define structure/table { ... } DDIC DSL 块内
  let blockComment = false

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const stripped = codeWithoutComments(raw, blockComment)
    const noComment = stripped.code
    blockComment = stripped.blockComment
    // CDS 注解行（@EndUserText.label / @AbapCatalog.* 等）：值是 DDIC 元数据文本（视图描述），
    // 不是运行时用户可见文案，且 CDS 源码无 DATA 声明 → 两类扫描都豁免
    const isAnnotationLine = noComment.trim().startsWith("@")
    if (isAnnotationLine) continue

    // 1) 硬编码中文：单引号字符串字面量含中文（MESSAGE WITH '中文'、VALUE #( message = '中文' ) 等）
    //    + ABAP 反引号文本字面量（`中文`，不限长字符串）也属于用户可见文案，一并扫描
    const cnMatches = noComment.match(/'([^']*[一-龥][^']*)'/g) || []
    const btMatches = noComment.match(/`([^`]*[一-龥][^`]*)`/g) || []
    const allCn = [...cnMatches, ...btMatches]
    if (allCn.length) {
      for (const m of allCn) {
        const text = m.slice(1, -1)
        // 允许中文变量名/字段名等非常规场景极少，一律视为文案违规（规范要求走消息类/文本元素）
        violations.push(`第 ${i + 1} 行：硬编码中文文案 ${text.length > 20 ? text.slice(0, 20) + "…" : text}（必须改为消息类 MESSAGE e001(zxxx) 或文本元素 TEXT-xxx）`)
      }
    }

    // 2) 自建结构/表类型字段的裸类型只提示，不阻断保存。
    const hasTypesKw = /\bTYPES\b/i.test(noComment)
    if (/\bBEGIN\s+OF\b/i.test(noComment) && hasTypesKw) typeDefDepth++
    if (/\bEND\s+OF\b/i.test(noComment)) typeDefDepth = Math.max(0, typeDefDepth - 1)
    if (hasTypesKw || typeDefDepth > 0) {
      // 一行内可能有多个 TYPE（如 a TYPE i, b TYPE string.）→ 全部检查
      const typeTokens = noComment.matchAll(/TYPE\s+([a-z]\w*)/gi)
      for (const m of typeTokens) {
        const t = m[1].toLowerCase()
        if (bareTypes.has(t)) {
          warnings.push(`第 ${i + 1} 行：结构/表类型字段使用裸类型 TYPE ${t.toUpperCase()}；有合适的 DDIC 数据元素时可优先使用。`)
        }
      }
    }

    // 3) DDIC DSL 结构/表字段的 abap.<内置类型> 同样只提示。
    //    （abap.clnt / abap.cust 是客户端键特殊标记，放行；数据元素按名字引用、reference to 均不在此列）
    const defineKw = /\bdefine\s+(?:append\s+)?(structure|table)\b/i.test(noComment)
    if (defineKw) inDefineBlock = true
    const dslField = noComment.match(/^\s*(?:key\s+)?[A-Za-z_][\w]*\s*:\s*abap\.([A-Za-z0-9_]+)/)
    if (dslField && (inDefineBlock || defineKw)) {
      const at = dslField[1].toLowerCase()
      if (at !== "clnt" && at !== "cust") {
        warnings.push(`第 ${i + 1} 行：DDIC 结构/表字段使用裸类型 abap.${at.toUpperCase()}；有合适的 DDIC 数据元素时可优先使用。`)
      }
    }
    if (noComment.includes("}")) inDefineBlock = false
  }
  return { violations, warnings }
}

/** 兼容已有调用者：只返回会阻断写入的规则。 */
export function scanCodeViolations(code: string): string[] {
  return scanCodeIssues(code).violations
}
