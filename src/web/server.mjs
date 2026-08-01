/**
 * AbapBuddy Web Server — 本地 Web 版（完整 API）
 *
 * 启动: node src/web/server.mjs [--port 7400]
 * API:
 *   GET  /api/events          SSE 事件流（agent 原始事件）
 *   POST /api/chat            { text } → 触发 agent 对话
 *   POST /api/abort           停止当前生成
 *   POST /api/compress        压缩上下文
 *   GET  /api/state           会话状态（模型/流式/消息数等）
 *   GET  /api/tools           42 个工具清单
 *   GET  /api/history         会话消息历史
 *   GET  /api/sessions        会话列表
 *   POST /api/session/new     新建会话
 *   POST /api/session/delete  删除会话
 *   POST /api/thinking-level  { level }
 *   GET  /api/context-stats   上下文统计
 *   GET  /api/sap-status      SAP 连接状态（真实检测）
 *   GET  /api/output-tree     产物 output/ 文件树
 *   GET  /api/output-files/*  读取产物文件
 *   GET  /api/settings        读写 .pi/settings.json
 *   GET  /api/models          模型列表
 *   GET  /api/memory          读写 Memory
 *   GET  /api/skills          Skills 列表与读写
 */
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..", "..")
const PUBLIC_DIR = path.join(HERE, "public")
const OUTPUT_DIR = path.join(ROOT, "output")

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

function attachStreaming(s) {
  s.subscribe((event) => {
    if (event.type === "message_end" && event.message?.role === "assistant") {
      // 落盘会话文件已由 SessionManager 自动处理
    }
    broadcast({ kind: "agent", event, ts: Date.now() })
  })
  s.subscribe((event) => { if (event.type === "agent_end") busy = false })
}

