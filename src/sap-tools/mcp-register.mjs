/**
 * MCP 服务器工具动态注册（共享模块）
 * 供 Web（agent-core.mjs）与 CLI 交互模式（pi-extension）共用：
 * 读取 .SapBuddy/mcp.json 的服务器 → 连接拉取 tools/list → 注册为 customTools（前缀 mcp_<server>_）
 */
import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "../..")

// 已注册 MCP 工具的 schema 占用估算（与 Web 端 EXT_TOKENS 同口径：
// 紧凑 JSON Schema ×0.4 /3.5 + 描述 /3.5），供 /api/context-stats 统计 mcp 占用
let mcpTokenEstimate = 0
const _mcpSeen = new Set()
export function getMcpTokensEstimate() { return mcpTokenEstimate }
function accountMcpToolSchema(toolName, inputSchema, description) {
  if (_mcpSeen.has(toolName)) return
  _mcpSeen.add(toolName)
  try {
    const schemaStr = JSON.stringify(inputSchema || {})
    const descStr = String(description || "")
    mcpTokenEstimate += Math.round(schemaStr.length * 0.4 / 3.5 + descStr.length / 3.5)
  } catch { /* 估算失败不影响注册 */ }
}

// ── MCP 预热缓存 ──
// agent 创建时若现场连接 MCP，连不上的服务器（内网 SAP 离线等）会阻塞主对话的首次响应。
// 改为：程序启动时后台预热，每个服务器连接完成即写入缓存；agent 创建读缓存，零等待。
const mcpCache = { promise: null, byName: {} }

/** 后台预热所有 MCP 服务器（幂等：同一时间只跑一轮）。每个服务器完成即写入 byName。 */
export function warmMcpServers() {
  if (mcpCache.promise) return mcpCache.promise
  mcpCache.promise = (async () => {
    const { loadMcpServers, testServer } = await import(pathToFileURL(path.join(ROOT, "src", "web", "mcp-client.mjs")).href)
    const servers = loadMcpServers()
    await Promise.all(Object.entries(servers).map(async ([name, server]) => {
      try {
        mcpCache.byName[name] = await testServer(name, server)
      } catch (e) {
        mcpCache.byName[name] = { name, connected: false, tools: [], error: e.message }
      }
    }))
    return mcpCache.byName
  })()
  return mcpCache.promise
}

/** MCP 配置变更后清除缓存并重新预热（设置-MCP 保存时调用） */
export function resetMcpCache() {
  mcpCache.byName = {}
  mcpCache.promise = null
  warmMcpServers()
}

export async function registerMcpTools(pi) {
  const { loadMcpServers, callMcpTool } = await import(pathToFileURL(path.join(ROOT, "src", "web", "mcp-client.mjs")).href)
  const { jsonSchemaToTypebox } = await import(pathToFileURL(path.join(ROOT, "dist", "sap-tools", "register.js")).href)
  warmMcpServers() // 确保预热在跑（幂等）；预热未完成的服务器本轮跳过，不阻塞主对话
  const servers = loadMcpServers()
  for (const [name, server] of Object.entries(servers)) {
    const st = mcpCache.byName[name]
    if (!st) continue // 预热还没轮到 → 本轮不带该 MCP 工具，后台继续，下个 agent 会话生效
    if (!st.connected) {
      console.log(`[sapbuddy] MCP ${name} 连接失败: ${st.error}`)
      continue
    }
    for (const t of st.tools) {
      const toolName = `mcp_${name}_${t.name}`
      accountMcpToolSchema(toolName, t.inputSchema, t.description)
      pi.registerTool({
        name: toolName,
        label: `${name}/${t.name}`,
        description: `[MCP:${name}] ${t.description}。来自外部 MCP 服务器 "${name}"（${server.url}）。`,
        promptSnippet: `外部 MCP 工具（${name}）`,
        parameters: jsonSchemaToTypebox(t.inputSchema),
        async execute(_id, args) {
          try {
            const text = await callMcpTool(server, t.name, args ?? {})
            return { content: [{ type: "text", text }], details: {} }
          } catch (err) {
            return {
              content: [{ type: "text", text: `MCP 工具 ${t.name} 执行失败: ${err instanceof Error ? err.message : String(err)}` }],
              details: {},
              isError: true,
            }
          }
        },
      })
    }
    console.log(`[sapbuddy] MCP ${name} 已注册 ${st.tools.length} 个工具（${st.tools.map((x) => x.name).join(", ")}）`)
  }
}
