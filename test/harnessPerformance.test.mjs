import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { sliceLines } from "../dist/sap-tools/tools/shared.js"
import { getObjectLinesTool } from "../dist/sap-tools/tools/getObjectLines.js"
import { registerSapTools } from "../dist/sap-tools/register.js"
import { __setConfigForTest } from "../dist/sap-tools/config.js"
import { __setClientFactoryForTest, markConnectionUnhealthy, withConnMutex, withReadLock } from "../dist/sap-tools/adtManager.js"
import { runToolExecution, checkCancelled } from "../dist/sap-tools/execution.js"
import { boundToolResult } from "../dist/sap-tools/result.js"
import { createHttpClient, createManagedAdtClient } from "../dist/sap-tools/http-client.js"
import { rpcRequest } from "../src/web/mcp-client.mjs"
import { ContextStats } from "../src/web/context-stats.mjs"
import { EventBroadcaster, sendSse } from "../src/web/event-broadcaster.mjs"
import { budgetedModel, runtimeSettings, installToolDiscovery } from "../src/runtime-policy.mjs"
import { RunMetrics, summarizeRuns } from "../src/harness-metrics.mjs"
import { McpWarmCache, registerMcpTools } from "../src/sap-tools/mcp-register.mjs"
import { shouldCompact } from "@earendil-works/pi-coding-agent"

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function localServer(t, handler) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  return `http://127.0.0.1:${server.address().port}`
}

test("源码读取任务：lineCount 单独传入、默认分页和末页位置", async () => {
  const source = Array.from({ length: 600 }, (_, i) => `LINE_${i + 1}`).join("\n")
  assert.equal(sliceLines(source, undefined, 5).content.split("\n").length, 5)
  assert.equal(sliceLines(source).content.split("\n").length, 200)
  assert.match(sliceLines(source).header, /startLine=201/)
  assert.doesNotMatch(sliceLines(source, 599, 10).header, /startLine=/)
  __setConfigForTest({ connections: [{ id: "fixture", url: "http://fake", username: "u", password: "p", client: "100" }], security: {} })
  __setClientFactoryForTest(() => ({ login: async () => {}, searchObject: async () => [{ "adtcore:name": "ZTEST", "adtcore:type": "PROG/P", "adtcore:uri": "/sap/bc/adt/programs/programs/ztest" }], getObjectSource: async () => source }))
  try {
    const result = await getObjectLinesTool.execute({ objectName: "ZTEST", objectType: "PROG", lineCount: 5 })
    assert.equal((result.match(/LINE_\d+/g) || []).length, 5)
    markConnectionUnhealthy("fixture")
    __setClientFactoryForTest(() => ({ login: async () => { throw Object.assign(new Error("permission denied"), { status: 403 }) } }))
    const definitions = []
    registerSapTools({ registerTool: t => definitions.push(t) })
    const failure = await definitions.find(t => t.name === "get_abap_object_lines").execute("error", { objectName: "ZTEST", objectType: "PROG" })
    assert.equal(failure.isError, true)
    assert.equal(failure.details.error.code, "PERMISSION")
    assert.equal(failure.details.error.retryable, false)
  } finally { __setConfigForTest(null); __setClientFactoryForTest(null); markConnectionUnhealthy("fixture") }
})

test("真实 Agent 失败状态：tool_result 钩子让 SDK 持久化 isError", async () => {
  const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))
  const { Agent } = await import(new URL("./dist/index.js", pathToFileURL(sdkRequire.resolve("@earendil-works/pi-agent-core/package.json"))))
  const definitions = [], handlers = {}
  registerSapTools({ registerTool: t => definitions.push(t), on: (event, fn) => { handlers[event] = fn } })
  __setConfigForTest({ connections: [], security: {} })
  let requests = 0
  const agent = new Agent({
    initialState: { model: { id: "fixture", provider: "fixture", api: "openai-completions" }, tools: definitions },
    afterToolCall: ({ result, toolCall }) => handlers.tool_result({ ...result, toolName: toolCall.name }),
    streamFn: () => {
      const message = { role: "assistant", timestamp: Date.now(),
        content: requests++ === 0 ? [{ type: "toolCall", id: "failed-read", name: "get_abap_object_lines", arguments: { objectName: "ZTEST" } }] : [{ type: "text", text: "连接未配置" }],
        stopReason: requests === 1 ? "toolUse" : "stop" }
      return { async *[Symbol.asyncIterator]() { yield { type: "done", message } }, result: async () => message }
    },
  })
  try {
    await agent.prompt("read fixture")
    assert.equal(agent.state.messages.find(m => m.role === "toolResult").isError, true)
  } finally { __setConfigForTest(null) }
})

