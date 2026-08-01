/**
 * AbapBuddy Web Server — 本地 Web 版
 *
 * 启动: node src/web/server.mjs [--port 7400]
 * API:
 *   GET  /api/events          SSE 事件流（agent 原始事件）
 *   POST /api/chat            { text } → 触发 agent 对话
 *   POST /api/abort           停止当前生成
 *   POST /api/compress        压缩上下文
 *   GET  /api/state           会话状态（轮询）
 *   GET  /api/tools           42 个工具清单
 *   GET  /api/history         会话消息历史
 *   POST /api/session/new     新建会话
 *   GET  /api/sessions        会话列表
 *   POST /api/thinking-level  { level } 设置思考级别
 *   GET  /api/context-stats   上下文统计
 */
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..", "..")
const PUBLIC_DIR = path.join(HERE, "public")

const portArg = process.argv.indexOf("--port")
const PORT = portArg >= 0 ? Number(process.argv[portArg + 1]) : 7400
const HOST = "127.0.0.1"

// ─── Agent 会话 ────────────────────────────────────────────────────────────
let agent = null
let session = null
let busy = false

async function ensureAgent() {
  if (agent) return agent
  const { createAgent } = await import(pathToFileURL(path.join(ROOT, "src", "agent-core.mjs")).href)
  agent = await createAgent()
  session = agent.session
  attachStreaming(session)
  return agent
}

