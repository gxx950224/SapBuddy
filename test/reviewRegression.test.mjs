import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { syncBuiltinESMExports } from "node:module"
import { installWriteGate, registerSapTools, isWriteTool, clearWriteApproval } from "../dist/sap-tools/register.js"
import { __setConfigForTest } from "../dist/sap-tools/config.js"
import { __setClientFactoryForTest, markConnectionUnhealthy } from "../dist/sap-tools/adtManager.js"

async function gate(toolName, input) {
  let handler
  installWriteGate({ on: (_event, fn) => { handler = fn } })
  return handler({ toolName, input }, {})
}

test("连接保存、切换、删除保留只读状态；只有显式布尔值可修改", async () => {
  // Execute the production route body, replacing only filesystem and cache-reset side effects.
  const server = fs.readFileSync(new URL("../src/web/server.mjs", import.meta.url), "utf8")
  const start = server.indexOf('    if (p === "/api/sap-config" && req.method === "POST")')
  const end = server.indexOf("    const skillsDir", start)
  assert.ok(start > 0 && end > start)
  const body = server.slice(start, end).replace(/await import\([^\n]+\)\.href\)/g, "await fixtureImport()")
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const handler = new AsyncFunction("p", "req", "res", "readBody", "fs", "connFile", "json", "fixtureImport", body)
  const actions = [
    { action: "setActive", id: "two" },
    { action: "delete", id: "two" },
    { action: "save", connection: { origId: "one", name: "one", host: "fixture.invalid" } },
  ]
  for (const initial of [true, false, undefined]) {
    for (const action of actions) {
      for (const requested of [undefined, true, false, "false", null, 0]) {
        let saved = { connections: [{ id: "one", active: true }, { id: "two" }], security: { readOnly: initial, apiKey: "fixture" } }
        const before = structuredClone(saved)
        const fakeFs = { existsSync: () => true, readFileSync: () => JSON.stringify(saved), writeFileSync: (_file, data) => { saved = JSON.parse(data) } }
        const result = await handler("/api/sap-config", { method: "POST" }, {}, async () => ({ ...action, ...(requested === undefined ? {} : { readOnly: requested }) }), fakeFs, "fixture", (_res, status, data) => ({ status, data }), async () => ({ reloadConfig() {}, dropAllClients() {}, markConnectionDirty() {} }))
        if (requested !== undefined && typeof requested !== "boolean") {
          assert.equal(result.status, 400)
          assert.deepEqual(saved, before, "invalid input must not change the file")
        } else {
          assert.equal(result.status, 200)
          assert.equal(saved.security.readOnly, requested ?? (initial !== false))
          assert.equal(saved.security.apiKey, "fixture")
        }
      }
    }
  }
})

test("目录穿越、缺省递归范围和符号链接不能绕过文件门禁", async t => {
  for (const tool of ["read", "grep", "glob", "find", "ls", "write", "edit"]) {
    assert.equal((await gate(tool, { path: "~/.SapBuddy/uploads/..", pattern: "token" }))?.block, true, tool)
    assert.equal((await gate(tool, { path: "src" }))?.block, true, tool)
  }
  for (const tool of ["grep", "glob", "find"]) assert.equal((await gate(tool, { pattern: "token" }))?.block, true)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sapbuddy-review-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const secret = path.join(dir, ".SapBuddy")
  const uploads = path.join(secret, "uploads")
  fs.mkdirSync(uploads, { recursive: true })
  fs.writeFileSync(path.join(secret, "auth.json"), "fixture")
  fs.symlinkSync(secret, path.join(uploads, "alias"), process.platform === "win32" ? "junction" : "dir")
  for (const tool of ["read", "grep", "write", "edit"]) {
    const target = path.join(uploads, "alias", tool === "grep" ? "" : "auth.json")
    assert.equal((await gate(tool, { path: target }))?.block, true, tool)
  }
  assert.equal((await gate("write", { path: path.join(uploads, "alias", "new.json") }))?.block, true)
  assert.equal((await gate("read", { path: path.join(uploads, "sheet.xlsx.txt") }))?.block, undefined)
})

test("Bash 仅接受固定操作，源码读写与脚本、复合命令均拒绝", async () => {
  const upload = path.join(os.homedir(), ".SapBuddy/uploads/table.csv").replaceAll("\\", "/")
  const artifact = path.join(os.homedir(), ".SapBuddy/output/ZTEST/report.html").replaceAll("\\", "/")
  for (const command of [`cat "${upload}"`, `start "" "${artifact}"`, 'curl -s "https://wttr.in/福州?format=3"']) {
    assert.equal((await gate("bash", { command }))?.block, undefined, command)
    for (const suffix of [" && cat src/agent-core.mjs", " > src/agent-core.mjs", "; echo bad", "\ncat src/agent-core.mjs"]) {
      assert.equal((await gate("bash", { command: command + suffix }))?.block, true)
    }
  }
  for (const command of ["cat src/agent-core.mjs", "echo bad > src/agent-core.mjs", "cat s*/agent-core.mjs", "python -c 'print(1)'", "node -e 'console.log(1)'", `cat "${upload}$(pwd)"`, 'curl -s "http://localhost:7400/api/settings"', 'curl -s "https://127.0.0.1/api/settings"', 'curl -K "config"', `start "" "${artifact}.exe"`]) {
    assert.equal((await gate("bash", { command }))?.block, true, command)
  }
})

