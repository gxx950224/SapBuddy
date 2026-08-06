/**
 * translate_text_pool 文本符号键判断单测
 * 回归：带字母的符号键（E01/S01/I01）曾因只认 3 位纯数字被误判成选择文本（ID='S'）
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const { isTextSymbolKey, generateClassSource } = require("../dist/sap-tools/tools/textPool.js")

test("isTextSymbolKey：3 位纯数字符号", () => {
  assert.equal(isTextSymbolKey("001"), true)
  assert.equal(isTextSymbolKey("101"), true)
})

test("isTextSymbolKey：带字母的 3 位符号（回归 E01/S01/I01）", () => {
  assert.equal(isTextSymbolKey("E01"), true)
  assert.equal(isTextSymbolKey("S01"), true)
  assert.equal(isTextSymbolKey("I01"), true)
  assert.equal(isTextSymbolKey("TXT"), true)
})

test("isTextSymbolKey：1~2 位字母/数字符号", () => {
  assert.equal(isTextSymbolKey("A"), true)
  assert.equal(isTextSymbolKey("X1"), true)
  assert.equal(isTextSymbolKey("9"), true)
})

test("isTextSymbolKey：小写输入也能识别", () => {
  assert.equal(isTextSymbolKey("e01"), true)
})

test("isTextSymbolKey：选择文本（参数名，含下划线或更长）判为 false", () => {
  assert.equal(isTextSymbolKey("S_CARRID"), false)
  assert.equal(isTextSymbolKey("P_COMP"), false)
  assert.equal(isTextSymbolKey("SO_NAME"), false)
  assert.equal(isTextSymbolKey("ABCD"), false)
})

// ── delete 模式：生成的 ABAP 删的是指定键本身（不做 Ixxx 归一化）─────────────
function delSource(keys) {
  return generateClassSource("ZCL_TPDELTEST", "delete", {
    prog: "ZPROG",
    tgtLang: "1",
    deleteKeys: keys,
  })
}

test("delete：对每个 deleteKey 生成 DELETE 与自检消失核对", () => {
  const src = delSource(["IE01", "Q01"])
  assert.ok(src.includes("DELETE lt_tp WHERE key = 'IE01'."), "应删除 IE01")
  assert.ok(src.includes("DELETE lt_tp WHERE key = 'Q01'."), "应删除 Q01")
  assert.ok(src.includes("SELFCHECK-FAIL:IE01"), "自检应核对 IE01 已消失")
  assert.ok(src.includes("SELFCHECK-FAIL:Q01"), "自检应核对 Q01 已消失")
})

test("delete：键原样使用，IE01 不会被归一化成 E01", () => {
  const src = delSource(["IE01"])
  assert.ok(src.includes("DELETE lt_tp WHERE key = 'IE01'."), "应删 IE01 本身")
  assert.ok(!src.includes("DELETE lt_tp WHERE key = 'E01'."), "不得误删 E01")
})
