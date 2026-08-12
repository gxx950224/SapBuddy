/**
 * execute_data_query 列名提示（hintRealColumns 依赖）的纯函数单测：
 * extractTablesFromSql 从失败 SQL 中正确提取表名，避免 LLM 反复猜列名烧 token
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const { extractTablesFromSql } = require("../dist/sap-tools/tools/quality.js")

test("提取 FROM 表名（单表）", () => {
  assert.deepEqual(extractTablesFromSql("SELECT * FROM T001 WHERE BUKRS = '1000'"), ["T001"])
})

test("提取 FROM + JOIN 两张表，去重", () => {
  assert.deepEqual(
    extractTablesFromSql("SELECT a.tcode, b.stext FROM tstc a LEFT JOIN tstct b ON a.tcode = b.tcode"),
    ["tstc", "tstct"]
  )
})

test("多次 JOIN 只取前 2 张，避免扩大重试成本", () => {
  const sql = "SELECT * FROM A JOIN B ON A.k = B.k JOIN C ON B.k = C.k JOIN D ON C.k = D.k"
  assert.deepEqual(extractTablesFromSql(sql), ["A", "B"])
})

test("字符串字面量里的 FROM 不误提取", () => {
  assert.deepEqual(extractTablesFromSql("SELECT * FROM ZTAB WHERE TXT LIKE '%FROM X%'"), ["ZTAB"])
})

test("块注释里的表名不误提取", () => {
  assert.deepEqual(extractTablesFromSql("SELECT * FROM ZTAB /* JOIN FAKE */ WHERE A = 1"), ["ZTAB"])
})

test("无 FROM 的 SQL 返回空", () => {
  assert.deepEqual(extractTablesFromSql("SELECT 1"), [])
})

test("FROM 小写也识别，保持原样返回", () => {
  assert.deepEqual(extractTablesFromSql("select * from ztab where x = 1"), ["ztab"])
})
