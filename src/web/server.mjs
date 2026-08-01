/**
 * SapBuddy Web Server — 本地 Web 版（完整 API）
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
const USER_PI = path.join(process.cwd(), ".pi")
const OUTPUT_DIR = path.join(process.cwd(), "output")

const portArg = process.argv.indexOf("--port")
const PORT = portArg >= 0 ? Number(process.argv[portArg + 1]) : 7400
const HOST = "127.0.0.1"

/** MCP 服务器状态缓存（POST 保存时更新，GET 轮询复用） */
let mcpStatusCache = null

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

/** 切换会话：销毁旧会话，重建到指定文件 */
async function rebuildAgent(sessionFile) {
  try { await session?.dispose() } catch {}
  agent = null
  session = null
  const { createAgent } = await import(pathToFileURL(path.join(ROOT, "src", "agent-core.mjs")).href)
  agent = await createAgent({ sessionFile })
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
const sessionsDir = () => path.join(USER_PI, "sessions")

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
function isEmptySession(file) {
  if (!file || !fs.existsSync(file)) return true
  try { return readSessionMessages(file).length === 0 } catch { return false }
}

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
      try {
        const before = session?.agent?.state?.messages?.length ?? 0
        await session?.compact()
        const after = session?.agent?.state?.messages?.length ?? 0
        const saved = Math.max(0, before - after)
        broadcast({ kind: "compress_result", saved, ts: Date.now() })
        return json(res, 200, { success: true, saved })
      } catch (e) {
        const msg = String(e?.message || e)
        if (msg.includes("Nothing to compact")) {
          // 保留最近 20000 tokens，超出部分才可压缩；对话太短时给出提示
          const conv = (session?.agent?.state?.messages ?? []).reduce((a, m) => a + (m.usage?.input ?? 0) + (m.usage?.output ?? 0), 0)
          return json(res, 200, {
            success: false,
            error: `对话内容太少（约 ${conv} tokens），无法压缩。需超过 20000 tokens（约 3-4 万字对话）才有可压缩的历史。`,
          })
        }
        if (msg.includes("Already compacted")) {
          return json(res, 200, { success: false, error: "本段对话已压缩过，请继续对话后再压缩。" })
        }
        return json(res, 500, { error: e.message })
      }
    }
    if (p === "/api/thinking-level" && req.method === "POST") {
      const { level } = await readBody(req)
      try { session?.setThinkingLevel(level) } catch {}
      return json(res, 200, { success: true, thinkingLevel: level })
    }

    // 上下文统计（3s 缓存，避免每次悬浮重复读文件估算 tokens）
    let ctxStatsCache = { ts: 0, body: null }
    if (p === "/api/context-stats" && req.method === "GET") {
      if (Date.now() - ctxStatsCache.ts < 3000 && ctxStatsCache.body) {
        // 对话消息数变化时仍需刷新：消息数不一致则重算
        const msgsNow = session?.agent?.state?.messages?.length ?? 0
        if (ctxStatsCache.msgs === msgsNow) return json(res, 200, ctxStatsCache.body)
      }
      const msgs = session?.agent?.state?.messages ?? []
      const usage = msgs.reduce((a, m) => ({ input: a.input + (m.usage?.input ?? 0), output: a.output + (m.usage?.output ?? 0) }), { input: 0, output: 0 })
      const t = (txt) => Math.max(1, Math.ceil(String(txt ?? "").length / 3))
      let agents = 0, systemMd = 0, memory = 0, skills = 0
      try { agents = t(fs.readFileSync(path.join(ROOT, "AGENTS.md"), "utf8")) } catch {}
      try { systemMd = t(fs.readFileSync(path.join(ROOT, "SYSTEM.md"), "utf8")) } catch {}
      try { memory = t(fs.readFileSync(memoryFile, "utf8")) } catch { try { memory = t(fs.readFileSync(path.join(ROOT, "Memory.md"), "utf8")) } catch {} }
      try { for (const base of [skillsDir, path.join(ROOT, ".pi", "skills")]) { for (const f of fs.readdirSync(base, { recursive: true })) if (String(f).endsWith(".md")) skills += t(fs.readFileSync(path.join(base, String(f)), "utf8")) } } catch {}
      const piAgent = 1500
      const extensions = 8000
      const mcp = 0
      const conversation = usage.input + usage.output
      let cfg = {}
      try { cfg = JSON.parse(fs.readFileSync(settingsFile, "utf8").toString()) } catch {}
      const max0 = cfg.contextTokens ?? 200000
      const max = Number(max0) || 200000
      const total = piAgent + extensions + mcp + agents + systemMd + memory + skills + conversation
      const pct = Math.min(999, Math.round(total / max * 100))
      const cache = 0
      const statsBody = { success: true, data: {
        usage, messageCount: msgs.length,
        total, max, pct, remaining: Math.max(0, max - total),
        cache, pctCache: 0,
        piAgent, extensions, mcp, agents, systemMd, memory, skills, conversation,
        pctPiAgent: Math.round(piAgent / max * 100), pctExtensions: Math.round(extensions / max * 100), pctMcp: 0,
        pctAgents: Math.round(agents / max * 100), pctSystemMd: Math.round(systemMd / max * 100), pctMemory: Math.round(memory / max * 100), pctSkills: Math.round(skills / max * 100), pctConv: Math.round(conversation / max * 100),
      } }
      ctxStatsCache = { ts: Date.now(), body: statsBody, msgs: msgs.length }
      return json(res, 200, statsBody)
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

    // 新建会话（真正创建新会话文件 + 重建 agent，避免数据叠加）
    if (p === "/api/session/new" && req.method === "POST") {
      const curFile = session?.sessionFile
      const dir = sessionsDir()
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `chat-${Date.now()}.jsonl`)
      fs.writeFileSync(file, "")
      await rebuildAgent(file)
      // 旧会话是空会话 → 重建（已释放句柄）后删除，避免残留 chat-xxx.jsonl
      if (curFile && curFile !== file && isEmptySession(curFile)) {
        try { fs.unlinkSync(curFile); console.log("[session] 已删除空会话", curFile) } catch (e) { console.error("[session] 删除空会话失败", curFile, e.code) }
      }
      return json(res, 200, { success: true, data: { path: file, sessionId: session?.sessionId, gen: Date.now() } })
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
            const title = firstUser ? (Array.isArray(firstUser.content) ? firstUser.content.map((c) => c.text || "").join("").slice(0, 40) : String(firstUser.content || "").slice(0, 40)) : ""
            list.push({ path: full, name: title || "新会话", time: fs.statSync(full).mtimeMs, messageCount: msgs.length, modified: fs.statSync(full).mtimeMs, firstMessage: title || "新会话" })
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

    // 切换会话（重建 agent 到指定历史文件）
    if (p === "/api/session/switch" && req.method === "POST") {
      const { path: file } = await readBody(req)
      if (!file || !fs.existsSync(file)) return json(res, 400, { error: "会话文件不存在" })
      // 当前会话是空会话（无消息）→ 重建（已释放句柄）后自动删除，避免残留 chat-xxx.jsonl
      const curFile = session?.sessionFile
      try {
        await rebuildAgent(file)
        if (curFile && curFile !== file && isEmptySession(curFile)) {
          try { fs.unlinkSync(curFile); console.log("[session] 已删除空会话", curFile) } catch (e) { console.error("[session] 删除空会话失败", curFile, e.code) }
        }
        return json(res, 200, { success: true, data: { path: file, gen: Date.now() } })
      } catch (e) {
        return json(res, 500, { error: e.message })
      }
    }

    // ── SAP 状态（真实检测）──
    if (p === "/api/sap-status" && req.method === "GET") {
      // 服务端 15s 超时：避免 ADT 120s 挂死导致状态检测卡住
      // settled 标志：race 双方只允许一方响应（防止 ERR_HTTP_HEADERS_SENT 崩溃）
      let settled = false
      const sendOnce = (responder) => {
        if (settled) return
        settled = true
        responder()
      }
      const done = Promise.race([
        (async () => {
          try {
            const { getClient, getClientCategory } = await import(pathToFileURL(path.join(ROOT, "dist", "sap-tools", "adtManager.js")).href)
            const { getConfig } = await import(pathToFileURL(path.join(ROOT, "dist", "sap-tools", "config.js")).href)
            const conn = getConfig().connections[0]
            if (!conn) return sendOnce(() => json(res, 200, { success: false, error: "未配置 SAP 连接" }))
            const client = await getClient(conn.id)
            await client.runQuery("SELECT MANDT FROM T000", 1, true)
            // 客户端类别（T000.CCCATEGORY：P=生产 T=测试 C=定制(开发) D=演示 E=培训/教育 S=SAP参考）
            let category = "", categoryLabel = ""
            try {
              category = await getClientCategory(conn.id)
              const { CLIENT_CATEGORY_LABELS } = await import(pathToFileURL(path.join(ROOT, "dist", "sap-tools", "adtManager.js")).href)
              categoryLabel = CLIENT_CATEGORY_LABELS?.[category] ?? `未知(${category || "未维护"})`
            } catch {}
            return sendOnce(() => json(res, 200, { success: true, data: { sid: conn.id, user: conn.username, host: conn.url, client: conn.client, clientCategory: category, clientCategoryLabel: categoryLabel } }))
          } catch (e) {
            return sendOnce(() => json(res, 200, { success: false, error: e.message }))
          }
        })(),
        new Promise((resolve) => {
          const t = setTimeout(() => {
            clearTimeout(t)
            // 超时后清连接池，避免 pending 连接阻塞后续请求
            import(pathToFileURL(path.join(ROOT, "dist", "sap-tools", "adtManager.js")).href)
              .then((m) => m.dropAllClients())
              .catch(() => undefined)
              .finally(() => sendOnce(() => json(res, 200, { success: false, error: "连接超时（15 秒）" })))
          }, 15000)
        }),
      ])
      await done
      return
    }

    // ── 产物 output/ ──
    if (p === "/api/output-tree" && req.method === "GET") {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true })
      return json(res, 200, { success: true, data: { tree: scanTree(OUTPUT_DIR, "") } })
    }
    if (p.startsWith("/api/output-files/")) {
      const qIdx = p.indexOf("?")
      const name = decodeURIComponent((qIdx >= 0 ? p.slice(0, qIdx) : p).slice("/api/output-files/".length))
      const file = path.join(OUTPUT_DIR, name)
      if (!file.startsWith(OUTPUT_DIR)) return json(res, 403, { error: "Forbidden" })
      if (!fs.existsSync(file)) return json(res, 200, { success: false, error: "文件不存在" })
      // raw 模式：直接返回文件内容（HTML 预览/下载用）
      if (url.searchParams.get("raw") || url.searchParams.get("download")) {
        const data = fs.readFileSync(file)
        const ext = path.extname(file).toLowerCase()
        res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Content-Length": data.length })
        res.end(data)
        return
      }
      // 默认模式：直接返回文件原始内容（文本预览/HTML frame 都可用）
      const data = fs.readFileSync(file)
      const ext = path.extname(file).toLowerCase()
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Content-Length": data.length })
      res.end(data)
      return
    }
    if (p === "/api/open-location" && req.method === "POST") {
      const b = await readBody(req)
      const name = b.path || b.name || ""
      let target = name
      if (!path.isAbsolute(target)) target = path.join(OUTPUT_DIR, name)
      try {
        const dir = fs.statSync(target).isDirectory() ? target : path.dirname(target)
        if (!dir) return json(res, 200, { success: false, error: "文件不存在" })
        const { spawn } = await import("node:child_process")
        if (process.platform === "win32") spawn("explorer", [dir], { detached: true, stdio: "ignore" })
        else if (process.platform === "darwin") spawn("open", [dir], { detached: true, stdio: "ignore" })
        else spawn("xdg-open", [dir], { detached: true, stdio: "ignore" })
        return json(res, 200, { success: true })
      } catch (e) {
        return json(res, 200, { success: false, error: e.message })
      }
    }

    // ── 设置 / 模型 / Memory / Skills ──
    const settingsFile = path.join(USER_PI, "settings.json")
    if (p === "/api/settings" && req.method === "GET") {
      try {
        const cfg = JSON.parse(fs.readFileSync(settingsFile, "utf8"))
        let apiKey = ""
        try {
          const auth = JSON.parse(fs.readFileSync(path.join(ROOT, ".pi", "auth.json"), "utf8"))
          const k = Object.values(auth).find((v) => v?.type === "api_key" && v.key)
          apiKey = k?.key ?? ""
        } catch {}
        return json(res, 200, {
          success: true,
          data: {
            provider: cfg.defaultProvider ?? "deepseek",
            model: cfg.defaultModel ?? "",
            apiKey,
            contextTokens: cfg.contextTokens ?? 200000,
            thinkingLevel: cfg.defaultThinkingLevel ?? "off",
          },
        })
      } catch { return json(res, 200, { success: true, data: {} }) }
    }
    if (p === "/api/settings" && req.method === "POST") {
      const body = await readBody(req)
      try {
        const cur = JSON.parse(fs.readFileSync(settingsFile, "utf8"))
        const next = { ...cur }
        if (body.provider) next.defaultProvider = body.provider
        if (body.model) next.defaultModel = body.model
        if (body.contextTokens) next.contextTokens = Number(body.contextTokens)
        if (body.thinkingLevel) next.defaultThinkingLevel = body.thinkingLevel
        fs.writeFileSync(settingsFile, JSON.stringify(next, null, 2))
        if (body.apiKey) {
          const authFile = path.join(ROOT, ".pi", "auth.json")
          const auth = fs.existsSync(authFile) ? JSON.parse(fs.readFileSync(authFile, "utf8")) : {}
          auth[next.defaultProvider ?? "deepseek"] = { type: "api_key", key: body.apiKey }
          fs.writeFileSync(authFile, JSON.stringify(auth, null, 2))
        }
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
const ids = models.map((m) => m.id)
        return json(res, 200, { success: true, models: ids })
      } catch (e) {
        return json(res, 200, { success: true, models: [] })
      }
    }
    const memoryFile = path.join(USER_PI, "memory.md")
    if (p === "/api/memory" && req.method === "GET") {
      for (const f of [memoryFile, path.join(ROOT, "Memory.md")]) {
        try { return json(res, 200, { success: true, data: { content: fs.readFileSync(f, "utf8"), path: f } }) } catch { /* 继续 */ }
      }
      return json(res, 200, { success: true, data: { content: "", path: memoryFile } })
    }
    if (p === "/api/memory" && req.method === "POST") {
      const { content } = await readBody(req)
      try { fs.writeFileSync(memoryFile, content ?? ""); return json(res, 200, { success: true }) }
      catch (e) { return json(res, 500, { error: e.message }) }
    }
    // ── MCP（方案 C 已直接集成 42 工具，返回空配置）──
    if (p === "/api/mcp") {
      const { loadMcpServers, saveMcpServers, testServer } = await import(pathToFileURL(path.join(ROOT, "src", "web", "mcp-client.mjs")).href)
      if (req.method === "POST") {
        const body = await readBody(req)
        const servers = (body && (body.mcpServers ?? body.config ?? body)) || {}
        saveMcpServers(servers)
        // 连接测试（并行）
        const status = await Promise.all(
          Object.entries(servers)
            .filter(([, s]) => s && s.url)
            .map(([n, s]) => testServer(n, s))
        )
        mcpStatusCache = status
        // 配置变化 → 重建 agent（MCP 工具动态注册生效）
        try { await rebuildAgent(session?.sessionFile) } catch {}
        return json(res, 200, { success: true, config: servers, status })
      }
      // GET：读配置 + 状态缓存（无缓存且配置非空时惰性测一次）
      const servers = loadMcpServers()
      if (!mcpStatusCache && Object.keys(servers).length > 0) {
        try {
          mcpStatusCache = await Promise.all(Object.entries(servers).map(([n, s]) => testServer(n, s)))
        } catch {}
      }
      return json(res, 200, { success: true, config: servers, status: mcpStatusCache ?? [] })
    }

    // ── Prompts（提示词）──
    const promptsDir = path.join(USER_PI, "prompts")
    if (p === "/api/prompt" && req.method === "GET") {
      const file = url.searchParams.get("file") || "AGENTS.md"
      const candidates = [path.join(ROOT, file), path.join(promptsDir, file), path.join(ROOT, ".pi", "prompts", file), path.join(ROOT, ".pi", "skills", file)]
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
    const connFile = path.join(process.cwd(), "connections.json")
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
        // 重置配置缓存 + ADT 连接池，使新配置立即生效
        try {
          const { reloadConfig } = await import(pathToFileURL(path.join(ROOT, "dist", "sap-tools", "config.js")).href)
          reloadConfig()
        } catch {}
        try {
          const { dropAllClients } = await import(pathToFileURL(path.join(ROOT, "dist", "sap-tools", "adtManager.js")).href)
          await dropAllClients()
        } catch {}
        return json(res, 200, { success: true })
      } catch (e) { return json(res, 500, { error: e.message }) }
    }

    const skillsDir = path.join(USER_PI, "skills")
    if (p === "/api/skills" && req.method === "GET") {
      const file = url.searchParams.get("file")
      if (file) {
        try { return json(res, 200, { success: true, data: { content: fs.readFileSync(path.join(skillsDir, file), "utf8"), path: path.join(skillsDir, file) } }) }
        catch { return json(res, 200, { success: true, data: { content: "", path: path.join(skillsDir, file) } }) }
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
  console.log(`\n  🚀 SapBuddy Web 版已启动`)
  console.log(`  📍 http://${HOST}:${PORT}\n`)
})
