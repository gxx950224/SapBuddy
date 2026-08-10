/**
 * SAP 语言键解析
 *
 * 背景（真机验证）：部分语言的 SAP 键不是可见单字符。越南语 VI 的真实键在 T002 中是
 * 单字节特殊字符（本系统 = U+C069，界面显示为乱码"쁩"）；而 'V' 是瑞典语(SV)，不是越南语。
 * 若把乱码字符当字面量嵌进 ABAP 源码，跨编码传输会被搞坏（ADT 400 / 写入字符 ≠ VI 键）。
 * 解法：工具接受友好写法（ISO 代码/中文名），生成 ABAP 时用变量从 T002 按 ISO 反查真实键，
 * 写入与自检都用该变量 —— 语言键全程在 SAP 内部解析，不经过可能被破坏的文本传输。
 */
export const abapStr = (s: string) => `'${s.replace(/'/g, "''")}'`

export type LangResolve =
  | { kind: "literal"; char: string } /** 标准可见单字符键（E/D/1/M…），可直接嵌入 */
  | { kind: "iso"; code: string } /** ISO 代码（VI/EN/ZH…），运行期从 T002 反查 */
  | { kind: "raw"; char: string } /** 用户给了单个字符（可能是特殊键乱码），运行期回 T002 校验存在 */

/** 常见语言 ISO/中文名 → 语言键；越南语等特殊键映射到 ISO 走运行期反查 */
const LANG_MAP: Record<string, LangResolve> = {
  EN: { kind: "literal", char: "E" },
  DE: { kind: "literal", char: "D" },
  FR: { kind: "literal", char: "F" },
  IT: { kind: "literal", char: "I" },
  JA: { kind: "literal", char: "J" },
  KO: { kind: "literal", char: "K" },
  ES: { kind: "literal", char: "S" },
  PT: { kind: "literal", char: "P" },
  RU: { kind: "literal", char: "R" },
  NL: { kind: "literal", char: "N" },
  PL: { kind: "literal", char: "L" },
  ZH: { kind: "literal", char: "1" },
  VI: { kind: "iso", code: "VI" },
  "中文": { kind: "literal", char: "1" },
  "中文简体": { kind: "literal", char: "1" },
  "简体": { kind: "literal", char: "1" },
  "繁体": { kind: "literal", char: "M" },
  "中文繁体": { kind: "literal", char: "M" },
  "英文": { kind: "literal", char: "E" },
  "英语": { kind: "literal", char: "E" },
  "德文": { kind: "literal", char: "D" },
  "德语": { kind: "literal", char: "D" },
  "越南": { kind: "iso", code: "VI" },
  "越南语": { kind: "iso", code: "VI" },
  "VIETNAMESE": { kind: "iso", code: "VI" },
}

/** 把用户/LLM 给的语言写法解析为生成 ABAP 用的解析指令；无法识别返回 null */
export function resolveLanguageSpec(input: string | undefined): LangResolve | null {
  const s = (input ?? "").trim()
  if (!s) return null
  const upper = s.toUpperCase()
  // 单个可见 ASCII 字符（标准语言键 E/D/1/M/V…）→ 直接字面量
  if (/^[A-Z0-9]$/.test(upper)) return { kind: "literal", char: upper }
  // 中文名 / ISO 别名表
  const mapped = LANG_MAP[upper] ?? LANG_MAP[s]
  if (mapped) return mapped
  // 2 位纯字母 → 视为 ISO 代码，运行期从 T002 反查
  if (/^[A-Z]{2}$/.test(upper)) return { kind: "iso", code: upper }
  // 其它单字符（可能是手抄的特殊键乱码）→ 原样，运行期回 T002 校验存在性
  if (s.length === 1) return { kind: "raw", char: s }
  return null
}

/** 生成 ABAP：把语言键解析结果赋值给变量 lv_var（类型 spras）；反查失败输出 LANG-NOTFOUND 并 RETURN */
export function emitLangResolution(varName: string, spec: LangResolve): string[] {
  const L: string[] = []
  if (spec.kind === "literal") {
    L.push(`    ${varName} = ${abapStr(spec.char)}.`)
  } else if (spec.kind === "iso") {
    L.push(`    SELECT SINGLE spras FROM t002 INTO @${varName} WHERE laiso = ${abapStr(spec.code)}.`)
    L.push(`    IF sy-subrc <> 0. out->write( 'LANG-NOTFOUND:${spec.code}' ). RETURN. ENDIF.`)
  } else {
    L.push(`    ${varName} = ${abapStr(spec.char)}.`)
    L.push(`    SELECT SINGLE spras FROM t002 INTO @${varName} WHERE spras = @${varName}.`)
    L.push(`    IF sy-subrc <> 0. out->write( 'LANG-NOTFOUND:${varName}' ). RETURN. ENDIF.`)
  }
  return L
}

/** 描述里用的语言键说明（两个翻译工具共用） */
export const LANG_KEY_HELP =
  "语言键可写标准键（E=英文 D=德文 1=中文简体 M=繁体 J=日文 K=韩文 等）或 ISO/中文名（EN/DE/ZH/VI/ENGLISH/英文/德文/中文/越南/越南语）。" +
  "注意：V 是瑞典语(SV)不是越南语；越南语请写 VI 或「越南」，工具会从 T002 反查真实语言键自动写入。"
