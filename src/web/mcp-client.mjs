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
import { createHash } from "node:crypto"

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

/** 读取 MCP 服务器完整配置（含 disabled/无 url），供设置页展示历史数据 */
export function loadMcpServersAll() {
  for (const f of [PROJECT_MCP_FILE, GLOBAL_MCP_FILE]) {
    try {
      const j = JSON.parse(fs.readFileSync(f, "utf8"))
      if (j && j.mcpServers && typeof j.mcpServers === "object") return { ...j.mcpServers }
    } catch { /* 忽略 */ }
  }
  return {}
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

const sessions = new Map()
function serverKey(server) { return createHash("sha256").update(JSON.stringify(server)).digest("hex") }

/** Absolute deadline includes DNS, headers and response body. SSE resolves on the matching RPC id. */
export function rpcRequest(urlStr, server, method, params, id, { signal, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(urlStr); signal?.throwIfAborted() } catch (error) { reject(error); return }
    if (!["http:", "https:"].includes(u.protocol)) { reject(new Error("无效的 MCP URL 协议")); return }
    const key = serverKey(server)
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...server.headers }
    if (method !== "initialize" && sessions.has(key)) headers["Mcp-Session-Id"] = sessions.get(key)
    if (method !== "initialize") headers["MCP-Protocol-Version"] = "2025-03-26"
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params })
    let settled = false, response, timer
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      if (error) reject(error)
      else resolve(value)
      response?.destroy()
      req.destroy()
    }
    const abort = () => finish(signal?.reason ?? new Error("MCP 请求已取消"))
    const req = (u.protocol === "http:" ? http : https).request(u, {
      method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
      rejectUnauthorized: server.tls?.rejectUnauthorized === true,
    }, res => {
      response = res
      if (res.headers["mcp-session-id"]) sessions.set(key, String(res.headers["mcp-session-id"]))
      if (id === undefined && [200, 202, 204].includes(res.statusCode)) { finish(null, { status: res.statusCode, body: null }); return }
      const sse = String(res.headers["content-type"]).includes("text/event-stream")
      let data = "", bytes = 0
      const accept = json => {
        if (json?.id !== id) return false
        finish(null, { status: res.statusCode, body: json })
        return true
      }
      res.setEncoding("utf8")
      res.on("data", chunk => {
        bytes += Buffer.byteLength(chunk)
        if (bytes > 16 * 1024 * 1024) { finish(new Error("MCP 响应超过 16 MB 限制")); return }
        data += chunk
        if (!sse) return
        data = data.replace(/\r\n/g, "\n")
        let boundary
        while ((boundary = data.indexOf("\n\n")) >= 0) {
          const event = data.slice(0, boundary); data = data.slice(boundary + 2)
          const payload = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n")
          if (!payload) continue
          try { if (accept(JSON.parse(payload))) return } catch { finish(new Error("MCP SSE 响应解析失败")); return }
        }
      })
      res.on("end", () => {
        if (settled) return
        try {
          if (sse) throw new Error("MCP 流结束但未收到对应请求的结果")
          finish(null, { status: res.statusCode, body: data ? JSON.parse(data) : null })
        } catch (error) { finish(error) }
      })
      res.on("error", error => finish(error))
      res.on("aborted", () => finish(new Error("MCP 响应连接中断")))
    })
    req.on("error", error => finish(error))
    timer = setTimeout(() => finish(new Error(`MCP 请求超时（${timeoutMs}ms）`)), timeoutMs)
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
    else req.end(body)
  })
}

/** 连接测试：initialize + tools/list，返回状态摘要 */
export async function testServer(name, server, options = {}) {
  const deadline = AbortSignal.timeout(15_000)
  options = { ...options, signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline }
  try {
    const init = await rpcRequest(server.url, server, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "sapbuddy", version: "2.0.0" },
    }, 1, options)
    if (init.status !== 200 && init.status !== 202) {
      return { name, url: server.url, connected: false, tools: [], error: `HTTP ${init.status}` }
    }
    // 通知已初始化（无 id）
    await rpcRequest(server.url, server, "notifications/initialized", {}, undefined, options).catch(() => undefined)
    const tl = await rpcRequest(server.url, server, "tools/list", {}, 2, options)
    if (tl.body?.error || !Array.isArray(tl.body?.result?.tools)) throw new Error("MCP tools/list 失败")
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
export async function callMcpTool(server, toolName, args, options = {}) {
  const res = await rpcRequest(server.url, server, "tools/call", {
    name: toolName,
    arguments: args ?? {},
  }, Date.now(), { timeoutMs: 120_000, ...options })
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