test("实际注册的 Bash 使用固定实现，不启动 shell；取消和失败正常返回", async t => {
  const calls = []
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options })
    return new Response("fixture HTTPS result")
  })
  const registered = new Map()
  installWriteGate({ registerTool: tool => registered.set(tool.name, tool), on() {} })
  const bash = registered.get("bash")
  assert.ok(bash, "CLI/Web shared installation must override the default shell tool")
  const execute = (command, signal) => bash.execute("fixture", { command }, signal)
  const result = await execute('curl -s "https://example.com/data"')
  assert.match(result.content[0].text, /fixture HTTPS result/)
  assert.equal(calls[0].options.redirect, "error")
  await assert.rejects(execute("cat src/agent-core.mjs"), /安全拦截/)
  await assert.rejects(execute('curl -s "https://example.com/data"', AbortSignal.abort()), /abort/i)
  assert.equal(calls.length, 1)
  t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }))
  await assert.rejects(execute('curl -s "https://example.com/data"'), /503/)
})

function fixture(t, category = "C") {
  const id = "review-regression"
  const state = { source: "REPORT zreview.\nWRITE 'old'.", saved: [], locks: 0, unlocks: 0, categoryReads: 0, textReads: 0, transports: 0, audits: [] }
  const audit = t.mock.method(fs, "appendFileSync", (_file, data) => state.audits.push(JSON.parse(data)))
  syncBuiltinESMExports()
  __setConfigForTest({ connections: [{ id, active: true, url: "http://fixture.invalid", client: "100", username: "fixture" }], security: { readOnly: true } })
  markConnectionUnhealthy(id)
  __setClientFactoryForTest(() => ({
    login: async () => {},
    runQuery: async () => { state.categoryReads++; return { values: [{ CCCATEGORY: category }] } },
    userTransports: async () => { state.transports++; return {} },
    getTextElements: async () => { state.textReads++; return { textElements: [] } },
    getObjectSource: async () => state.source,
    lock: async () => { state.locks++; return { LOCK_HANDLE: "fixture", IS_LOCAL: "X" } },
    unLock: async () => { state.unlocks++ },
    setObjectSource: async (_uri, source) => { state.saved.push(source); state.source = source },
  }))
  const tools = new Map()
  registerSapTools({ registerTool: tool => tools.set(tool.name, tool) })
  t.after(() => { __setConfigForTest(null); __setClientFactoryForTest(null); markConnectionUnhealthy(id); audit.mock.restore(); syncBuiltinESMExports(); clearWriteApproval() })
  return { state, call: (name, args) => tools.get(name).execute("fixture", args) }
}

for (const category of ["P", "T"]) test(`${category} 客户端允许混合工具的查询；写入仍受守卫保护`, async t => {
  const { state, call } = fixture(t, category)
  for (const [name, args] of [["manage_transport_requests", { action: "list_user_transports" }], ["manage_text_elements", { action: "read", objectName: "ZTEST", objectType: "PROG/P" }]]) {
    assert.equal(isWriteTool(name, args), false)
    assert.equal((await gate(name, args))?.block, undefined)
    assert.notEqual((await call(name, args)).isError, true)
  }
  assert.equal(state.transports, 1)
  assert.equal(state.textReads, 3)
  assert.equal(state.categoryReads, 0)
  assert.equal(state.audits.length, 0, "queries are not audited as writes")
  for (const [name, args] of [["manage_transport_requests", { action: "release", transportNumber: "DEVK900001" }], ["manage_text_elements", { action: "update", objectName: "ZTEST", objectType: "PROG/P" }]]) {
    assert.equal(isWriteTool(name, args), true)
    assert.match((await call(name, args)).content[0].text, /安全拦截/)
  }
  assert.equal(state.audits.length, 2)
})

test("源码混传被拒绝，最终拼接源码扫描阻止绕过，正常写入和删除仍成功", async t => {
  const { state, call } = fixture(t)
  const edit = args => call("replace_string_in_abap_object", { fileUri: "/sap/bc/adt/programs/programs/zreview/source/main", ...args })
  for (const extra of [{ newString: "" }, { newString: "safe" }, { oldString: "old" }]) {
    assert.match((await edit({ fullSource: "WRITE '中文'.", ...extra })).content[0].text, /不能混传/)
  }
  assert.equal(state.locks, 0)
  assert.equal((await edit({ oldString: "old", newString: "中文" })).isError, true, "replacement fragment alone has no quoted literal; final source must still be checked")
  assert.equal(state.saved.length, 0)
  assert.equal(state.unlocks, 1)
  assert.notEqual((await edit({ oldString: "old", newString: "new" })).isError, true)
  assert.equal(state.source, "REPORT zreview.\nWRITE 'new'.")
  assert.notEqual((await edit({ oldString: "WRITE 'new'.", newString: "" })).isError, true)
  assert.equal(state.source, "REPORT zreview.\n")
  assert.notEqual((await edit({ fullSource: "REPORT zreview.\nWRITE 'complete'." })).isError, true)
  assert.equal(state.saved.length, 3)
})