// ─── SSE ────────────────────────────────────────────────────────────────────
const sseClients = new Set()
function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`
  for (const res of sseClients) {
    try { res.write(data) } catch { sseClients.delete(res) }
  }
}

// ─── 工具函数 ───────────────────────────────────────────────────────────────
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(obj))
}
function readBody(req) {
  return new Promise((resolve) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")) } catch { resolve({}) } })
  })
}
const sessionsDir = () => path.join(ROOT, ".pi", "sessions")

/** 递归扫描目录为前端树结构 */
function scanTree(dir, rel) {
  let items = []
  try {
    items = fs.readdirSync(dir, { withFileTypes: true })
  } catch { return [] }
  return items
    .filter((d) => !d.name.startsWith("."))
    .map((d) => {
      const full = path.join(dir, d.name)
      const p = rel ? `${rel}/${d.name}` : d.name
      if (d.isDirectory()) {
        return { type: "dir", name: d.name, path: p, children: scanTree(full, p) }
      }
      return { type: "file", name: d.name, path: p }
    })
}

/** 读取会话文件的 user/assistant 消息 */
function readSessionMessages(file) {
  if (!file || !fs.existsSync(file)) return []
  const msgs = []
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
    for (const l of lines) {
      try {
        const e = JSON.parse(l)
        const m = e.message
        if (m && m.role && (m.role === "user" || m.role === "assistant")) msgs.push(m)
      } catch { /* 忽略坏行 */ }
    }
  } catch { /* 忽略 */ }
  return msgs
}

// ─── HTTP ───────────────────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
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
      if (!text?.trim()) return json(res, 400, { error: "text 不能为空" })
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

    // 停止 / 压缩 / 思考级别
    if (p === "/api/abort") { try { await session?.abort() } catch {} busy = false; return json(res, 200, { ok: true }) }
    if (p === "/api/compress" && req.method === "POST") {
      try { await session?.compact(); broadcast({ kind: "compress_result", ts: Date.now() }); return json(res, 200, { ok: true }) }
      catch (e) { return json(res, 500, { error: e.message }) }
    }
    if (p === "/api/thinking-level" && req.method === "POST") {
      const { level } = await readBody(req)
      try { session?.setThinkingLevel(level) } catch {}
      return json(res, 200, { ok: true })
    }

    // 上下文统计
    if (p === "/api/context-stats" && req.method === "GET") {
      const msgs = session?.agent?.state?.messages ?? []
      const usage = msgs.reduce((a, m) => ({ input: a.input + (m.usage?.input ?? 0), output: a.output + (m.usage?.output ?? 0) }), { input: 0, output: 0 })
      return json(res, 200, { success: true, data: { usage, messageCount: msgs.length } })
    }

    // 会话状态（status.js 契约）
    if (p === "/api/state" && req.method === "GET") {
      const a = agent
      const model = a?.session?.model
      return json(res, 200, {
        success: true,
        data: {
          ready: !!session,
          isStreaming: busy,
          messageCount: session?.agent?.state?.messages?.length ?? 0,
          model: model ? `${model.provider}/${model.id}` : "-",
          sessionId: session?.sessionId ?? "",
          sessionLabel: session?.sessionFile ? path.basename(session.sessionFile) : "新对话",
          configStatus: "ok",
          thinkingLevel: session?.thinkingLevel ?? "off",
          ts: Date.now(),
        },
      })
    }

    // 工具列表
    if (p === "/api/tools" && req.method === "GET") {
      const { listToolNames } = await import(pathToFileURL(path.join(ROOT, "dist", "sap-tools", "register.js")).href)
      return json(res, 200, listToolNames())
    }

    // 会话历史
    if (p === "/api/history" && req.method === "GET") {
      const file = url.searchParams.get("path") || session?.sessionFile
      return json(res, 200, { success: true, data: { messages: readSessionMessages(file) } })
    }

    // 新建会话（持久化）
    if (p === "/api/session/new" && req.method === "POST") {
      const a = await ensureAgent()
      // 当前会话已由 SessionManager.create 持久化；新建 = 记录前端路径
      const f = a.session.sessionFile
      return json(res, 200, { success: true, data: { path: f, sessionId: a.session.sessionId } })
    }

    // 会话列表
    if (p === "/api/sessions" && req.method === "GET") {
      const dir = sessionsDir()
      const list = []
      if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
          const full = path.join(dir, f)
          try {
            const msgs = readSessionMessages(full)
            const firstUser = msgs.find((m) => m.role === "user")
            const title = firstUser ? (Array.isArray(firstUser.content) ? firstUser.content.map((c) => c.text || "").join("").slice(0, 40) : String(firstUser.content || "").slice(0, 40)) : f
            list.push({ path: full, name: title || f, time: fs.statSync(full).mtimeMs })
          } catch { /* 忽略 */ }
        }
      }
      list.sort((a, b) => b.time - a.time)
      return json(res, 200, { success: true, data: { sessions: list.map((s) => ({ ...s, modified: s.time, firstMessage: s.name, current: false })) } })
    }

    // 删除会话
    if (p === "/api/session/delete" && req.method === "POST") {
      const { path: file } = await readBody(req)
      try { if (file && fs.existsSync(file)) fs.unlinkSync(file) } catch {}
      return json(res, 200, { success: true })
    }

    // ── SAP 状态（真实检测）──
    if (p === "/api/sap-status" && req.method === "GET") {
      try {
        const { getClient } = await import(pathToFileURL(path.join(ROOT, "dist", "sap-tools", "adtManager.js")).href)
        const { getConfig } = await import(pathToFileURL(path.join(ROOT, "dist", "sap-tools", "config.js")).href)
        const conn = getConfig().connections[0]
        if (!conn) return json(res, 200, { success: false, error: "未配置 SAP 连接" })
        const client = await getClient(conn.id)
        await client.runQuery("SELECT MANDT FROM T000", 1, true)
        return json(res, 200, { success: true, data: { sid: conn.id, user: conn.username, host: conn.url, client: conn.client } })
      } catch (e) {
        return json(res, 200, { success: false, error: e.message })
      }
    }

    // ── 产物 output/ ──
    if (p === "/api/output-tree" && req.method === "GET") {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true })
      return json(res, 200, { success: true, data: { tree: scanTree(OUTPUT_DIR, "") } })
    }
    if (p.startsWith("/api/output-files/")) {
      const name = decodeURIComponent(p.slice("/api/output-files/".length))
      const file = path.join(OUTPUT_DIR, name)
      if (!file.startsWith(OUTPUT_DIR)) return json(res, 403, { error: "Forbidden" })
      try {
        const data = fs.readFileSync(file, "utf8")
        return json(res, 200, { success: true, data: { name, content: data } })
      } catch {
        return json(res, 200, { success: false, error: "文件不存在" })
      }
    }
    if (p === "/api/open-location" && req.method === "POST") {
      return json(res, 200, { ok: true })
    }

    // ── 设置 / 模型 / Memory / Skills ──
    const settingsFile = path.join(ROOT, ".pi", "settings.json")
    if (p === "/api/settings" && req.method === "GET") {
      try { return json(res, 200, { success: true, data: JSON.parse(fs.readFileSync(settingsFile, "utf8")) }) }
      catch { return json(res, 200, { success: true, data: {} }) }
    }
    if (p === "/api/settings" && req.method === "POST") {
      const body = await readBody(req)
      try {
        const cur = JSON.parse(fs.readFileSync(settingsFile, "utf8"))
        fs.writeFileSync(settingsFile, JSON.stringify({ ...cur, ...body }, null, 2))
        return json(res, 200, { success: true })
      } catch (e) { return json(res, 500, { error: e.message }) }
    }
    if (p === "/api/models" && req.method === "GET") {
      try {
        const sdk = await import(pathToFileURL(path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")).href)
        const mr = await sdk.ModelRuntime.create({ authPath: path.join(ROOT, ".pi", "auth.json"), modelsPath: path.join(ROOT, ".pi", "models.json") })
        const provider = url.searchParams.get("provider")
        const available = await mr.getAvailable()
        const models = available.filter((m) => !provider || m.provider === provider)
const flat = models.map((m) => ({ provider: m.provider, id: m.id, name: m.name ?? m.id }))
        return json(res, 200, { success: true, models: flat })
      } catch (e) {
        return json(res, 200, { success: true, models: [] })
      }
    }
    const memoryFile = path.join(ROOT, ".pi", "memory.md")
    if (p === "/api/memory" && req.method === "GET") {
      try { return json(res, 200, { success: true, data: { content: fs.readFileSync(memoryFile, "utf8") } }) }
      catch { return json(res, 200, { success: true, data: { content: "" } }) }
    }
    if (p === "/api/memory" && req.method === "POST") {
      const { content } = await readBody(req)
      try { fs.writeFileSync(memoryFile, content ?? ""); return json(res, 200, { success: true }) }
      catch (e) { return json(res, 500, { error: e.message }) }
    }
    // ── Prompts（提示词）──
    const promptsDir = path.join(ROOT, ".pi", "prompts")
    if (p === "/api/prompt" && req.method === "GET") {
      const file = url.searchParams.get("file") || "AGENTS.md"
      const candidates = [path.join(ROOT, file), path.join(promptsDir, file), path.join(ROOT, ".pi", "skills", file)]
      for (const c of candidates) {
        if (fs.existsSync(c)) return json(res, 200, { success: true, data: { content: fs.readFileSync(c, "utf8"), path: c } })
      }
      return json(res, 200, { success: true, data: { content: "", path: file } })
    }
    if (p === "/api/prompt" && req.method === "POST") {
      const { file, content } = await readBody(req)
      try {
        const target = path.join(promptsDir, file || "")
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, content ?? "")
        return json(res, 200, { success: true, data: { path: target } })
      } catch (e) { return json(res, 500, { error: e.message }) }
    }

    // ── SAP 连接配置（connections.json 读写）──
    const connFile = path.join(ROOT, "connections.json")
    if (p === "/api/sap-config" && req.method === "GET") {
      try {
        const conf = JSON.parse(fs.readFileSync(connFile, "utf8"))
        const c = conf.connections?.[0] ?? {}
        const u = new URL(c.url ?? "https://localhost:44300")
        return json(res, 200, {
          success: true,
          data: {
            host: u.hostname, port: u.port || "44300", protocol: u.protocol.replace(":", ""),
            user: c.username, client: c.client, readOnly: conf.security?.readOnly ?? true,
          },
        })
      } catch {
        return json(res, 200, { success: true, data: { host: "", port: "44300", protocol: "https", user: "", client: "100", readOnly: true } })
      }
    }
    if (p === "/api/sap-config" && req.method === "POST") {
      const b = await readBody(req)
      try {
        const existing = fs.existsSync(connFile) ? JSON.parse(fs.readFileSync(connFile, "utf8")) : { connections: [], security: {} }
        const port = b.port || "44300"
        existing.connections = [{
          id: "dev",
          url: `${b.protocol || "https"}://${b.host}:${port}`,
          client: b.client || "100",
          username: b.user || "",
          password: b.password ?? existing.connections?.[0]?.password ?? "",
          language: "ZH",
          authMethod: "basic",
          ssl: { allowSelfSigned: true },
        }]
        existing.security = { ...(existing.security ?? {}), readOnly: !!b.readOnly }
        fs.writeFileSync(connFile, JSON.stringify(existing, null, 2))
        return json(res, 200, { success: true })
      } catch (e) { return json(res, 500, { error: e.message }) }
    }

    const skillsDir = path.join(ROOT, ".pi", "skills")
    if (p === "/api/skills" && req.method === "GET") {
      const file = url.searchParams.get("file")
      if (file) {
        try { return json(res, 200, { success: true, data: { content: fs.readFileSync(path.join(skillsDir, file), "utf8") } }) }
        catch { return json(res, 200, { success: true, data: { content: "" } }) }
      }
      try {
        const dirs = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory())
        return json(res, 200, { success: true, data: { tree: dirs.map((d) => ({ type: "dir", name: d.name, path: d.name, children: [{ type: "file", name: "SKILL.md", path: d.name + "/SKILL.md" }] })) } })
      } catch {
        return json(res, 200, { success: true, data: [] })
      }
    }
    if (p === "/api/skills" && req.method === "POST") {
      const { file, content } = await readBody(req)
      try {
        const target = path.join(skillsDir, file || "")
        if (!target.startsWith(skillsDir)) return json(res, 403, { error: "Forbidden" })
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, content ?? "")
        return json(res, 200, { success: true })
      } catch (e) { return json(res, 500, { error: e.message }) }
    }

    // ── 静态资源 ──
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
