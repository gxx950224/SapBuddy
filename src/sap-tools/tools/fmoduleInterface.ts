/**
 * 函数模块接口参数强控：检测源码里写入的参数段，规范化为服务器接受的格式。
 *
 * 关键事实（真机实测）：ADT 服务器会从 /source/main 的源码 PUT 里自动提取函数模块的
 * IMPORTING/EXPORTING/CHANGING/TABLES/EXCEPTIONS 参数，持久化进接口元数据（FUPARAREF），
 * 不需要也不该改 fmodule 对象 XML（其元数据不含 interface，且 PUT 走 v3 Content-Type schema）。
 * 但服务器对参数写法有硬性约束：
 *  - OPTIONAL 任意段可用；
 *  - DEFAULT 仅 IMPORTING/CHANGING 可用，EXPORTING 用 DEFAULT 报 "Parameter DEFAULT declares no type"；
 *  - DEFAULT 与 OPTIONAL 不能同时用于同一参数；
 *  - TABLES 参数不能内联 "TYPE ... TABLE OF ..."，须引用已存在类型（如 STRING_TABLE）或 LIKE 已有内表。
 *
 * 本模块把 LLM 可能写出的非法格式自动修正（EXPORTING 段 DEFAULT 移除 / DEFAULT 与 OPTIONAL 冲突时
 * 保留 DEFAULT 移除 OPTIONAL），无法修正的（TABLES 内联表类型）放进 errors 让调用方中止并提示。
 */
export type FmKind = "importing" | "exporting" | "changing" | "tables" | "exceptions"
export const FM_KINDS: FmKind[] = ["importing", "exporting", "changing", "tables", "exceptions"]

export interface FmParam {
  name: string
  /** 类型表达式（大写），如 STRING / CHAR10 / TABLE OF STRING / ZDATA_ELEMENT */
  type: string
  typeKind: "TYPE" | "LIKE"
  optional: boolean
  defaultValue: string
}

export interface FmParseResult {
  /** 是否识别到"函数模块源码里写了参数段" */
  matched: boolean
  moduleName: string
  /** 按段分组的参数；只含实际出现的段 */
  groups: Partial<Record<FmKind, FmParam[]>>
  /** 源码里显式声明了哪些段（空段 = 清空该段接口） */
  presentKinds: FmKind[]
  /** 剥离参数段后的干净源码（FUNCTION <name>. + 主体） */
  cleanSource: string
}

export interface FmNormalizeResult {
  matched: boolean
  /** 规范化后的完整源码（参数块保留），可直接 PUT；无修正时等于原 source */
  normalized: string
  /** 自动修正的说明（人类可读，写入成功信息里回显给用户） */
  notes: string[]
  /** 无法自动修正的错误，非空时调用方应中止写入 */
  errors: string[]
  groups: Partial<Record<FmKind, FmParam[]>>
  presentKinds: FmKind[]
}

const KIND_RE = /^\s*(IMPORTING|EXPORTING|CHANGING|TABLES|EXCEPTIONS)\b/i
/** Open SQL 语句起始关键字：进入 SQL 窗口后直到行尾句点才结束（主机变量须加 @ 前缀） */
const SQL_START_RE = /^\s*(SELECT|INSERT|UPDATE|MODIFY|DELETE|WITH|MERGE)\b/i
const FUNC_RE = /^\s*FUNCTION\s+([A-Za-z][A-Za-z0-9_]*)\b/i
/** 函数模块自身源码通道：/functions/groups/<函数组>/fmodules/<函数模块>/source/main（服务器从这里提取接口参数） */
const FMODULE_SOURCE_RE = /\/functions\/groups\/[^/]+\/fmodules\/[^/]+\/source\/main$/i

/** 判断编辑通道是否为函数模块自身源码（否则接口参数段写进去 SAP 报 IMPORTING is not expected 且不提取） */
export function isFmoduleSourceChannel(sourceUri: string): boolean {
  return FMODULE_SOURCE_RE.test(sourceUri)
}

/** 检测源码里是否用 *" 注释行写了函数模块接口参数（错误写法）。
 *  函数模块自身的 /source/main 通道合法内容永远不会出现 *"（有参数时显示真实声明，无参数时显示模板注释），
 *  出现 *" + 参数段关键字 / VALUE( 说明 LLM 想用注释代替真实声明——注释不会被服务器提取进接口，必须拦截引导。 */