/** agent 原始事件 → SSE 广播（前端 handleAgentEvent 直接消费） */
function attachStreaming(s) {
  s.subscribe((event) => {
    broadcast({ kind: "agent", event, ts: Date.now() })
  })
  s.subscribe((event) => {
    if (event.type === "agent_end") busy = false
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

// ─── 会话文件工具 ───────────────────────────────────────────────────────────
function sessionsDir() {
  return path.join(ROOT, ".pi", "sessions")
}
function listSessionFiles() {
  const dir = sessionsDir()
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().reverse()
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

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(obj))
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")) } catch { resolve({}) }
    })
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`)
  const p = url.pathname

  try {
    // SSE
    if (p === "/api/events" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" })
      res.write(": connected\n\n")
      sseClients.add(res)
      req.on("close", () => sseClients.delete(res))
      return
    }

    // 聊天
    if (p === "/api/chat" && req.method === "POST") {
      const { text } = await readBody(req)
      if (!text || !text.trim()) return json(res, 400, { error: "text 不能为空" })
      if (busy) return json(res, 409, { error: "上一轮仍在处理中" })
      busy = true
      json(res, 200, { ok: true, ts: Date.now() })
      try {
        const a = await ensureAgent()
        await a.session.prompt(text.trim())
      } catch (e) {
        broadcast({ kind: "error", error: e.message, ts: Date.now() })
      } finally {
        busy = false
        broadcast({ kind: "agent", event: { type: "agent_settled" }, ts: Date.now() })
      }
      return
    }

    // 停止
    if (p === "/api/abort" && (req.method === "POST" || req.method === "GET")) {
      try { await session?.abort() } catch { /* 无会话 */ }
      busy = false
      return json(res, 200, { ok: true })
    }

    // 压缩上下文
    if (p === "/api/compress" && req.method === "POST") {
      try {
        await session?.compact()
        broadcast({ kind: "compress_result", ts: Date.now() })
        return json(res, 200, { ok: true })
      } catch (e) {
        return json(res, 500, { error: e.message })
      }
    }

    // 思考级别
    if (p === "/api/thinking-level" && req.method === "POST") {
      const { level } = await readBody(req)
      try { session?.setThinkingLevel(level) } catch { /* 忽略 */ }
      return json(res, 200, { ok: true })
    }

    // 上下文统计
    if (p === "/api/context-stats" && req.method === "GET") {
      const usage = session?.agent?.state?.messages?.reduce((acc, m) => {
        acc.input += m.usage?.input ?? 0
        acc.output += m.usage?.output ?? 0
        return acc
      }, { input: 0, output: 0 })
      return json(res, 200, { success: true, data: { usage: usage ?? { input: 0, output: 0 }, messageCount: session?.agent?.state?.messages?.length ?? 0 } })
    }

    // 会话状态
    if (p === "/api/state" && req.method === "GET") {
      return json(res, 200, { busy, hasSession: !!session, ts: Date.now() })
    }

    // 工具列表
    if (p === "/api/tools" && req.method === "GET") {
      const { listToolNames } = await import(pathToFileURL(path.join(ROOT, "dist", "sap-tools", "register.js")).href)
      return json(res, 200, listToolNames())
    }

    // 会话历史
    if (p === "/api/history" && req.method === "GET") {
      const file = url.searchParams.get("path")
      const target = file && fs.existsSync(file) ? file : session?.sessionFile
      if (!target || !fs.existsSync(target)) return json(res, 200, { success: true, data: { messages: [] } })
      const lines = fs.readFileSync(target, "utf8").split("\n").filter(Boolean)
      const messages = lines.map((l) => {
        try { const e = JSON.parse(l); return e } catch { return null }
      }).filter(Boolean).map((e) => e.message || e).filter((m) => m && m.role)
      return json(res, 200, { success: true, data: { messages } })
    }

    // 新建会话
    if (p === "/api/session/new" && req.method === "POST") {
      const a = await ensureAgent()
      const file = path.join(sessionsDir(), `chat-${Date.now()}.jsonl`)
      fs.mkdirSync(sessionsDir(), { recursive: true })
      fs.writeFileSync(file, "")
      // 重建会话：直接复用当前（简化：记录新文件路径）
      return json(res, 200, { success: true, data: { path: file } })
    }

    // 会话列表
    if (p === "/api/sessions" && req.method === "GET") {
      const files = listSessionFiles()
      const sessions = files.map((f) => {
        const full = path.join(sessionsDir(), f)
        let title = f
        try {
          const lines = fs.readFileSync(full, "utf8").split("\n").filter(Boolean)
          for (const l of lines) {
            const e = JSON.parse(l)
            const m = e.message
            if (m?.role === "user") {
              const t = Array.isArray(m.content) ? m.content.map((c) => c.text || "").join("") : String(m.content || "")
              if (t) { title = t.slice(0, 40); break }
            }
          }
        } catch { /* 忽略 */ }
        return { path: full, name: title, time: fs.statSync(full).mtimeMs }
      })
      return json(res, 200, { success: true, data: sessions })
    }

    // 删除会话
    if (p === "/api/session/delete" && req.method === "POST") {
      const { path: file } = await readBody(req)
      try { if (file && fs.existsSync(file)) fs.unlinkSync(file) } catch { /* 忽略 */ }
      return json(res, 200, { success: true })
    }

    // ── 兼容旧前端辅助 API（返回空结构，保证 UI 完整可用）──

    // SAP 状态（简化为工具可用性）
    if (p === "/api/sap-status") {
      return json(res, 200, { status: "ok", connected: true, ts: Date.now() })
    }

    // output 目录文件树（精简：扫描 output 目录或空）
    if (p === "/api/output-tree") {
      return json(res, 200, { success: true, data: { root: "output", items: [] } })
    }
    if (p.startsWith("/api/output-files/")) {
      return json(res, 404, { error: "not found" })
    }
    if (p === "/api/open-location" && req.method === "POST") {
      return json(res, 200, { ok: true })
    }

    // 设置
    if (p === "/api/settings") {
      const { loadSettings } = await import(pathToFileURL(path.join(ROOT, "src", "agent-core.mjs")).href)
      const s = loadSettings()
      return json(res, 200, { success: true, data: { defaultProvider: s.defaultProvider ?? "deepseek", defaultModel: s.defaultModel ?? "deepseek-v4-flash" } })
    }

    // 模型列表
    if (p === "/api/models") {
      return json(res, 200, { success: true, data: [] })
    }

    // MCP 配置（方案 C 无 MCP，返回空）
    if (p === "/api/mcp") {
      return json(res, 200, { success: true, data: { servers: [] } })
    }

    // Memory / Skills（返回空）
    if (p === "/api/memory") {
      if (req.method === "POST") return json(res, 200, { success: true })
      return json(res, 200, { success: true, data: "" })
    }
    if (p === "/api/skills") {
      if (req.method === "POST") return json(res, 200, { success: true })
      return json(res, 200, { success: true, data: [] })
    }

    // 静态资源
    let pathname = decodeURIComponent(url.pathname)
    if (pathname === "/") pathname = "/index.html"
    const file = path.join(PUBLIC_DIR, pathname)
    if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: "Forbidden" })
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end("Not Found") }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" })
      res.end(data)
    })
  } catch (e) {
    json(res, 500, { error: e.message })
  }
})

server.listen(PORT, HOST, () => {
  console.log(`\n  🚀 AbapBuddy Web 版已启动`)
  console.log(`  📍 http://${HOST}:${PORT}\n`)
})