test("大结果任务：预览有界，完整结果可恢复", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sapbuddy-result-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const text = "源码\n".repeat(20_000)
  const result = await boundToolResult(text, dir)
  assert.ok(result.text.length < 32_000)
  assert.equal(await fs.readFile(result.details.fullResultPath, "utf8"), text)
})

test("取消任务：取消排队写操作立即返回，后续队列仍可执行", async () => {
  let release
  const held = withReadLock("cancel-gate", () => new Promise(resolve => { release = resolve }))
  await pause(1)
  const controller = new AbortController()
  const queued = runToolExecution(controller.signal, () => withConnMutex("cancel-gate", async () => assert.fail("cancelled write ran")))
  controller.abort(new Error("用户取消"))
  await assert.rejects(queued, /取消/)
  release(); await held
  assert.equal(await withConnMutex("cancel-gate", async () => "next"), "next")
})

test("写入取消任务：收尾前不释放独占锁", async () => {
  const controller = new AbortController(), order = []
  const write = runToolExecution(controller.signal, () => withConnMutex("cleanup-gate", async () => {
    try { controller.abort(new Error("取消")); checkCancelled() }
    finally { await pause(20); order.push("unlocked") }
  }))
  const rejection = assert.rejects(write, /取消/)
  await pause(1)
  const next = withReadLock("cleanup-gate", async () => order.push("next"))
  await Promise.all([rejection, next])
  assert.deepEqual(order, ["unlocked", "next"])
})

test("网络任务：MCP 响应头后的停滞有截止时间，SAP HTTP 接收取消信号", async t => {
  const url = await localServer(t, (req, res) => { req.resume(); res.writeHead(200, { "Content-Type": "application/json" }); res.flushHeaders() })
  await assert.rejects(rpcRequest(url, { url }, "tools/call", {}, 1, { timeoutMs: 50 }), /超时/)
  const controller = new AbortController()
  const result = runToolExecution(controller.signal, () => createHttpClient(url, { timeout: 5000 }).request({ url: "/slow" }))
  setTimeout(() => controller.abort(new Error("用户取消")), 30)
  await assert.rejects(result, /取消/)
})

test("ADT 传输兼容：保留登录 Cookie、CSRF、连接 URL 与无状态克隆", async t => {
  const requests = []
  const url = await localServer(t, (req, res) => {
    requests.push({ url: req.url, headers: req.headers })
    if (req.url.startsWith("/sap/bc/adt/compatibility/graph")) {
      res.writeHead(200, { "x-csrf-token": "fixture-csrf", "set-cookie": ["fixture=1; Path=/"], "content-type": "application/xml" })
      res.end("<graph/>")
    } else res.end("REPORT zfixture.")
  })
  const client = createManagedAdtClient(url, "u", "p", "100", "EN", { timeout: 1000 })
  await runToolExecution(undefined, async () => {
    await client.login()
    assert.equal(await client.getObjectSource("/sap/bc/adt/programs/programs/zfixture/source/main"), "REPORT zfixture.")
  })
  assert.equal(client.baseUrl, url)
  assert.equal(client.statelessClone.baseUrl, url)
  assert.equal(client.statelessClone.statelessClone, client.statelessClone)
  assert.match(requests[0].url, /sap-client=100/)
  assert.match(requests[1].headers.cookie, /fixture=1/)
  assert.equal(requests[1].headers["x-csrf-token"], "fixture-csrf")
})

