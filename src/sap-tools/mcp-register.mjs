import { loadMcpServers, testServer, callMcpTool } from "../web/mcp-client.mjs"
/**
 * MCP 服务器工具动态注册（共享模块）
 * 供 Web（agent-core.mjs）与 CLI 交互模式（pi-extension）共用：
 * 读取 .SapBuddy/mcp.json 的服务器 → 连接拉取 tools/list → 注册为 customTools（前缀 mcp_<server>_）
 */
import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "../..")

export class McpWarmCache {
  constructor(load = loadMcpServers, probe = testServer) {
    this.load = load; this.probe = probe; this.generation = 0
    this.promise = null; this.byName = {}; this.listeners = new Set()
  }
  start() {
    if (this.promise) return this.promise
    const current = this.generation
    this.promise = (async () => {
      await Promise.all(Object.entries(this.load()).map(async ([name, server]) => {
        let status
        try { status = await this.probe(name, server) }
        catch (error) { status = { name, connected: false, tools: [], error: error.message } }
        if (current !== this.generation) return
        this.byName[name] = status
        for (const listener of this.listeners) listener()
      }))
      return this.byName
    })().catch(() => this.byName)
    return this.promise
  }
  reset(statuses = null) {
    this.generation++
    this.byName = Object.fromEntries((statuses || []).map(status => [status.name, status]))
    this.promise = statuses ? Promise.resolve(this.byName) : null
    return this.start()
  }
}
const defaultCache = new McpWarmCache()
export const warmMcpServers = () => defaultCache.start()
export const resetMcpCache = statuses => defaultCache.reset(statuses)
export function getMcpTokensEstimate() {
  return Math.ceil(Object.values(defaultCache.byName).reduce((n, st) => n + JSON.stringify(st.tools || []).length, 0) / 3)
}

export async function registerMcpTools(pi, cache = defaultCache) {
  const { jsonSchemaToTypebox } = await import(pathToFileURL(path.join(ROOT, "dist", "sap-tools", "register.js")).href)
  const { boundToolResult } = await import("../../dist/sap-tools/result.js")
  const { classifyFailure } = await import("../../dist/sap-tools/execution.js")
  pi.on("tool_result", event => {
    if (event.toolName.startsWith("mcp_") && event.details?.error) return { isError: true }
  })
  const registered = new Set()
  let disposed = false
  const servers = cache.load()
  const registerReady = () => {
    if (disposed) return
    for (const [name, server] of Object.entries(servers)) {
      const st = cache.byName[name]
      if (!st) continue // 完成预热后在当前 runtime 动态注册
      if (!st.connected) {
        console.log(`[sapbuddy] MCP ${name} 连接失败: ${st.error}`)
        continue
      }
      for (const t of st.tools) {
        const toolName = `mcp_${name}_${t.name}`
        if (registered.has(toolName)) continue
        pi.registerTool({
          name: toolName,
          label: `${name}/${t.name}`,
          description: `[MCP:${name}] ${t.description}。来自外部 MCP 服务器 "${name}"（${server.url}）。`,
          promptSnippet: `外部 MCP 工具（${name}）`,
          parameters: jsonSchemaToTypebox(t.inputSchema),
          async execute(_id, args, signal) {
            try {
              const text = await callMcpTool(server, t.name, args ?? {}, { signal })
              const bounded = await boundToolResult(text)
              return { content: [{ type: "text", text: bounded.text }], details: bounded.details }
            } catch (err) {
              return {
                content: [{ type: "text", text: `MCP 工具 ${t.name} 执行失败: ${err instanceof Error ? err.message : String(err)}` }],
                details: { error: { ...classifyFailure(err), retryable: false } },
                isError: true,
              }
            }
          },
        })
        registered.add(toolName)
      }

    }
  }
  const safelyRegister = () => { try { registerReady() } catch { /* disposed SDK runtime */ } }
  pi.on("session_shutdown", () => { disposed = true; cache.listeners.delete(safelyRegister) })
  cache.listeners.add(safelyRegister)
  registerReady()
  void cache.start().then(safelyRegister)
}
