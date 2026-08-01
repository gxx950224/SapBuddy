/**
 * AbapBuddy Web Server — 本地 Web 版入口
 *
 * 启动: node src/web/server.mjs [--port 7400]
 * 功能:
 *   - 静态服务 Web UI (src/web/public)
 *   - SSE 流式输出 (/api/events)
 *   - 聊天接口 (/api/chat)
 *   - 会话状态 / 工具列表
 * 纯 Node 实现，无任何外部运行时依赖（跨平台）。
 */
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..", "..")
const PUBLIC_DIR = path.join(HERE, "public")

// 命令行参数
const portArg = process.argv.indexOf("--port")
const PORT = portArg >= 0 ? Number(process.argv[portArg + 1]) : 7400
const HOST = "127.0.0.1"

// ─── Agent 会话 ────────────────────────────────────────────────────────────
let session = null
let busy = false
let reconnectTimer = null

async function ensureSession() {
  if (session) return session
  const { createAgent } = await import(pathToFileURL(path.join(ROOT, "src", "agent-core.mjs")).href)
  const created = await createAgent()
  session = created.session
  attachStreaming(session)
  return session
}

/** 把 agent 事件流广播给 SSE 客户端 */
function attachStreaming(s) {
  s.subscribe((event) => {
    if (event.type === "message_update") {
      if (event.assistantMessageEvent.type === "text_delta") {
        broadcast({ kind: "delta", text: event.assistantMessageEvent.delta, ts: Date.now() })
      }
    } else if (event.type === "tool_execution_start") {
      broadcast({ kind: "tool_start", name: event.toolName, ts: Date.now() })
    } else if (event.type === "tool_execution_end") {
      broadcast({ kind: "tool_end", name: event.toolName, error: event.isError, ts: Date.now() })
    } else if (event.type === "agent_end") {
      broadcast({ kind: "agent_end", ts: Date.now() })
    }
  })
}

// ─── SSE 客户端 ─────────────────────────────────────────────────────────────
const sseClients = new Set()

function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`
  for (const res of sseClients) {
    try { res.write(data) } catch { sseClients.delete(res) }
  }
}

// ─── HTTP 服务 ──────────────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
}

function serveStatic(req, res) {
  let pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname)
  if (pathname === "/") pathname = "/index.html"
  const file = path.join(PUBLIC_DIR, pathname)
  // 防目录穿越
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end("Forbidden") }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not Found") }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" })
    res.end(data)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`)
  const pathname = url.pathname

  try {
    // SSE 事件流
    if (pathname === "/api/events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      })
      res.write(": connected\n\n")
      sseClients.add(res)
      req.on("close", () => sseClients.delete(res))
      return
    }

    // 会话状态
    if (pathname === "/api/state" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" })
      return res.end(JSON.stringify({ busy, hasSession: !!session, ts: Date.now() }))
    }

    // 工具列表
    if (pathname === "/api/tools" && req.method === "GET") {
      const { listToolNames } = await import(
        pathToFileURL(path.join(ROOT, "dist", "sap-tools", "register.js")).href
      )
      res.writeHead(200, { "Content-Type": "application/json" })
      return res.end(JSON.stringify(listToolNames()))
    }

    // 聊天接口（POST { message }）
    if (pathname === "/api/chat" && req.method === "POST") {
      let body = ""
      for await (const chunk of req) body += chunk
      let payload
      try { payload = JSON.parse(body) } catch { payload = {} }
      const message = (payload.message || "").trim()
      if (!message) { res.writeHead(400); return res.end(JSON.stringify({ error: "message 不能为空" })) }

      if (busy) { res.writeHead(409); return res.end(JSON.stringify({ error: "上一轮对话仍在处理中" })) }
      busy = true
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: true, ts: Date.now() }))

      try {
        const s = await ensureSession()
        await s.prompt(message)
      } catch (e) {
        broadcast({ kind: "error", message: e.message, ts: Date.now() })
      } finally {
        busy = false
        broadcast({ kind: "idle", ts: Date.now() })
      }
      return
    }

    // 静态资源
    serveStatic(req, res)
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: e.message }))
  }
})

server.listen(PORT, HOST, () => {
  console.log(`\n  🚀 AbapBuddy Web 版已启动`)
  console.log(`  📍 请用浏览器打开: http://${HOST}:${PORT}\n`)
})