test("MCP SSE：忽略通知，匹配 id 后立即完成，无需等待连接关闭", async t => {
  const url = await localServer(t, (req, res) => {
    req.resume(); res.writeHead(200, { "Content-Type": "text/event-stream" })
    res.write('data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n')
    res.write('data: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n\n')
  })
  const result = await rpcRequest(url, { url }, "tools/list", {}, 7, { timeoutMs: 1000 })
  assert.equal(result.body.result.ok, true)
})

test("预算任务：64K 设置约束模型窗口、输出预留和压缩阈值", () => {
  const model = budgetedModel({ contextTokens: 64000 }, { contextWindow: 200000, maxTokens: 32000 })
  const settings = runtimeSettings({ contextTokens: 64000 }, model)
  assert.equal(model.contextWindow, 64000)
  assert.equal(model.maxTokens, 16000)
  assert.equal(settings.compaction.reserveTokens, 12801)
  assert.ok(settings.compaction.keepRecentTokens < 64000 - 16000)
  assert.equal(budgetedModel({ contextTokens: 64000 }, { contextWindow: 32000 }).contextWindow, 64000)
  const configured = budgetedModel({ contextTokens: 200000 }, { contextWindow: 128000 })
  assert.equal(configured.contextWindow, 200000)
  const configuredPolicy = runtimeSettings({ contextTokens: 200000 }, configured)
  assert.equal(shouldCompact(159999, configured.contextWindow, configuredPolicy.compaction), false)
  assert.equal(shouldCompact(160000, configured.contextWindow, configuredPolicy.compaction), true)
  assert.equal(new ContextStats().get({ model: configured }, () => 0).data.max, 200000)
  assert.equal(budgetedModel({}, { contextWindow: 128000 }).contextWindow, 128000)
  assert.equal(settings.retry.provider.maxRetries, 0)
  for (const limit of [8192, 32000, 64000, 200000]) {
    const policy = runtimeSettings({ contextTokens: limit }, { contextWindow: limit })
    const boundary = Math.ceil(limit * 0.8)
    assert.equal(shouldCompact(boundary - 1, limit, policy.compaction), false)
    assert.equal(shouldCompact(boundary, limit, policy.compaction), true)
  }
})

test("上下文分组：恢复配置明细，只统计实际注入的技能目录", () => {
  const estimate = m => m.content[0].text.length
  const session = {
    model: { contextWindow: 64000 },
    systemPrompt: 'base<project_instructions path="C:/app/AGENTS.md">rules</project_instructions>SYSTEM BODYMEMORY BODY<available_skills>metadata</available_skills>',
    resourceLoader: {
      getAppendSystemPromptSources: () => [{ path: "C:/prompts/SYSTEM.md" }, { path: "C:/prompts/Memory.md" }],
      getAppendSystemPrompt: () => ["SYSTEM BODY", "MEMORY BODY"],
    },
  }
  const { data } = new ContextStats().get(session, estimate)
  assert.ok(data.agents > 0)
  assert.equal(data.systemMd, 11)
  assert.equal(data.memory, 11)
  assert.equal(data.skills, "<available_skills>metadata</available_skills>".length)
  assert.equal(data.piAgent + data.agents + data.systemMd + data.memory + data.skills, data.total)
})

test("上下文统计：实际提示/启用工具、usage 缓存、跨请求缓存与失效", () => {
  let estimates = 0
  const estimate = m => { estimates++; return JSON.stringify(m.content).length }
  const session = { model: { contextWindow: 64000 }, systemPrompt: "skill metadata only", agent: { state: { messages: [{ role: "assistant", content: [], usage: { input: 10, output: 5, cacheRead: 25 } }] } }, getActiveToolNames: () => ["read"], getAllTools: () => [{ name: "read", parameters: {} }, { name: "unused", description: "x".repeat(10000) }] }
  const stats = new ContextStats()
  const a = stats.get(session, estimate, 1000), count = estimates
  assert.equal(stats.get(session, estimate, 1100), a)
  assert.equal(estimates, count)
  assert.equal(a.data.usage.cacheRead, 25)
  assert.equal(a.data.usage.cost, null)
  assert.equal(a.data.activeTools, 1)
  stats.get(session, estimate, 4100)
  assert.ok(estimates > count)
  session.systemPrompt = "changed"
  assert.notEqual(stats.get(session, estimate, 4101), a)
})

