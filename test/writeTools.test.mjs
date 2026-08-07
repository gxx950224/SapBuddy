/**
 * 写工具硬化单测（覆盖 create_object_programmatically 的强制校验）
 * 只测"连 SAP 之前"就拦截的规则：对象类型 / 包名 / 描述
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const { createObjectTool, parseIncludeNames, verifySavedContent } = require("../dist/sap-tools/tools/writeTools.js")
const { normalizeFormIncludeSource } = require("../dist/sap-tools/tools/fmoduleInterface.js")
const { normalizeFunctionGroupIncludeUri } = require("../dist/sap-tools/tools/shared.js")

const base = { name: "ZTEST001", description: "测试对象", packageName: "ZPKG", connectionId: "none" }

test("create_object_programmatically：PROG/I（Include）放行，进入连接阶段", async () => {
  const out = await createObjectTool.execute({ ...base, objectType: "PROG/I" })
  assert.ok(!out.includes("必须用 PROG/P"), `Include 创建不应被报表规则拦截，实际: ${out.slice(0, 200)}`)
})

test("create_object_programmatically：FUGR/F（函数组）放行，不再被拦截", async () => {
  const out = await createObjectTool.execute({ ...base, objectType: "FUGR/F", parentName: "ZFG" })
  assert.ok(!out.includes("FUGR/FF"), `FUGR/F 创建函数组不应被拦截，实际: ${out.slice(0, 160)}`)
})

test("create_object_programmatically：FUGR/I（函数组 include）放行，进入连接阶段", async () => {
  const out = await createObjectTool.execute({ ...base, objectType: "FUGR/I", name: "LZFG01", parentName: "ZFG" })
  assert.ok(!out.includes("parentName") && !out.includes("FUGR/FF"),
    `FUGR/I 带 parentName 不应被拦截，实际: ${out.slice(0, 160)}`)
})

test("create_object_programmatically：FUGR/I 缺 parentName 被拦截", async () => {
  const out = await createObjectTool.execute({ ...base, objectType: "FUGR/I", name: "LZFG01" })
  assert.ok(out.includes("parentName"), `应提示提供 parentName，实际: ${out.slice(0, 160)}`)
})

test("create_object_programmatically：FUGR/FF 缺 parentName 被拦截", async () => {
  const out = await createObjectTool.execute({ ...base, objectType: "FUGR/FF" })
  assert.ok(out.includes("parentName"), `应提示提供 parentName，实际: ${out.slice(0, 160)}`)
})

test("create_object_programmatically：$TMP 放行（不再被拦截，进入连接阶段）", async () => {
  const out = await createObjectTool.execute({ ...base, objectType: "CLAS/OC", packageName: "$TMP" })
  assert.ok(!out.includes("禁止 $TMP") && !out.includes("必须提供正式开发包"),
    `$TMP 不应被包名规则拦截，实际: ${out.slice(0, 200)}`)
})

test("create_object_programmatically：缺包名被拦截，并提示向用户确认写哪个包", async () => {
  const out = await createObjectTool.execute({ ...base, objectType: "CLAS/OC", packageName: "  " })
  assert.ok(out.includes("哪个包"), `应提示确认写哪个包（正式包或 $TMP），实际: ${out.slice(0, 200)}`)
})

test("create_object_programmatically：缺描述仍被拦截（既有规则）", async () => {
  const out = await createObjectTool.execute({ ...base, objectType: "CLAS/OC", packageName: "ZPKG", description: "  " })
  assert.ok(out.includes("描述"), `应提示缺少描述，实际: ${out.slice(0, 160)}`)
})

// ── DTEL 缺域硬拦截（回归：曾创建出无法激活的空壳 DTEL）─────────────────────────
test("create_object_programmatically：DTEL/DE 缺 domainName 被拦截", async () => {
  const out = await createObjectTool.execute({ ...base, objectType: "DTEL/DE" })
  assert.ok(out.includes("domainName"), `应提示必须提供 domainName，实际: ${out.slice(0, 200)}`)
})

test("create_object_programmatically：DTEL/DE 带 domainName 通过域校验（进入连接阶段）", async () => {
  const out = await createObjectTool.execute({ ...base, objectType: "DTEL/DE", domainName: "CHAR100" })
  assert.ok(!out.includes("必须提供 domainName"), `带域不应被域规则拦截，实际: ${out.slice(0, 200)}`)
})

// ── normalizeFunctionGroupIncludeUri：写路径函数组 include URI 归一化 ────────
test("normalizeFunctionGroupIncludeUri：普通 INCLUDE 不改写（读直通）", async () => {
  assert.equal(await normalizeFunctionGroupIncludeUri("none", "/sap/bc/adt/programs/includes/zabc_inc"), undefined)
  assert.equal(await normalizeFunctionGroupIncludeUri("none", "/sap/bc/adt/programs/includes/zabc_inc/source/main"), undefined)
})

test("normalizeFunctionGroupIncludeUri：已是函数组通道 URI 不改写", async () => {
  assert.equal(
    await normalizeFunctionGroupIncludeUri("none", "/sap/bc/adt/functions/groups/zbcg014/includes/lzbcg014f01"),
    undefined
  )
})

test("normalizeFunctionGroupIncludeUri：函数组形态需连接验证（无连接时报错而非静默猜错）", async () => {
  await assert.rejects(
    () => normalizeFunctionGroupIncludeUri("none", "/sap/bc/adt/programs/includes/lzbcg014f01"),
    /未找到|连接|none|ABAP/i
  )
})

// ── parseIncludeNames：批量激活枚举 INCLUDE（回归：行尾注释不能漏匹配）──────────
const MAIN_SRC = [
  `*&---------------------------------------------------------------------*`,
  `REPORT ZREPORT.`,
  ``,
  `INCLUDE ZREPORT_TOP.   "全局数据与选择屏幕`,
  `INCLUDE ZREPORT_CLS.   "本地类定义`,
  `INCLUDE ZREPORT_IMP.`,
  `* 注释里提到 INCLUDE ZREPORT_FAKE. 不应被当成语句`,
  `DATA(lv_ok) = abap_true.`,
].join("\r\n")

test("parseIncludeNames：识别带行尾注释的 INCLUDE 语句", () => {
  const names = parseIncludeNames(MAIN_SRC)
  assert.deepEqual(names, ["ZREPORT_TOP", "ZREPORT_CLS", "ZREPORT_IMP"])
})

test("parseIncludeNames：注释行与普通语句不误报", () => {
  const src = [
    `* INCLUDE ZFAKE1.`,
    `DATA gv_x TYPE i.`,
    `WRITE 'INCLUDE ZFAKE2.'.`,
    ``,
  ].join("\n")
  assert.deepEqual(parseIncludeNames(src), [])
})

test("parseIncludeNames：空源码返回空", () => {
  assert.deepEqual(parseIncludeNames(""), [])
  assert.deepEqual(parseIncludeNames("  \n  \n"), [])
})

// ── verifySavedContent：写入自检（读回会被服务器规范化，避免误判失败）────────
test("自检：精确包含 → ok", () => {
  const newC = "WRITE 'hello'.\n"
  const r = verifySavedContent(newC, "", newC)
  assert.deepEqual(r, { ok: true })
})

test("自检：结构 DSL 被规范化（注解形式/大小写/空行）→ 关键内容核对通过，不再误报", () => {
  const oldContent = `@EndUserText.label : 'test'\ndefine structure zaig_test02_s {\n}\n`
  const newContent = `@EndUserText.label : '销售订单库存数量结构'
@AbapCatalog.enhancementCategory : [#NOT_EXTENSIBLE]
define structure ZAIG_TEST02_S {
  VBELN : vbeln_va;
  STOCK : menge_d;
}
`
  const readBack = `@EndUserText.label : '销售订单库存数量结构'
@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE
define structure zaig_test02_s {
  vbeln : vbeln_va;
  stock : menge_d;

}
`
  const r = verifySavedContent(newContent, oldContent, readBack)
  assert.equal(r.ok, true, "服务器规范化读回不应误报失败")
  assert.equal(r.normalized, true)
})

test("自检：新增字段已落库（读回含新字段）→ 通过", () => {
  const oldContent = `define structure zaig_test02_s {
  vbeln : vbeln_va;
  stock : menge_d;
}
`
  const newContent = `define structure zaig_test02_s {
  vbeln : vbeln_va;
  stock : menge_d;
  unit  : meins;
}
`
  const readBack = `define structure zaig_test02_s {
  vbeln : vbeln_va;
  stock : menge_d;
  unit  : meins;

}
`
  const r = verifySavedContent(newContent, oldContent, readBack)
  assert.equal(r.ok, true) // 纯空行差异走空白归一化层
})

test("自检：写入失败（读回仍是旧内容，新增标识符缺失）→ 判定失败", () => {
  const oldContent = `define structure zaig_test02_s {
  vbeln : vbeln_va;
  stock : menge_d;
}
`
  const newContent = `define structure zaig_test02_s {
  vbeln : vbeln_va;
  stock : menge_d;
  unit  : meins;
}
`
  const readBack = oldContent // 服务器没保存新内容
  const r = verifySavedContent(newContent, oldContent, readBack)
  assert.equal(r.ok, false)
})

test("自检：纯空白差异（多空行/行尾空格）→ 空白归一化层通过", () => {
  const newC = "define structure ztest_s {\n  a : b;\n}\n"
  const readBack = "define structure ztest_s {\n  a : b;\n\n}\n   \n"
  const r = verifySavedContent(newC, "", readBack)
  assert.equal(r.ok, true)
})

// ── normalizeFormIncludeSource：FORM 参数内联表类型自动修正 ────────────────
// 真机坑：FORM 参数写 `TYPE STANDARD TABLE OF MARD` 被 SAP 解析成 6 个形式参数，
// PERFORM 报 "Different number of parameters (formal: 6, actual: 4)"。
test("FORM 参数内联表类型 → 改写为引用 tt_<表> 并补类型定义", () => {
  const src = [
    `FORM get_mard_data CHANGING CT_MARD TYPE STANDARD TABLE OF MARD.`,
    `  SELECT * FROM mard INTO TABLE @ct_mard.`,
    `ENDFORM.`,
  ].join("\n")
  const r = normalizeFormIncludeSource(src)
  assert.equal(r.changed, true)
  assert.ok(r.source.startsWith("TYPES: tt_mard TYPE STANDARD TABLE OF MARD."), `应补类型定义，实际:\n${r.source}`)
  assert.ok(r.source.includes("CT_MARD TYPE tt_mard"), `应改写为 TYPE tt_mard，实际:\n${r.source}`)
  assert.ok(!r.source.includes("CT_MARD TYPE STANDARD TABLE OF MARD"), `FORM 参数内联表类型应被移除，实际:\n${r.source}`)
})

test("FORM 参数 LIKE TABLE OF 变体也改写", () => {
  const src = [
    `FORM get_data CHANGING ct LIKE TABLE OF mkpf.`,
    `  SELECT * FROM mkpf INTO TABLE @ct.`,
    `ENDFORM.`,
  ].join("\n")
  const r = normalizeFormIncludeSource(src)
  assert.equal(r.changed, true)
  assert.ok(r.source.includes("TYPES: tt_mkpf TYPE STANDARD TABLE OF MKPF."), `应补类型定义，实际:\n${r.source}`)
  assert.ok(r.source.includes("ct TYPE tt_mkpf"), `应改写为 TYPE tt_mkpf，实际:\n${r.source}`)
})

test("FORM 参数 VALUE() 包裹 + 行尾句点保留", () => {
  const src = `FORM f CHANGING VALUE(ct) TYPE STANDARD TABLE OF mard.`
  const r = normalizeFormIncludeSource(src)
  assert.equal(r.changed, true)
  assert.ok(r.source.includes("VALUE(ct) TYPE tt_mard."), `应保留 VALUE() 与句点，实际:\n${r.source}`)
})

test("同一表被多个 FORM 引用 → 只补一个类型定义", () => {
  const src = [
    `FORM a CHANGING ct_mard TYPE STANDARD TABLE OF mard.`,
    `  ENDFORM.`,
    `FORM b USING it_mard TYPE STANDARD TABLE OF MARD.`,
    `  ENDFORM.`,
  ].join("\n")
  const r = normalizeFormIncludeSource(src)
  const defs = (r.source.match(/TYPES: tt_mard/g) || []).length
  assert.equal(defs, 1, `类型定义应只出现一次，实际:\n${r.source}`)
})

test("类型已定义 → 不再重复补，只改写引用", () => {
  const src = [
    `TYPES: tt_mard TYPE STANDARD TABLE OF MARD.`,
    `FORM a CHANGING ct_mard TYPE STANDARD TABLE OF mard.`,
    `  ENDFORM.`,
  ].join("\n")
  const r = normalizeFormIncludeSource(src)
  const defs = (r.source.match(/TYPES: tt_mard/g) || []).length
  assert.equal(defs, 1, `已有类型不应重复补，实际:\n${r.source}`)
  assert.ok(r.source.includes("ct_mard TYPE tt_mard"))
})

test("函数体里的 DATA 内联表类型（合法）不被改写", () => {
  const src = [
    `FORM get_data.`,
    `  DATA lt_mard TYPE STANDARD TABLE OF mard.`,
    `  SELECT * FROM mard INTO TABLE @lt_mard.`,
    `ENDFORM.`,
  ].join("\n")
  const r = normalizeFormIncludeSource(src)
  assert.equal(r.changed, false, "合法 DATA 声明不应被改写")
  assert.equal(r.source, src)
})

test("无 FORM 的源码不改写", () => {
  const src = `* 纯注释\nWRITE 'x'.`
  const r = normalizeFormIncludeSource(src)
  assert.equal(r.changed, false)
  assert.equal(r.source, src)
})

test("FORM 参数引用已定义类型（非内联）不改写", () => {
  const src = `FORM a CHANGING ct_mard TYPE tt_mard.`
  const r = normalizeFormIncludeSource(src)
  assert.equal(r.changed, false)
  assert.equal(r.source, src)
})