export function detectCommentParamBlock(source: string): boolean {
  return /^\s*\*"\s*(IMPORTING|EXPORTING|CHANGING|TABLES|EXCEPTIONS)\b|^\s*\*"\s*VALUE\s*\(/im.test(source)
}

/** 解析一行参数定义 → FmParam；非参数行返回 undefined */
function parseParamLine(t: string): FmParam | undefined {
  // 去掉行尾句点（参数段结束符），注意 DEFAULT 'X.' 里的句点在引号内不受影响
  const line = t.replace(/\.\s*$/, "")
  let name = ""
  let rest = line
  const vm = /^VALUE\s*\(\s*([A-Za-z][A-Za-z0-9_]*)\s*\)/i.exec(line)
  if (vm) {
    name = vm[1].toUpperCase()
    rest = line.slice(vm[0].length)
  } else {
    const nm = /^([A-Za-z][A-Za-z0-9_]*)\b/.exec(line)
    if (!nm) return undefined
    name = nm[1].toUpperCase()
    rest = line.slice(nm[0].length)
  }
  const tm = /^\s*(TYPE|LIKE)\s+/i.exec(rest)
  if (!tm) return undefined
  const typeKind = tm[1].toUpperCase() as "TYPE" | "LIKE"
  let typeExpr = rest.slice(tm[0].length).trim()
  let defaultValue = ""
  const dv = /DEFAULT\s+([^\s]+)/i.exec(typeExpr)
  if (dv) {
    defaultValue = dv[1]
    typeExpr = typeExpr.slice(0, dv.index).trim()
  }
  let optional = false
  if (/\bOPTIONAL\b/i.test(typeExpr)) {
    optional = true
    typeExpr = typeExpr.replace(/\bOPTIONAL\b/i, "").trim()
  }
  typeExpr = typeExpr.replace(/\bAS\s+(REFERENCE|VALUE)\b/i, "").trim()
  if (!typeExpr) return undefined
  return { name, type: typeExpr.toUpperCase(), typeKind, optional, defaultValue }
}

/**
 * 从源码识别"函数模块参数段写进了源码"并拆出参数。
 * 兼容两种错误写法：
 *   FUNCTION ZFM_X\n  IMPORTING ... \n  ... .            （函数名后无句点，段尾句点收束）
 *   FUNCTION ZFM_X.  + 独立 IMPORTING ... 段             （函数名带句点，段跟在后面）
 * 返回 matched=true 时，cleanSource 已剥离参数段（只留 FUNCTION <name>. + 主体）。
 */
export function parseFunctionModuleParams(source: string): FmParseResult {
  const none: FmParseResult = { matched: false, moduleName: "", groups: {}, presentKinds: [], cleanSource: source }
  const lines = source.split(/\r?\n/)
  let funcIdx = -1
  let moduleName = ""
  for (let i = 0; i < lines.length; i++) {
    const m = FUNC_RE.exec(lines[i])
    if (m) { funcIdx = i; moduleName = m[1].toUpperCase(); break }
  }
  if (funcIdx < 0) return none

  // 函数名后第一个非空/非注释行必须是段关键字，才算"参数段写进源码"
  let firstKindIdx = -1
  for (let i = funcIdx + 1; i < lines.length; i++) {
    const t = lines[i].trim()
    if (KIND_RE.test(t)) { firstKindIdx = i; break }
    if (t === "" || t.startsWith("*") || t.startsWith("\"")) continue
    break
  }
  if (firstKindIdx < 0) return none

  const groups: Partial<Record<FmKind, FmParam[]>> = {}
  const presentKinds: FmKind[] = []
  let kind: FmKind | null = null
  let i = firstKindIdx
  let blockEndExclusive = lines.length
  for (; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t === "" || t.startsWith("*") || t.startsWith("\"")) continue
    const km = KIND_RE.exec(t)
    if (km) {
      kind = km[1].toLowerCase() as FmKind
      if (!presentKinds.includes(kind)) presentKinds.push(kind)
      continue
    }
    if (!kind) { blockEndExclusive = i; break } // 段关键字之前出现代码 → 不是参数段，中止
    if (t === ".") { blockEndExclusive = i + 1; break } // 独立句点收束参数段
    // 参数行判定：NAME TYPE/LIKE ... 或 VALUE(NAME) TYPE/LIKE ...
    const vm = /^VALUE\s*\(\s*([A-Za-z][A-Za-z0-9_]*)\s*\)/i.exec(t)
    const nm = vm ? null : /^([A-Za-z][A-Za-z0-9_]*)\b/.exec(t)
    const restCheck = vm ? t.slice(vm[0].length) : (nm ? t.slice(nm[1].length) : "")
    const isParamLine = (vm !== null || nm !== null) && /^(TYPE|LIKE)\b/.test(restCheck.trimStart())
    if (isParamLine) {
      const parsed = parseParamLine(t)
      if (parsed) {
        groups[kind] = groups[kind] ?? []
        groups[kind]!.push(parsed)
      }
      if (/\.$/.test(t)) { blockEndExclusive = i + 1; break }
      continue
    }
    if (kind === "exceptions") {
      // EXCEPTIONS 的参数行只有异常名
      const en = nm ? nm[1].toUpperCase() : ""
      if (en) {
        groups[kind] = groups[kind] ?? []
        groups[kind]!.push({ name: en, type: "", typeKind: "TYPE", optional: false, defaultValue: "" })
      }
      if (/\.$/.test(t)) { blockEndExclusive = i + 1; break }
      continue
    }
    blockEndExclusive = i
    break
  }
  if (presentKinds.length === 0) return none

  const cleanLines = lines.slice(0, funcIdx).concat([`FUNCTION ${moduleName}.`]).concat(lines.slice(blockEndExclusive))
  return { matched: true, moduleName, groups, presentKinds, cleanSource: cleanLines.join("\n") }
}

