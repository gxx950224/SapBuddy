import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { mergeActivationResults, verifyActivation } from "../dist/sap-tools/tools/activationResult.js"
import { registerSapTools } from "../dist/sap-tools/register.js"
import { __setConfigForTest } from "../dist/sap-tools/config.js"
import { __setClientFactoryForTest, markConnectionUnhealthy } from "../dist/sap-tools/adtManager.js"

const obj = { "adtcore:name": "ZVERIFY", "adtcore:type": "PROG/P", "adtcore:uri": "/sap/bc/adt/programs/programs/zverify" }
const success = () => mergeActivationResults([{ success: true, messages: [], inactive: [] }], ["主程序 ZVERIFY"])

test("激活按语法检查、激活、active 读回顺序执行，并允许 CRLF 差异", async () => {
  const calls = []
  const client = {
    getObjectSource: async (_uri, opts) => { calls.push(opts.version); return opts.version === "inactive" ? "REPORT zverify.\r\n" : "REPORT zverify.\n" },
    syntaxCheck: async () => { calls.push("syntax"); return [] },
  }
  const r = await verifyActivation(client, obj, async () => { calls.push("activate"); return success() })
  assert.equal(r.success, true)
  assert.equal(r.verification, "matched")
  assert.deepEqual(calls, ["inactive", "syntax", "activate", "active"])
})

test("语法错误阻止激活；有警告仍继续核验", async () => {
  for (const severity of ["E", "W"]) {
    let activated = false
    const r = await verifyActivation({ getObjectSource: async () => "REPORT zverify.", syntaxCheck: async () => [{ severity, line: 1, text: "fixture" }] }, obj,
      async () => { activated = true; return success() })
    assert.equal(activated, severity === "W")
    assert.equal(r.success, severity === "W")
  }
})

test("旧 active 源码不能冒充本次激活成功，包括仅字面量变化", async () => {
  for (const [next, previous] of [["WRITE 'a  b'.", "WRITE 'a b'."], ["WRITE |a  \nb|.", "WRITE |a \nb|."]]) {
    const r = await verifyActivation({
      getObjectSource: async (_uri, opts) => opts.version === "inactive" ? next : previous,
      syntaxCheck: async () => [],
    }, obj, async () => success())
    assert.equal(r.success, false)
    assert.equal(r.verification, "mismatch")
  }
})

test("active 读取失败报告未确认，不能退回元数据判成功", async () => {
  const r = await verifyActivation({
    getObjectSource: async (_uri, opts) => { if (opts.version === "active") throw new Error("permission denied"); return "REPORT zverify." },
    syntaxCheck: async () => [],
  }, obj, async () => success())
  assert.equal(r.success, false)
  assert.equal(r.verification, "unavailable")
})

test("inactive 仅在 404 时回退 active，权限异常不能继续激活", async () => {
  for (const status of [404, 403]) {
    let activated = false
    const r = await verifyActivation({
      getObjectSource: async (_uri, opts) => { if (opts.version === "inactive") throw Object.assign(new Error("fixture"), { status }); return "REPORT zverify." },
      syntaxCheck: async () => [],
    }, obj, async () => { activated = true; return success() })
    assert.equal(activated, status === 404)
    assert.equal(r.success, status === 404)
  }
})

test("阶段失败保留来源并去重未激活对象，success=true 不能掩盖错误或 inactive", () => {
  const inactive = [{ object: { "adtcore:type": "FUGR/F", "adtcore:name": "ZFG" } }]
  const r = mergeActivationResults([
    { success: false, messages: [], inactive },
    { success: true, messages: [], inactive },
    { success: true, messages: [{ type: "E", shortText: "shared include" }], inactive },
  ], ["FORM", "主程序", "函数模块"])
  assert.equal(r.success, false)
  assert.equal(r.inactive.length, 1)
  assert.deepEqual(r.stages.map(s => [s.name, s.success]), [["FORM", false], ["主程序", false], ["函数模块", false]])
})

function fixture(t, overrides = {}) {
  const audits = []
  const mock = t.mock.method(fs, "appendFileSync", (_path, data) => audits.push(JSON.parse(data)))
  syncBuiltinESMExports()
  const id = "activation-result-fixture"
  __setConfigForTest({ connections: [{ id, url: "http://fixture.invalid", username: "u", password: "p", client: "100", security: { requireDevClient: false } }], security: { readOnly: false } })
  markConnectionUnhealthy(id)
  __setClientFactoryForTest(() => ({
    login: async () => {}, searchObject: async () => [obj],
    getObjectSource: async () => "REPORT zverify.", syntaxCheck: async () => [],
    lock: async () => ({ LOCK_HANDLE: "fixture" }), unLock: async () => {},
    activate: async () => ({ success: true, messages: [], inactive: [] }), ...overrides,
  }))
  const definitions = new Map(), handlers = {}
  registerSapTools({ registerTool: tool => definitions.set(tool.name, tool), on: (name, handler) => { handlers[name] = handler } })
  t.after(() => { __setConfigForTest(null); __setClientFactoryForTest(null); markConnectionUnhealthy(id); mock.mock.restore(); syncBuiltinESMExports() })
  return { definitions, handlers, audits }
}

test("编辑 oldString 未匹配：工具、SDK 钩子和审计均为失败", async t => {
  const { definitions, handlers, audits } = fixture(t)
  const r = await definitions.get("replace_string_in_abap_object").execute("edit", { fileUri: obj["adtcore:uri"], oldString: "MISSING", newString: "WRITE 'new'." })
  assert.match(r.content[0].text, /oldString/)
  assert.equal(r.isError, true)
  assert.equal(handlers.tool_result(r).isError, true)
  assert.deepEqual(audits.map(a => a.event), ["failed"])
})

test("SAP 返回失败但未抛异常：工具及审计必须失败", async t => {
  const { definitions, handlers, audits } = fixture(t, { activate: async () => ({ success: false, messages: [], inactive: [] }) })
  const r = await definitions.get("abap_activate").execute("activate", { objectName: "ZVERIFY", objectType: "PROG/P" })
  assert.equal(r.isError, true)
  assert.equal(handlers.tool_result(r).isError, true)
  assert.match(r.content[0].text, /主程序 ZVERIFY：未完成/)
  assert.deepEqual(audits.map(a => a.event), ["failed"])
})

test("通过 active 源码核验的激活才记为成功", async t => {
  const { definitions, audits } = fixture(t)
  const r = await definitions.get("abap_activate").execute("activate", { objectName: "ZVERIFY", objectType: "PROG/P" })
  assert.notEqual(r.isError, true)
  assert.match(r.content[0].text, /active 源码与本次待激活源码一致/)
  assert.deepEqual(audits.map(a => a.event), ["executed"])
})
