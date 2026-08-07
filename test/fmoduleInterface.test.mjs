/**
 * 函数模块接口强控单测：参数段解析（parseFunctionModuleParams）+ 参数写法规范化（normalizeFunctionModuleParams）
 * 只测纯逻辑，不连 SAP。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const { parseFunctionModuleParams, normalizeFunctionModuleParams, isFmoduleSourceChannel, detectCommentParamBlock, escapeOpenSqlHostVars } = require("../dist/sap-tools/tools/fmoduleInterface.js")

// ── parseFunctionModuleParams ───────────────────────────────────────────────

test("解析：FUNCTION 无句点 + IMPORTING/EXPORTING + 独立句点收束", () => {
  const src = `FUNCTION ZFM_TEST
  IMPORTING
    iv_scenario TYPE string
    iv_qty TYPE int4 OPTIONAL DEFAULT 10
  EXPORTING
    ev_report TYPE string
  .
  WRITE iv_scenario.
ENDFUNCTION.`
  const r = parseFunctionModuleParams(src)
  assert.equal(r.matched, true)
  assert.equal(r.moduleName, "ZFM_TEST")
  assert.deepEqual(r.presentKinds, ["importing", "exporting"])
  assert.equal(r.groups.importing?.length, 2)
  assert.equal(r.groups.importing?.[0].name, "IV_SCENARIO")
  assert.equal(r.groups.importing?.[0].type, "STRING")
  assert.equal(r.groups.importing?.[0].typeKind, "TYPE")
  assert.equal(r.groups.importing?.[1].optional, true)
  assert.equal(r.groups.importing?.[1].defaultValue, "10")
  assert.equal(r.groups.exporting?.[0].type, "STRING")
  assert.equal(r.cleanSource, "FUNCTION ZFM_TEST.\n  WRITE iv_scenario.\nENDFUNCTION.")
})

test("解析：FUNCTION 带句点 + 独立参数段（第二种错误写法）", () => {
  const src = `FUNCTION ZFM_RUN_REPORT_JSON.
  IMPORTING
    iv_scenario TYPE string
  EXPORTING
    ev_report TYPE string.
  PERFORM main.
ENDFUNCTION.`
  const r = parseFunctionModuleParams(src)
  assert.equal(r.matched, true)
  assert.equal(r.groups.importing?.[0].name, "IV_SCENARIO")
  assert.equal(r.groups.exporting?.[0].name, "EV_REPORT")
  assert.ok(r.cleanSource.startsWith("FUNCTION ZFM_RUN_REPORT_JSON."))
  assert.ok(r.cleanSource.includes("PERFORM main."))
  assert.ok(!r.cleanSource.includes("IMPORTING"))
})

test("解析：VALUE() 包裹 + TABLES + EXCEPTIONS", () => {
  const src = `FUNCTION ZFM_V
  IMPORTING
    VALUE(iv_id) TYPE zid
  TABLES
    tt_rows TYPE TABLE OF string
  EXCEPTIONS
    not_found
    others.
  READ TABLE tt_rows INDEX 1.
ENDFUNCTION.`
  const r = parseFunctionModuleParams(src)
  assert.equal(r.matched, true)
  assert.equal(r.groups.importing?.[0].name, "IV_ID")
  assert.equal(r.groups.tables?.[0].name, "TT_ROWS")
  assert.equal(r.groups.tables?.[0].type, "TABLE OF STRING")
  assert.deepEqual(r.groups.exceptions?.map((p) => p.name), ["NOT_FOUND", "OTHERS"])
  assert.ok(!r.cleanSource.includes("VALUE(iv_id)"))
})

test("解析：类方法（METHOD IMPORTING）不是函数模块参数段，不拦截", () => {
  const src = `METHOD main IMPORTING iv_x TYPE string EXPORTING ev_y TYPE string.
  ev_y = iv_x.
ENDMETHOD.`
  const r = parseFunctionModuleParams(src)
  assert.equal(r.matched, false)
})

test("解析：函数模块主体无参数段，不拦截", () => {
  const src = `FUNCTION ZFM_OK.
  DATA lv_x TYPE string.
  lv_x = 'hi'.
ENDFUNCTION.`
  const r = parseFunctionModuleParams(src)
  assert.equal(r.matched, false)
  assert.equal(r.cleanSource, src)
})

test("解析：注释里的 IMPORTING 不触发", () => {
  const src = `FUNCTION ZFM_OK.
  * IMPORTING 注释
  WRITE 'hi'.
ENDFUNCTION.`
  const r = parseFunctionModuleParams(src)
  assert.equal(r.matched, false)
})

// ── normalizeFunctionModuleParams ───────────────────────────────────────────

test("规范化：EXPORTING 段 DEFAULT 移除（DEFAULT 只允许 IMPORTING/CHANGING）", () => {
  const src = `FUNCTION ZFM_TEST
  IMPORTING
    IV_A TYPE STRING
  EXPORTING
    EV_D TYPE INT4 DEFAULT 10
    EV_C TYPE STRING
  .
  EV_C = IV_A.
ENDFUNCTION.`
  const r = normalizeFunctionModuleParams(src)
  assert.equal(r.matched, true)
  assert.equal(r.errors.length, 0)
  assert.ok(r.notes.some((n) => n.includes("EV_D")))
  assert.ok(r.normalized.includes("EV_D TYPE INT4"))
  assert.ok(!r.normalized.includes("EV_D TYPE INT4 DEFAULT"))
})

test("规范化：DEFAULT 与 OPTIONAL 冲突 → 保留 DEFAULT 移除 OPTIONAL", () => {
  const src = `FUNCTION ZFM_TEST
  IMPORTING
    IV_QTY TYPE INT4 OPTIONAL DEFAULT 10
  EXPORTING
    EV_C TYPE STRING
  .
  EV_C = 'x'.
ENDFUNCTION.`
  const r = normalizeFunctionModuleParams(src)
  assert.equal(r.matched, true)
  assert.equal(r.errors.length, 0)
  assert.ok(r.normalized.includes("IV_QTY TYPE INT4 DEFAULT 10"))
  assert.ok(!r.normalized.includes("OPTIONAL"))
})

test("规范化：TABLES 用 LIKE（返回表经典做法，真机验证可激活）不误报", () => {
  const src = `FUNCTION ZAIG_TEST01
  IMPORTING
    IV_WERKS TYPE WERKS
  TABLES
    ET_MARC LIKE MARC.
  SELECT * FROM MARC WHERE WERKS = @IV_WERKS INTO TABLE @ET_MARC.
ENDFUNCTION.`
  const r = normalizeFunctionModuleParams(src)
  assert.equal(r.matched, true)
  assert.equal(r.errors.length, 0)
  assert.equal(r.normalized, src)
})

test("规范化：TABLES 内联 TYPE ... TABLE OF ... 报错（无法自动修正）", () => {
  const src = `FUNCTION ZFM_TEST
  IMPORTING
    IV_A TYPE STRING
  EXPORTING
    EV_C TYPE STRING
  TABLES
    TT_ROWS TYPE TABLE OF STRING
  .
  EV_C = IV_A.
ENDFUNCTION.`
  const r = normalizeFunctionModuleParams(src)
  assert.equal(r.matched, true)
  assert.equal(r.errors.length, 1)
  assert.ok(r.errors[0].includes("TT_ROWS"))
  assert.equal(r.normalized, src) // 报错时源码不改
})

test("规范化：EXPORTING 内联表类型报错（真机实测 Parameter OF declares no type），提示用 LIKE 或已定义类型", () => {
  const src = `FUNCTION ZFM_TEST
  IMPORTING
    IV_WERKS TYPE WERKS
  EXPORTING
    ET_MARC TYPE STANDARD TABLE OF MARC
  .
  SELECT * FROM marc INTO TABLE et_marc.
ENDFUNCTION.`
  const r = normalizeFunctionModuleParams(src)
  assert.equal(r.matched, true)
  assert.equal(r.errors.length, 1)
  assert.ok(r.errors[0].includes("ET_MARC"))
  assert.ok(r.errors[0].includes("LIKE MARC"))
  assert.equal(r.normalized, src) // 报错时源码不改
})

test("规范化：IMPORTING 内联表类型同样报错（不只 TABLES/EXPORTING）", () => {
  const src = `FUNCTION ZFM_TEST
  IMPORTING
    IT_MAT TYPE TABLE OF MATNR
  EXPORTING
    EV_C TYPE STRING
  .
  EV_C = 'x'.
ENDFUNCTION.`
  const r = normalizeFunctionModuleParams(src)
  assert.equal(r.matched, true)
  assert.equal(r.errors.length, 1)
  assert.ok(r.errors[0].includes("IT_MAT"))
})

test("规范化：参数段漏收束句点，函数体语句紧跟其后 → 自动补独立 .", () => {
  const src = `FUNCTION ZFM_TEST
  IMPORTING
    IV_A TYPE STRING
  EXPORTING
    EV_C TYPE STRING
  EV_C = IV_A.
ENDFUNCTION.`
  const r = normalizeFunctionModuleParams(src)
  assert.equal(r.matched, true)
  assert.equal(r.errors.length, 0)
  assert.ok(r.notes.some((n) => n.includes("收束句点")))
  assert.ok(r.normalized.includes("\n  .\n  EV_C = IV_A."))
})

test("规范化：参数段合法写法无任何修正，normalized 等于原源码", () => {
  const src = `FUNCTION ZFM_TEST
  IMPORTING
    IV_A TYPE STRING
    IV_B TYPE INT4 OPTIONAL
  EXPORTING
    EV_C TYPE STRING
  CHANGING
    CV_D TYPE INT4 DEFAULT 10
  TABLES
    TT_E TYPE STRING_TABLE
  EXCEPTIONS
    NOT_FOUND
  .
  EV_C = IV_A.
ENDFUNCTION.`
  const r = normalizeFunctionModuleParams(src)
  assert.equal(r.matched, true)
  assert.equal(r.errors.length, 0)
  assert.equal(r.notes.length, 0)
  assert.equal(r.normalized, src)
})

test("规范化：VALUE 包裹 + 无冲突时保留原样", () => {
  const src = `FUNCTION ZFM_TEST
  IMPORTING
    VALUE(IV_ID) TYPE ZID
  EXPORTING
    VALUE(EV_REP) TYPE STRING.
  EV_REP = IV_ID.
ENDFUNCTION.`
  const r = normalizeFunctionModuleParams(src)
  assert.equal(r.matched, true)
  assert.equal(r.errors.length, 0)
  assert.equal(r.normalized, src)
})

test("规范化：无参数段不拦截", () => {
  const src = `FUNCTION ZFM_OK.
  DATA lv_x TYPE string.
  lv_x = 'hi'.
ENDFUNCTION.`
  const r = normalizeFunctionModuleParams(src)
  assert.equal(r.matched, false)
  assert.equal(r.normalized, src)
})

test("规范化：FUNCTION 带句点（FUNCTION ZFM_TEST.）→ 移除行尾句点（防服务器残留模板头导致参数区提前结束）", () => {
  const src = `FUNCTION ZFM_TEST.
  IMPORTING
    IV_A TYPE STRING
  EXPORTING
    EV_C TYPE STRING
  .
  EV_C = IV_A.
ENDFUNCTION.`
  const r = normalizeFunctionModuleParams(src)
  assert.equal(r.matched, true)
  assert.equal(r.errors.length, 0)
  assert.ok(r.notes.some((n) => n.includes("句点")))
  assert.ok(r.normalized.startsWith("FUNCTION ZFM_TEST\n"), `期望 FUNCTION 行不带句点，实际: ${JSON.stringify(r.normalized.split("\n")[0])}`)
  assert.ok(!r.normalized.includes("FUNCTION ZFM_TEST.\n"))
})

test("规范化：类方法不拦截", () => {
  const src = `METHOD main IMPORTING iv_x TYPE string EXPORTING ev_y TYPE string.
  ev_y = iv_x.
ENDMETHOD.`
  const r = normalizeFunctionModuleParams(src)
  assert.equal(r.matched, false)
})

// ── detectCommentParamBlock：*" 注释形式写参数（错误写法）检测 ──────────────

test("注释检测：*\" 注释行写 IMPORTING 参数段 → 判定为真", () => {
  const src = `FUNCTION ZAIG_TEST01.
*"*"本地接口：
*"  IMPORTING
*"     VALUE(IV_WERKS) TYPE  WERKS
*"----------------------------------------------------------------------
ENDFUNCTION.`
  assert.equal(detectCommentParamBlock(src), true)
})

test("注释检测：*\" VALUE(...) 行 → 判定为真", () => {
  const src = `FUNCTION ZAIG_TEST01.
*"     VALUE(IV_WERKS) TYPE  WERKS
ENDFUNCTION.`
  assert.equal(detectCommentParamBlock(src), true)
})

test("注释检测：真实声明（无 *\"）→ 判定为假", () => {
  const src = `FUNCTION ZAIG_TEST01
  IMPORTING
    VALUE(IV_WERKS) TYPE WERKS_D
  TABLES
    ET_MARC LIKE MARC.
ENDFUNCTION.`
  assert.equal(detectCommentParamBlock(src), false)
})

test("注释检测：模板注释（空格+引号，非 *\"）→ 判定为假", () => {
  const src = `FUNCTION ZAIG_TEST01
 " You can use the template 'functionModuleParameter' to add here the signature!
.
ENDFUNCTION.`
  assert.equal(detectCommentParamBlock(src), false)
})

// ── isFmoduleSourceChannel：函数模块自身源码通道判定 ────────────────────────

test("通道：函数模块自身 /source/main 判定为真", () => {
  assert.equal(isFmoduleSourceChannel("/sap/bc/adt/functions/groups/zaigtest01/fmodules/zaig_test01/source/main"), true)
  assert.equal(isFmoduleSourceChannel("/sap/bc/adt/functions/groups/ZFG/fmodules/zfm_x/source/main"), true)
})

test("通道：函数组 include / 普通对象 URI 判定为假（写参数段会被拦）", () => {
  assert.equal(isFmoduleSourceChannel("/sap/bc/adt/functions/groups/zaigtest01/includes/lzaigtest01u01/source/main"), false)
  assert.equal(isFmoduleSourceChannel("/sap/bc/adt/programs/includes/lzaigtest01u01/source/main"), false)
  assert.equal(isFmoduleSourceChannel("/sap/bc/adt/functions/groups/zaigtest01/fmodules/zaig_test01"), false)
  assert.equal(isFmoduleSourceChannel("/sap/bc/adt/reports/programs/zaig_test01/source/main"), false)
  assert.equal(isFmoduleSourceChannel(""), false)
})

// ── escapeOpenSqlHostVars：Open SQL 内接口参数自动加 @ 转义 ────────────────
const mardGroups = {
  importing: [
    { name: "IV_WERKS" },
    { name: "IV_MATNR" },
    { name: "IV_LGORT" },
  ],
  tables: [{ name: "ET_MARD" }],
}

test("SQL 转义：chat-1786031592390 失败源码（INTO TABLE et_mard + WHERE = iv_*）全部加 @，普通 ABAP 不动", () => {
  const src = `FUNCTION zaig_test01
  IMPORTING
    VALUE(iv_werks) TYPE werks_d
    VALUE(iv_matnr) TYPE matnr
    VALUE(iv_lgort) TYPE lgort_d
  TABLES
    et_mard LIKE mard.

SELECT *
  FROM mard
  WHERE matnr = iv_matnr
    AND werks = iv_werks
    AND lgort = iv_lgort
  INTO TABLE et_mard.

IF sy-subrc <> 0.
  CLEAR et_mard.
ENDIF.

ENDFUNCTION.`
  const r = escapeOpenSqlHostVars(src, mardGroups)
  assert.equal(r.changed, true)
  assert.ok(r.source.includes("WHERE matnr = @iv_matnr"), `WHERE 值未转义:\n${r.source}`)
  assert.ok(r.source.includes("AND werks = @iv_werks"))
  assert.ok(r.source.includes("AND lgort = @iv_lgort"))
  assert.ok(r.source.includes("INTO TABLE @et_mard"))
  assert.ok(r.source.includes("CLEAR et_mard."), `CLEAR 是普通 ABAP 不应加 @:\n${r.source}`)
  assert.ok(r.source.includes("SELECT *"), "SELECT 字段列表里的列名不能动")
  assert.ok(r.source.includes("FROM mard"), "FROM 表名不能动")
  assert.deepEqual([...r.names].sort(), ["ET_MARD", "IV_LGORT", "IV_MATNR", "IV_WERKS"].sort())
})

test("SQL 转义：已全部转义的源码幂等（changed=false，内容不变）", () => {
  const src = `FUNCTION zaig_test01
  IMPORTING
    VALUE(iv_werks) TYPE werks_d
  TABLES
    et_mard LIKE mard.

SELECT *
  FROM mard
  WHERE werks = @iv_werks
  INTO TABLE @et_mard.

ENDFUNCTION.`
  const r = escapeOpenSqlHostVars(src, mardGroups)
  assert.equal(r.changed, false)
  assert.equal(r.source, src)
})

test("SQL 转义：INTO CORRESPONDING FIELDS OF 不误转义", () => {
  const src = `FUNCTION zfm_x
  IMPORTING
    iv_a TYPE string
  TABLES
    et_mard LIKE mard.

SELECT * FROM mard INTO CORRESPONDING FIELDS OF ls_mard.

ENDFUNCTION.`
  const r = escapeOpenSqlHostVars(src, mardGroups)
  assert.equal(r.changed, false)
  assert.ok(r.source.includes("INTO CORRESPONDING FIELDS OF ls_mard"))
})

test("SQL 转义：@(ls_row) 行内声明不二次转义，INTO DATA(...) 自动补 @", () => {
  const src = `FUNCTION zfm_x
  IMPORTING
    iv_a TYPE string
  TABLES
    et_mard LIKE mard.

SELECT * FROM mard INTO @(ls_row).
SELECT * FROM mard INTO DATA(ls_row2).

ENDFUNCTION.`
  const r = escapeOpenSqlHostVars(src, mardGroups)
  assert.ok(r.source.includes("INTO @(ls_row)"), "已转义的 @( 不能动")
  assert.ok(r.source.includes("INTO @DATA(ls_row2)"), "INTO DATA() 应补 @")
})

test("SQL 转义：非 SQL 的普通 ABAP 行不加 @（赋值/条件/方法调用）", () => {
  const src = `FUNCTION zfm_x
  IMPORTING
    iv_matnr TYPE matnr
  TABLES
    et_mard LIKE mard.

lv_x = iv_matnr.
IF iv_matnr IS NOT INITIAL.
  cl_demo_output=>display( iv_matnr ).
ENDIF.

ENDFUNCTION.`
  const r = escapeOpenSqlHostVars(src, mardGroups)
  assert.equal(r.changed, false)
  assert.equal(r.source, src)
})

test("SQL 转义：整行注释里的参数名不转义", () => {
  const src = `FUNCTION zfm_x
  IMPORTING
    iv_matnr TYPE matnr

* 用 iv_matnr 查询 mard
SELECT * FROM mard
  WHERE matnr = iv_matnr
  INTO TABLE et_mard. " 行内注释里也有 et_mard

ENDFUNCTION.`
  const r = escapeOpenSqlHostVars(src, mardGroups)
  assert.ok(r.source.includes("* 用 iv_matnr 查询 mard"), "整行注释不动")
  assert.ok(r.source.includes('" 行内注释里也有 et_mard'), "行内注释不动")
  assert.ok(r.source.includes("WHERE matnr = @iv_matnr"))
  assert.ok(r.source.includes("INTO TABLE @et_mard"))
})

test("SQL 转义：多语句窗口各自独立", () => {
  const src = `FUNCTION zfm_x
  IMPORTING
    iv_werks TYPE werks_d
  TABLES
    et_mard LIKE mard.

SELECT * FROM mard WHERE werks = iv_werks INTO TABLE et_mard.
CLEAR et_mard.
SELECT * FROM mard WHERE werks = iv_werks INTO TABLE et_mard.

ENDFUNCTION.`
  const r = escapeOpenSqlHostVars(src, mardGroups)
  const lines = r.source.split("\n").filter((l) => l.includes("WHERE werks"))
  assert.equal(lines.length, 2)
  for (const l of lines) assert.ok(l.includes("= @iv_werks"), l)
  assert.equal(r.source.split("INTO TABLE").length - 1, 2)
  assert.ok(r.source.includes("CLEAR et_mard."))
})