test("流式任务：高频快照合并，结束前刷新，慢客户端断开重连", () => {
  const sent = [], channel = new EventBroadcaster(payload => sent.push(payload))
  for (let i = 0; i < 1000; i++) channel.publish({ event: { type: "message_update", message: { timestamp: 1, content: "a".repeat(i) } } })
  channel.publish({ event: { type: "message_end" } })
  assert.equal(sent.length, 2)
  assert.equal(sent[0].event.message.content.length, 999)
  assert.equal(sent[1].event.type, "message_end")
  let disconnected = false
  const slow = { writableLength: 999, destroy() { disconnected = true }, write() { assert.fail() } }
  const clients = new Set([slow])
  sendSse(clients, "data", 100)
  assert.equal(disconnected, true)
  assert.equal(clients.size, 0)
  channel.dispose()
})

test("Harness：区分完成与成功、不伪造价格、统计重复工具且不保存参数", () => {
  let now = 0
  const metrics = new RunMetrics(() => now)
  metrics.start("fixture", "all")
  for (let i = 0; i < 2; i++) {
    metrics.event({ type: "tool_execution_start", toolName: "read", toolCallId: i, args: { secret: "do-not-store" } })
    now += 10
    metrics.event({ type: "tool_execution_end", toolCallId: i, result: { content: [] } })
  }
  metrics.event({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 10, output: 2, cacheRead: 8 } } })
  const row = metrics.finish()
  assert.equal(row.repeatedTools, 1)
  assert.equal(row.taskSuccess, null)
  assert.equal(row.cost, null)
  assert.ok(!JSON.stringify(row).includes("do-not-store"))
  assert.equal(summarizeRuns([row]).successRate, null)
  assert.equal(summarizeRuns([{ ...row, taskSuccess: true, cost: 1 }, { ...row, taskSuccess: false, cost: 2 }]).costPerSuccess, 3)
})

test("工具发现：普通任务精简定义，启用后同一会话保持全部 SAP 工具", async () => {
  const tools = [{ name: "read" }, { name: "sap_read" }, { name: "sap_write" }], handlers = {}
  let active = []
  installToolDiscovery({ registerTool: tool => tools.push(tool), on: (event, fn) => { handlers[event] = fn }, getAllTools: () => tools, setActiveTools: names => { active = names } }, { toolProfile: "discover", sapToolNames: ["sap_read", "sap_write"] })
  handlers.session_start()
  assert.deepEqual(active, ["read", "enable_sap_tools"])
  await tools.at(-1).execute()
  handlers.before_agent_start()
  assert.ok(active.includes("sap_write"))
})

test("MCP 预热任务：当前 Agent 动态获得工具，旧配置响应不会覆盖新配置", async () => {
  let complete
  const cache = new McpWarmCache(() => ({ fixture: { url: "http://fixture" } }), () => new Promise(resolve => { complete = resolve }))
  const tools = [], handlers = {}
  await registerMcpTools({ registerTool: tool => tools.push(tool), on: (event, fn) => { handlers[event] = fn } }, cache)
  assert.equal(tools.length, 0)
  complete({ name: "fixture", connected: true, tools: [{ name: "lookup", description: "fixture", inputSchema: { type: "object" } }] })
  await cache.start()
  assert.equal(tools[0].name, "mcp_fixture_lookup")
  handlers.session_shutdown()
  assert.equal(cache.listeners.size, 0)
  const old = cache.reset()
  const oldComplete = complete
  await cache.reset([{ name: "new", connected: true, tools: [] }])
  oldComplete({ name: "fixture", connected: true, tools: [] })
  await old
  assert.deepEqual(Object.keys(cache.byName), ["new"])
})