/**
 * 检测源码里的函数模块参数段，并把服务器不接受的写法规范化：
 *  - EXPORTING 段参数的 DEFAULT 移除（DEFAULT 只允许 IMPORTING/CHANGING）
 *  - 同一参数的 DEFAULT 与 OPTIONAL 冲突 → 保留 DEFAULT 移除 OPTIONAL
 *  - TABLES 参数内联 "TYPE ... TABLE OF ..." → 无法自动修正，进 errors
 * 其余行原样保留。参数段随源码保留并放行写入，由服务器提取进接口元数据。
 */
export function normalizeFunctionModuleParams(source: string): FmNormalizeResult {
  const none: FmNormalizeResult = { matched: false, normalized: source, notes: [], errors: [], groups: {}, presentKinds: [] }
  const lines = source.split(/\r?\n/)
  let funcIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (FUNC_RE.test(lines[i])) { funcIdx = i; break }
  }
  if (funcIdx < 0) return none

  let firstKindIdx = -1
  for (let i = funcIdx + 1; i < lines.length; i++) {
    const t = lines[i].trim()
    if (KIND_RE.test(t)) { firstKindIdx = i; break }
    if (t === "" || t.startsWith("*") || t.startsWith("\"")) continue
    break
  }
  if (firstKindIdx < 0) return none

  const groups: Partial<Record<FmKind, FmParam[]>> = {}
  const presentKinds: FmKind[] = []
  const notes: string[] = []
  const errors: string[] = []
  const out = lines.slice()
  let changed = false
  let kind: FmKind | null = null

  // 服务器对函数模块源码的规范写法是 FUNCTION <name>（不带句点）。若写成 FUNCTION <name>.，
  // 服务器会把 FUNCTION 句点后的参数段当成独立块处理，读回时模板头部（注释 + 独立 .）残留，
  // 参数区提前结束、IMPORTING 被当成函数体语句（报 IMPORTING is not expected，真机实测）。
  // 统一去掉 FUNCTION 行尾句点，避免残留模板头。
  if (/\.\s*$/.test(lines[funcIdx])) {
    out[funcIdx] = lines[funcIdx].replace(/\.\s*$/, "")
    changed = true
    notes.push(`FUNCTION 行尾句点已移除（规范写法 FUNCTION <name> 不带句点）`)
  }

  const pushParam = (k: FmKind, p: FmParam) => {
    groups[k] = groups[k] ?? []
    groups[k]!.push(p)
  }
  const rebuild = (origLine: string, p: FmParam, dropDefault: boolean, dropOptional: boolean): string => {
    const hadDot = /\.\s*$/.test(origLine)
    const isValue = /^VALUE\s*\(/i.test(origLine.trimStart())
    const prefix = isValue ? `VALUE(${p.name})` : p.name
    const indent = /^\s*/.exec(origLine)?.[0] ?? ""
    let s = `${indent}${prefix} ${p.typeKind} ${p.type}`
    if (!dropOptional && p.optional) s += " OPTIONAL"
    if (!dropDefault && p.defaultValue) s += ` DEFAULT ${p.defaultValue}`
    return hadDot ? s + "." : s
  }

  for (let i = firstKindIdx; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t === "" || t.startsWith("*") || t.startsWith("\"")) continue
    const km = KIND_RE.exec(t)
    if (km) {
      kind = km[1].toLowerCase() as FmKind
      if (!presentKinds.includes(kind)) presentKinds.push(kind)
      continue
    }
    if (!kind) break
    if (t === ".") break
    const vm = /^VALUE\s*\(\s*([A-Za-z][A-Za-z0-9_]*)\s*\)/i.exec(t)
    const nm = vm ? null : /^([A-Za-z][A-Za-z0-9_]*)\b/.exec(t)
    const restCheck = vm ? t.slice(vm[0].length) : (nm ? t.slice(nm[1].length) : "")
    const isParamLine = (vm !== null || nm !== null) && /^(TYPE|LIKE)\b/.test(restCheck.trimStart())
    if (isParamLine) {
      const p = parseParamLine(t)
      if (p) {
        pushParam(kind, p)
        if (kind !== "exceptions") {
          // 真机实测：内联表类型（TYPE STANDARD TABLE OF X / TYPE TABLE OF X）在**任何**参数段都会被服务器拒绝
          // （报 "Parameter OF declares no type"），不只是 TABLES 段。要返回表只能用 LIKE <表> 或已定义的表类型。
          if (/^(STANDARD\s+|SORTED\s+|HASHED\s+)?TABLE\s+OF\b/i.test(p.type)) {
            errors.push(
              `${kind.toUpperCase()} 参数 ${p.name} 不能内联声明表类型 "${p.type}"（SAP 会报 Parameter OF declares no type）。\n` +
              `要返回一张表，推荐写进 TABLES 段（函数模块返回表的经典做法，真机验证可正常激活）：\n` +
              `  TABLES\n    ${p.name} LIKE <表名>    （如 TABLES ET_MARC LIKE MARC，函数体用 INTO TABLE @${p.name}）\n` +
              `或把表类型改成引用已存在的表类型：\n` +
              `  ${p.name} TYPE <已存在的表类型>（如 ${p.name} TYPE STRING_TABLE）`
            )
          }
          let dropDefault = false
          let dropOptional = false
          if (p.defaultValue && kind === "exporting") {
            dropDefault = true
            notes.push(`EXPORTING 参数 ${p.name} 的 DEFAULT ${p.defaultValue} 无效已移除（DEFAULT 只用于 IMPORTING/CHANGING）`)
          }
          if (p.defaultValue && p.optional) {
            dropOptional = true
            notes.push(`参数 ${p.name} 同时写了 DEFAULT 与 OPTIONAL，已保留 DEFAULT 去掉 OPTIONAL（两者不能并存）`)
          }
          if (dropDefault || dropOptional) {
            out[i] = rebuild(lines[i], p, dropDefault, dropOptional)
            changed = true
          }
        }
      }
      if (/\.$/.test(t)) break
      continue
    }
    if (kind === "exceptions") {
      const en = nm ? nm[1].toUpperCase() : ""
      if (en) pushParam(kind, { name: en, type: "", typeKind: "TYPE", optional: false, defaultValue: "" })
      if (/\.$/.test(t)) break
      continue
    }
    // 参数段无收束句点就遇到函数体语句（如 SELECT/READ TABLE）→ 自动补一个独立 . 让服务器知道参数区在此结束。
    // 否则服务器把函数体语句误解析进参数区（真机实测报 SELECT is unexpected）。
    // 这覆盖 LLM 最常见的坑：读模板时把模板里那行独立 . 当噪音删掉了。
    const blockIndent = /^\s*/.exec(lines[firstKindIdx])?.[0] ?? ""
    out.splice(i, 0, `${blockIndent}.`)
    changed = true
    notes.push(`参数段缺少收束句点，已自动补独立 . （函数体语句从参数区后开始）`)
    break
  }
  if (presentKinds.length === 0) return none
  return { matched: true, normalized: changed ? out.join("\n") : source, notes, errors, groups, presentKinds }
}

