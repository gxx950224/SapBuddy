/**
 * 轻量 MCP streamable-http 客户端（零依赖，node:https 自实现）
 * 用于：1) 设置-MCP 保存后连接测试  2) agent 加载时将 MCP 工具注册为 customTools
 * 配置来源：主目录 ~/.SapBuddy/mcp.json（优先）→ 全局 ~/.pi/agent/mcp.json
 */
import https from "node:https"
import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const PROJECT_MCP_FILE = path.join(os.homedir(), ".SapBuddy", "mcp.json")
export const GLOBAL_MCP_FILE = path.join(os.homedir(), ".pi", "agent", "mcp.json")

/** 读取 MCP 服务器配置（项目优先，回退全局），返回 Record<name, server> */
export function loadMcpServers() {
  let raw = {}
  for (const f of [PROJECT_MCP_FILE, GLOBAL_MCP_FILE]) {
    try {
      const j = JSON.parse(fs.readFileSync(f, "utf8"))
      if (j && j.mcpServers && typeof j.mcpServers === "object") {
        raw = { ...j.mcpServers }
        break
      }
    } catch { /* 忽略 */ }
  }
  // 过滤 disabled
  const out = {}
  for (const [name, s] of Object.entries(raw)) {
    if (s && s.disabled !== true && s.url) out[name] = s
  }
  return out
}

/** 保存 MCP 服务器配置到项目 + 全局（供 pi mcp gateway 使用） */
export function saveMcpServers(servers) {
  const payload = JSON.stringify({ mcpServers: servers ?? {} }, null, 2)
  fs.mkdirSync(path.dirname(PROJECT_MCP_FILE), { recursive: true })
  fs.writeFileSync(PROJECT_MCP_FILE, payload)
  try {
    fs.mkdirSync(path.dirname(GLOBAL_MCP_FILE), { recursive: true })
    fs.writeFileSync(GLOBAL_MCP_FILE, payload)
  } catch { /* 全局不可写时忽略（项目配置已保存） */ }
}

/** 一次 JSON-RPC 请求（兼容 JSON 与 SSE 响应） */
function rpcRequest(urlStr, server, method, params, id) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(urlStr) } catch { reject(new Error(`无效的 URL: ${urlStr}`)); return }
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    }
    for (const [k, v] of Object.entries(server.headers ?? {})) headers[k] = String(v)
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params })
    const mod = u.protocol === "http:" ? http : https
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "http:" ? 80 : 443),
        path: u.pathname + u.search,
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
        // tls.rejectUnauthorized=false 允许自签名证书（内网 SAP 常用）
        rejectUnauthorized: server.tls?.rejectUnauthorized !== false,
      },
      (res) => {
        let data = ""
        res.setEncoding("utf8")
        res.on("data", (c) => { data += c })
        res.on("end", () => {
          try {
            const ct = String(res.headers["content-type"] || "")
            if (ct.includes("text/event-stream")) {
              // SSE：逐行解析 data: {...}
              let json = ""
              for (const line of data.split("\n")) {
                const m = line.match(/^data:\s*(.*)$/)
                if (m) json += m[1]
              }
              if (json) resolve({ status: res.statusCode, body: JSON.parse(json) })
              else resolve({ status: res.statusCode, body: null })
            } else {
              resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null })
            }
          } catch (e) {
            reject(new Error(`响应解析失败 (HTTP ${res.statusCode}): ${data.slice(0, 200)}`))
          }
        })
      }
    )
    req.on("error", (e) => reject(new Error(`连接失败: ${e.message}`)))
    req.write(body)
    req.end()
  })
}

/** 连接测试：initialize + tools/list，返回状态摘要 */
export async function testServer(name, server) {
  try {
    const init = await rpcRequest(server.url, server, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "sapbuddy", version: "2.0.0" },
    }, 1)
    if (init.status !== 200 && init.status !== 202) {
      return { name, url: server.url, connected: false, tools: [], error: `HTTP ${init.status}` }
    }
    // 通知已初始化（无 id）
    await rpcRequest(server.url, server, "notifications/initialized", {}, undefined).catch(() => undefined)
    const tl = await rpcRequest(server.url, server, "tools/list", {}, 2)
    const tools = (tl.body?.result?.tools ?? []).map((t) => ({
      name: String(t.name ?? ""),
      description: String(t.description ?? "").slice(0, 200),
      inputSchema: t.inputSchema ?? {},
    }))
    return { name, url: server.url, connected: true, tools, error: undefined }
  } catch (e) {
    return { name, url: server.url, connected: false, tools: [], error: e.message }
  }
}

/** 调用 MCP 工具 */
export async function callMcpTool(server, toolName, args) {
  const res = await rpcRequest(server.url, server, "tools/call", {
    name: toolName,
    arguments: args ?? {},
  }, Date.now())
  const r = res.body?.result
  if (!r) throw new Error(`MCP 工具 ${toolName} 无结果 (HTTP ${res.status})`)
  if (r.isError) {
    const t = (r.content ?? []).map((c) => c.text ?? "").join("\n")
    throw new Error(`MCP 工具 ${toolName} 执行失败: ${t || "未知错误"}`)
  }
  return (r.content ?? [])
    .map((c) => {
      if (c.type === "text") return c.text ?? ""
      if (c.type === "resource" || c.type === "image") return `[${c.type}: ${c.mimeType || ""}]`
      return JSON.stringify(c)
    })
    .join("\n")
}
