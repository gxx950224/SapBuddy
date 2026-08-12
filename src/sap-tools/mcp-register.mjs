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

export async function registerMcpTools(pi) {
  const { loadMcpServers, testServer, callMcpTool } = await import(pathToFileURL(path.join(ROOT, "src", "web", "mcp-client.mjs")).href)
  const { jsonSchemaToTypebox } = await import(pathToFileURL(path.join(ROOT, "dist", "sap-tools", "register.js")).href)
  const servers = loadMcpServers()
  for (const [name, server] of Object.entries(servers)) {
    try {
      const st = await testServer(name, server)
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
    } catch (e) {
      console.log(`[sapbuddy] MCP ${name} 注册失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}