/** FORM 参数内联表类型 → 自动修正。
 *  真机实测：FORM 参数段（TABLES/USING/CHANGING）写 `CT_X TYPE STANDARD TABLE OF <表>` 会被 SAP
 *  当成 6 个形式参数展开，PERFORM 侧对不上报 "Different number of parameters in FORM and PERFORM
 *  (formal: 6, actual: 4)"（内联表类型按结构字段展开，一列变成一个形式参数）。
 *  正确写法：先在 include 里定义表类型 `TYPES: tt_<表> TYPE STANDARD TABLE OF <表>.`，
 *  FORM 参数引用 `TYPE tt_<表>`。本函数自动把 FORM 参数段的内联表类型改写为对 tt_<表> 的引用，
 *  并在 include 顶部补类型定义（尚未定义时）。只处理 FORM 参数行；函数体里合法的
 *  `DATA x TYPE STANDARD TABLE OF mard` 不受影响。 */
export function normalizeFormIncludeSource(source: string): { source: string; changed: boolean; notes: string[] } {
  const lines = source.split(/\r?\n/)
  const out = lines.slice()
  const notes: string[] = []
  let changed = false
  let inForm = false
  let interfaceActive = false
  const needed = new Map<string, string>() // 表名(大写) -> tt_<表>

  const FORM_RE = /^\s*FORM\s+[A-Za-z_][A-Za-z0-9_]*\b/i
  const ENDFORM_RE = /^\s*ENDFORM\b/i
  const KW_RE = /^\s*(TABLES|USING|CHANGING)\b/i
  // 声明语句起始：FORM 接口行只可能是参数声明；DATA/TYPES/... 是函数体声明，遇到即接口结束
  const DECL_RE = /^\s*(DATA|TYPES|CONSTANTS|STATICS|CLASS-DATA|FIELD-SYMBOLS|PARAMETERS|CLASS)\b/i
  // 参数声明（参数名可 VALUE(...) 包裹）：识别"这行是否属于 FORM 接口"
  const PARAM_RE = /(?:VALUE\s*\(\s*[A-Za-z_][A-Za-z0-9_]*\s*\)|[A-Za-z_][A-Za-z0-9_]*)\s+(?:TYPE|LIKE)\s+/i
  // 内联表类型（组1=参数名保留，组2=类型表达式整个替换为 TYPE tt_<表>）：`<名> TYPE [STANDARD|SORTED|HASHED] TABLE OF <表>`
  const INLINE_RE =
    /((?:VALUE\s*\(\s*[A-Za-z_][A-Za-z0-9_]*\s*\))|[A-Za-z_][A-Za-z0-9_]*)\s+((?:TYPE|LIKE)\s+(?:(?:STANDARD|SORTED|HASHED)\s+)?TABLE\s+OF\s+[A-Za-z_][A-Za-z0-9_]*)\b/gi

  const rewriteLine = (line: string): { line: string; any: boolean } => {
    let any = false
    const res = line.replace(INLINE_RE, (m: string, namePart: string, typePart: string) => {
      const table = (typePart.match(/TABLE\s+OF\s+([A-Za-z_][A-Za-z0-9_]*)\b/i)?.[1] ?? "").toUpperCase()
      if (!table) return m
      any = true
      const ttName = `tt_${table.toLowerCase()}`
      if (!needed.has(table)) needed.set(table, ttName)
      return `${namePart} TYPE ${ttName}`
    })
    return { line: res, any }
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const t = raw.trimStart()
    if (FORM_RE.test(t)) {
      inForm = true
      interfaceActive = true
      // FORM 行可能内联整个接口：FORM name CHANGING ct TYPE STANDARD TABLE OF mard.
      const r = rewriteLine(raw)
      if (r.any) { out[i] = r.line; changed = true }
      if (/\.\s*$/.test(raw)) interfaceActive = false
      continue
    }
    if (ENDFORM_RE.test(t)) { inForm = false; interfaceActive = false; continue }
    if (!inForm) continue
    if (t === "" || t.startsWith("*") || t.startsWith("\"")) continue
    if (t === "." || DECL_RE.test(t)) { interfaceActive = false; continue }
    if (!interfaceActive) continue
    const isKw = KW_RE.test(t)
    const isParam = PARAM_RE.test(t)
    if (!isKw && !isParam) { interfaceActive = false; continue } // 函数体语句 → 接口结束
    const r = rewriteLine(raw)
    if (r.any) { out[i] = r.line; changed = true }
    if (/\.\s*$/.test(raw)) interfaceActive = false
  }
  if (!changed) return { source, changed: false, notes }

  // 补表类型定义：类型必须先于引用定义（同一编译单元按物理顺序编译）。
  // 若 include 里已有该类型（TYPES: tt_x TYPE ...），不重复补。
  const typeDefs: string[] = []
  for (const [table, ttName] of needed) {
    if (new RegExp(`\\b${ttName}\\s+TYPE\\b`, "i").test(source)) continue
    typeDefs.push(`TYPES: ${ttName} TYPE STANDARD TABLE OF ${table}.`)
    notes.push(`FORM 参数 ${table} 的内联表类型改为引用 ${ttName}（已定义表类型），内联表类型 SAP 会解析成多个参数报错`)
  }
  const final = typeDefs.length > 0 ? typeDefs.join("\n") + "\n" + out.join("\n") : out.join("\n")
  return { source: final, changed: true, notes }
}

