/**
 * 语言键解析模块单测
 * 覆盖：标准键/ISO/中文名解析、越南语 VI 走 T002 反查、V 不被误判为越南语、ABAP 解析代码生成
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const { resolveLanguageSpec, emitLangResolution } = require("../dist/sap-tools/tools/languageKeys.js")

test("标准键 → 字面量", () => {
  assert.deepEqual(resolveLanguageSpec("E"), { kind: "literal", char: "E" })
  assert.deepEqual(resolveLanguageSpec("1"), { kind: "literal", char: "1" })
  assert.deepEqual(resolveLanguageSpec("M"), { kind: "literal", char: "M" })
  assert.deepEqual(resolveLanguageSpec("d"), { kind: "literal", char: "D" })
})

test("ISO 代码 → 常见语言直接映射标准键", () => {
  assert.deepEqual(resolveLanguageSpec("EN"), { kind: "literal", char: "E" })
  assert.deepEqual(resolveLanguageSpec("DE"), { kind: "literal", char: "D" })
  assert.deepEqual(resolveLanguageSpec("ZH"), { kind: "literal", char: "1" })
  assert.deepEqual(resolveLanguageSpec("JA"), { kind: "literal", char: "J" })
})

test("中文名 → 标准键", () => {
  assert.deepEqual(resolveLanguageSpec("英文"), { kind: "literal", char: "E" })
  assert.deepEqual(resolveLanguageSpec("德文"), { kind: "literal", char: "D" })
  assert.deepEqual(resolveLanguageSpec("中文"), { kind: "literal", char: "1" })
})

test("越南语：VI/越南/越南语 → ISO 反查（关键回归）", () => {
  assert.deepEqual(resolveLanguageSpec("VI"), { kind: "iso", code: "VI" })
  assert.deepEqual(resolveLanguageSpec("vi"), { kind: "iso", code: "VI" })
  assert.deepEqual(resolveLanguageSpec("越南"), { kind: "iso", code: "VI" })
  assert.deepEqual(resolveLanguageSpec("越南语"), { kind: "iso", code: "VI" })
})

test("V 是瑞典语不是越南语：只能当普通单字符", () => {
  assert.deepEqual(resolveLanguageSpec("V"), { kind: "literal", char: "V" })
})

test("未知 ISO 代码 → ISO 反查（运行期从 T002 找）", () => {
  assert.deepEqual(resolveLanguageSpec("XX"), { kind: "iso", code: "XX" })
})

test("无法识别 → null", () => {
  assert.equal(resolveLanguageSpec(""), null)
  assert.equal(resolveLanguageSpec(undefined), null)
  assert.equal(resolveLanguageSpec("   "), null)
  assert.equal(resolveLanguageSpec("工具"), null)
})

test("emitLangResolution：字面量直接赋值", () => {
  const lines = emitLangResolution("lv_tgt", { kind: "literal", char: "E" })
  assert.deepEqual(lines, ["    lv_tgt = 'E'."])
})

test("emitLangResolution：ISO 从 T002 反查，失败即中止", () => {
  const lines = emitLangResolution("lv_tgt", { kind: "iso", code: "VI" })
  assert.ok(lines.some((l) => l.includes("SELECT SINGLE spras FROM t002 INTO @lv_tgt WHERE laiso = 'VI'")), "应查 T002")
  assert.ok(lines.some((l) => l.includes("LANG-NOTFOUND:VI")), "查不到应输出 NOTFOUND")
  assert.ok(lines.some((l) => l.includes("RETURN.")), "查不到应 RETURN 中止")
})

test("emitLangResolution：单字符 raw 回 T002 校验存在性", () => {
  const lines = emitLangResolution("lv_tgt", { kind: "raw", char: "x" })
  assert.ok(lines.some((l) => l.includes("lv_tgt = 'x'.")), "应赋值")
  assert.ok(lines.some((l) => l.includes("WHERE spras = @lv_tgt")), "应回 T002 校验")
})