/** 行内第一个不在 '...' 字符串里的 "（行内注释起点），没有则 -1 */
function findInlineCommentStart(line: string): number {
  let inStr = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === "'") inStr = !inStr
    else if (c === '"' && !inStr) return i
  }
  return -1
}

/**
 * Open SQL 里引用接口参数必须加 @ 前缀（ABAP 7.40+ 主机变量转义，真机实测：`INTO TABLE et_mard`
 * 报 "ET_MARD is invalid here (due to grammar)"；`WHERE matnr = iv_matnr` 报
 * "The variable IV_MATNR must be escaped using @"）。
 * 自动给 Open SQL 语句窗口内（SELECT/INSERT/UPDATE/MODIFY/DELETE/WITH/MERGE 起、行尾句点止）的接口参数加 @，
 * 避免 LLM 写裸参数名导致激活前语法错误。普通 ABAP（赋值/条件/方法调用/CLEAR 等）不受影响。
 * 结构化位置 `INTO [TABLE] <变量>` 对任意标识符也补 @（该位置必然是主机变量，含局部变量/行内声明）。
 */
export function escapeOpenSqlHostVars(
  source: string,
  groups: Partial<Record<FmKind, FmParam[]>>
): { source: string; changed: boolean; names: string[] } {
  const names = [...new Set(
    Object.values(groups)
      .flat()
      .map((p) => p.name)
      .filter((n) => !!n)
  )]
  if (names.length === 0) return { source, changed: false, names: [] }

  const lines = source.split(/\r?\n/)
  let inSql = false
  let changed = false
  const touched = new Set<string>()
  const out = lines.map((raw) => {
    const t = raw.trimStart()
    if (t.startsWith("*")) return raw // 整行注释：不属于 SQL，也不结束 SQL
    if (!inSql) {
      if (!SQL_START_RE.test(t)) return raw
      inSql = true
    }
    const endsStmt = /\.\s*$/.test(t)
    // 行内 " 注释之前的代码部分才做转义，注释里的参数名不动
    let code = raw
    let comment = ""
    const q = findInlineCommentStart(raw)
    if (q >= 0) {
      code = raw.slice(0, q)
      comment = raw.slice(q)
    }
    // Pass A：INTO [TABLE] <主机变量> 是结构化位置，对任意标识符补 @（已带 @ / @(…) / CORRESPONDING 除外）
    code = code.replace(
      /\bINTO\s+(TABLE\s+)?@?(?!CORRESPONDING)([A-Za-z][A-Za-z0-9_]*)\b/g,
      (m: string, table: string | undefined, host: string) => {
        const out = table ? `INTO TABLE @${host}` : `INTO @${host}`
        if (out !== m) {
          changed = true
          const up = host.toUpperCase()
          if (names.includes(up)) touched.add(up)
        }
        return out
      }
    )
    // Pass B：接口参数名裸出现 → 补 @（避开已带 @ 的、@(…) 行内声明、以及名字的一部分）
    for (const n of names) {
      const re = new RegExp(`@\\([^)]*\\)|(?<![@\\w])${n}(?!\\w)`, "gi")
      code = code.replace(re, (m: string) => {
        if (m.startsWith("@(")) return m // @(ls) 行内声明已转义
        touched.add(n)
        changed = true
        return `@${m}`
      })
    }
    if (endsStmt) inSql = false
    return code + comment
  })
  return { source: out.join("\n"), changed, names: [...touched] }
}
