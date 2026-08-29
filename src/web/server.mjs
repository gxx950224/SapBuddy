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
 *   GET  /api/tools           41 个工具清单
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
import os from "node:os"
import { spawn } from "node:child_process"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..", "..")
const PUBLIC_DIR = path.join(HERE, "public")
const USER_PI = path.join(os.homedir(), ".SapBuddy")
const OUTPUT_DIR = path.join(USER_PI, "output")

const portArg = process.argv.indexOf("--port")
const PORT = portArg >= 0 ? Number(process.argv[portArg + 1]) : 7400
const HOST = "127.0.0.1"
const START_TS = Date.now() // 静态资源版本号（重启变化，强制刷新缓存）

// 当前运行版本（读包内 package.json；"一键更新" 的比较基准）
const CURRENT_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version || "unknown" } catch { return "unknown" }
})()

// 逐段数值比较 "x.y.z"；任一非数字/未知 → 不判定有更新
function compareVersions(a, b) {
  const pa = String(a || "").split(".").map((n) => Number(n))
  const pb = String(b || "").split(".").map((n) => Number(n))
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** 一键更新在跑（防重入） */
let updating = false

/** 上次一键更新失败的提示（启动时从 update-result.json 读到，检查更新接口带回并清除） */
let lastUpdateError = null

/** MCP 服务器状态缓存（POST 保存时更新，GET 轮询复用） */
let mcpStatusCache = null

/** 工具定义实际 token 估算（启动时算一次，替代硬编码 8000）
 * zod 对象 JSON 约 38KB → 紧凑 JSON Schema 约 15.3KB（×0.4）→ /3.5 ≈ token */
let EXT_TOKENS = 8000
try {
  const { tools } = await import(pathToFileURL(path.join(ROOT, "dist", "sap-tools", "tools", "index.js")).href)
  const schemaChars = tools.reduce((a, t) => a + JSON.stringify(t.inputSchema || {}).length, 0)
  const descChars = tools.reduce((a, t) => a + String(t.description || "").length + String(t.title || "").length, 0)
  EXT_TOKENS = Math.max(1000, Math.round(schemaChars * 0.4 / 3.5 + descChars / 3.5))
} catch { /* 保持 8000 */ }

/** pi SDK 懒加载（对话占用用 buildSessionContext/estimateTokens 做真实估算） */
let _sdkModule = null
async function loadPiSdk() {
  if (!_sdkModule) {
    _sdkModule = await import(pathToFileURL(path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")).href)
  }
  return _sdkModule
}

// ─── Agent 会话 ────────────────────────────────────────────────────────────
let agent = null
let session = null
let busy = false
let rebuildPromise = null  // 在途重建任务（新建/切换懒重建，防并发双开 agent）

async function ensureAgent() {
  // 有后台重建在途 → 等它完成（新建/切换后立即发消息的场景）
  if (rebuildPromise) return rebuildPromise
  if (agent) return agent
  const { createAgent } = await import(pathToFileURL(path.join(ROOT, "src", "agent-core.mjs")).href)
  // 启动后首次对话：默认新建会话（不自动续最近历史会话；用户主动点历史会话才切换）
  agent = await createAgent()
  session = agent.session
  attachStreaming(session)
  return agent
}

/** 重建 agent 到指定会话文件。懒重建：新建/切换时后台触发，发消息时才真正等待完成。
 *  重复调用自动去重（目标相同的重建只跑一次；目标不同的等当前完成后再重建）。 */
async function rebuildAgent(sessionFile) {
  if (rebuildPromise) {
    const inFlight = rebuildPromise
    await inFlight.catch(() => {})
    if (session && path.resolve(session.sessionFile) === path.resolve(sessionFile)) return agent
  }
  rebuildPromise = (async () => {
    const oldSession = session
    const oldFile = oldSession?.sessionFile
    agent = null
    session = null
    try { await oldSession?.dispose() } catch {}
    // 旧会话是空会话（无任何消息）→ 顺手删掉，避免列表残留「新会话」空条目
    if (oldFile && path.resolve(oldFile) !== path.resolve(sessionFile) && isEmptySession(oldFile)) {
      try { fs.unlinkSync(oldFile); console.log("[session] 已删除空会话", oldFile) } catch {}
    }
    // 会话切换时清除写授权窗口，避免旧会话的批准残留到新会话
    try {
      const r = await import(pathToFileURL(path.join(ROOT, "dist", "sap-tools", "register.js")).href)
      r.clearWriteApproval?.()
    } catch { /* 忽略 */ }
    const { createAgent } = await import(pathToFileURL(path.join(ROOT, "src", "agent-core.mjs")).href)
    agent = await createAgent({ sessionFile })
    session = agent.session
    attachStreaming(session)
    return agent
  })()
  try { return await rebuildPromise } finally { rebuildPromise = null }
}

// 大模型配置变更 → 重建当前会话 agent（保留会话历史，改用新配置的模型）。
// agent 未创建时跳过（下次创建自然用新配置）；重建失败不影响保存成功。
function maybeRebuildAgent(oldProvider, oldModel, newProvider, newModel) {
  if (oldProvider === newProvider && oldModel === newModel) return
  if (!session?.sessionFile) return
  rebuildAgent(session.sessionFile).catch(() => {})
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

/** 边界安全校验：target 必须严格位于 dir 内（或等于 dir），防 startsWith 弱前缀绕过（如 output-other） */
function isWithinDir(target, dir) {
  const t = path.resolve(String(target || ""))
  const d = path.resolve(String(dir || ""))
  return t === d || t.startsWith(d + path.sep)
}

/** 用户消息是否"可见"（前端口径：有文本或带图片块）。用于截断/删除时与前端计数对齐，避免图片消息被漏算 */
function userMsgVisible(m) {
  if (!m || m.role !== "user") return false
  const blocks = Array.isArray(m.content) ? m.content : []
  const text = blocks.map((c) => (c.type === "text" ? c.text || "" : "")).join("")
  const hasImage = blocks.some((c) => c.type === "image" && c.data && c.mimeType)
  return !!(text || hasImage)
}

/** 可选访问令牌：connections.json 的 security.apiKey（配置后所有 POST /api/* 需 Bearer/x-api-key） */
function loadApiKey() {
  try {
    const conf = JSON.parse(fs.readFileSync(path.join(USER_PI, "connections.json"), "utf8"))
    return (conf.security?.apiKey || "").trim() || null
  } catch { return null }
}

/** 清理空会话（仅初始化条目、无对话消息的 jsonl）——避免列表出现无意义的「新会话」 */
function cleanEmptySessions() {
  try {
    const dir = sessionsDir()
    if (!fs.existsSync(dir)) return
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue
      const full = path.join(dir, f)
      try {
        let hasMsg = false
        for (const line of fs.readFileSync(full, "utf8").split(String.fromCharCode(10))) {
          if (!line.trim()) continue
          const e = JSON.parse(line)
          const r = e?.message?.role
          if (r === "user" || r === "assistant") { hasMsg = true; break }
        }
        if (!hasMsg) { fs.unlinkSync(full); console.log(`[sapbuddy] 已清理空会话: ${f}`) }
      } catch { /* 损坏文件忽略 */ }
    }
  } catch { /* 忽略 */ }
}

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
        if (m && m.role && (m.role === "user" || m.role === "assistant" || m.role === "toolResult")) msgs.push(m)
      } catch { /* 忽略坏行 */ }
    }
  } catch { /* 忽略 */ }
  return msgs
}

// 统计会话中"用户实际看到"的消息条数（与前端 renderMessageList 口径一致）：
// 元数据行（session/model_change/thinking_level_change）与 toolResult 不计气泡；
// 连续多条 assistant 消息合并成一个气泡只算 1 条；空内容 assistant 消息跳过；
// 无文本且无图片块的 user 消息也跳过但不影响后续 assistant 连续段合并。
function countVisibleMessages(lines) {
  let count = 0
  let prevAssistant = false
  for (const l of lines) {
    let e
    try { e = JSON.parse(l) } catch { continue }
    const m = e.message
    if (!m || !m.role) continue
    if (m.role === "user") {
      prevAssistant = false
      if (userMsgVisible(m)) count++
    } else if (m.role === "assistant") {
      const empty = !m.content || (Array.isArray(m.content) && m.content.length === 0)
      if (empty) continue
      if (!prevAssistant) count++
      prevAssistant = true
    }
    // toolResult：不生成气泡，也不打断 assistant 连续段（与渲染器一致）
  }
  return count
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
    // ── 安全：CSRF/跨站来源校验（只信任本机页面，防远程网页篡改本地服务）──
    const origin = req.headers.origin
    if (origin && !["http://127.0.0.1:" + PORT, "http://localhost:" + PORT, "http://127.0.0.1", "http://localhost"].includes(origin)) {
      return json(res, 403, { error: "Forbidden: 来源不被信任（仅允许本机页面访问）" })
    }
    // 写操作接口：本机浏览器外（如外部工具）默认拒绝非本机来源
    if (req.method === "POST" && req.headers["user-agent"]?.includes("Mozilla") && !origin) {
      // 浏览器同源 POST 必带 Origin；无 Origin 的浏览器 POST 视为异常
      return json(res, 403, { error: "Forbidden: 缺少来源标识" })
    }
    // 可选访问令牌：security.apiKey 配置后，所有写操作（POST /api/*）需 Bearer / x-api-key
    const apiKey = loadApiKey()
    if (apiKey && req.method === "POST" && p.startsWith("/api/")) {
      const auth = String(req.headers.authorization || "")
      const got = (auth.startsWith("Bearer ") ? auth.slice(7) : "") || String(req.headers["x-api-key"] || "")
      if (got.trim() !== apiKey) {
        return json(res, 401, { error: "未授权：此实例已开启 API Key。请携带 Authorization: Bearer <key> 或 x-api-key 请求头。" })
      }
    }
    // 安全状态（前端据此判断是否需要提示输入 Key；无需鉴权）
    if (p === "/api/security-status" && req.method === "GET") {
      return json(res, 200, { required: !!apiKey })
    }
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
      const { text, images } = await readBody(req)
      // 图片消息允许无文本（纯发截图）
      const imgs = Array.isArray(images)
        ? images.filter((i) => i && typeof i.data === "string" && typeof i.mimeType === "string" && i.data.length <= 14 * 1024 * 1024)
        : []
      if (!text?.trim() && imgs.length === 0) return json(res, 400, { error: "text 不能为空" })
      if (busy) return json(res, 409, { error: "上一轮仍在处理中" })
      busy = true
      json(res, 200, { ok: true, ts: Date.now() })
      try {
        const r = await import(pathToFileURL(path.join(ROOT, "dist", "sap-tools", "register.js")).href)
        // 授权窗口：确认词/拒绝词统一处理（与扩展层 before_agent_start 同规则）
        if (text?.trim()) r.handleUserMessage?.(text.trim())
        const a = await ensureAgent()
        // 不自动切换模型：尊重用户手动选择的模型。发图时若当前模型不支持看图，
        // pi 会把图片降级占位（模型回复会体现看不到图），用户可在设置里主动换支持图片的模型。
        if (imgs.length > 0) {
          await a.session.prompt(text?.trim() ?? "", {
            images: imgs.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType })),
          })
        } else {
          await a.session.prompt(text.trim())
        }
      } catch (e) {
        const msg = String(e?.message || e)
        // 停止后旧操作仍在收尾（网络异常最长 120s）时发消息会命中 SDK 并发保护，翻译成大白话
        const friendly = msg.includes("already processing")
          ? "上一轮操作还在收尾（网络异常时最多等 2 分钟自动结束），请稍候再发。"
          : msg
        broadcast({ kind: "error", error: friendly, ts: Date.now() })
      } finally {
        busy = false
        broadcast({ kind: "agent", event: { type: "agent_settled" }, ts: Date.now() })
      }
      return
    }

    // 停止 / 压缩 / 思考级别
    // 停止：不阻塞等 agent 空闲。session.abort() 内部要等当前操作真正结束才 resolve，
    // SAP 请求挂起（VPN 断等，最长 120s）时干等下去前端就是"点了没反应"。
    // 改为：先触发中止信号 + 立即广播终态事件清 UI，后台继续等超时自动收尾。
    if (p === "/api/abort") {
      busy = false
      try {
        const ap = session?.abort?.()
        if (ap && typeof ap.then === "function") ap.catch(() => {})
      } catch { /* 无活动会话忽略 */ }
      broadcast({ kind: "agent", event: { type: "agent_abort" }, ts: Date.now() })
      return json(res, 200, { ok: true })
    }

    // 写操作确认：用户点击允许/拒绝后，注入批准窗口并提示 AI 继续
    if (p === "/api/write-approve" && req.method === "POST") {
      const { approved } = await readBody(req)
      if (busy) return json(res, 409, { error: "上一轮仍在处理中" })
      busy = true
      json(res, 200, { ok: true })
      try {
        const r = await import(pathToFileURL(path.join(ROOT, "dist", "sap-tools", "register.js")).href)
        if (approved) r.setWriteApprovalWindow() // 60 秒批准窗口：AI 重放写工具放行
        const a = await ensureAgent()
        await a.session.prompt(
          approved
            ? "用户已在界面确认允许执行本次写操作，请继续完成（重试刚才被拦截的写工具调用）。"
            : "用户拒绝执行本次写操作。请先向用户询问具体修改需求：希望调整哪些内容（功能、字段、界面、逻辑等）？有哪些更详细的要求或变更点？在获得用户明确的修改意见之前，不要执行新的写操作，也不要直接生成替代方案。请用简洁的问题引导用户说明。",
        )
      } catch (e) {
        const msg = String(e?.message || e)
        const friendly = msg.includes("already processing")
          ? "上一轮操作还在收尾（网络异常时最多等 2 分钟自动结束），请稍候再试。"
          : msg
        broadcast({ kind: "error", error: friendly, ts: Date.now() })
      } finally {
        busy = false
      }
      return
    }
    if (p === "/api/compress" && req.method === "POST") {
      try {
        const sm = session?.sessionManager
        const countTokens = async () => {
          if (!sm) return 0
          try {
            const sdk = await loadPiSdk()
            const ctx = sdk.buildSessionContext(sm.getEntries())
            return ctx.messages.reduce((a, m) => a + sdk.estimateTokens(m), 0)
          } catch { return 0 }
        }
        const before = session?.agent?.state?.messages?.length ?? 0
        const tokensBefore = await countTokens()
        await session?.compact()
        const after = session?.agent?.state?.messages?.length ?? 0
        const tokensAfter = await countTokens()
        const saved = Math.max(0, before - after)
        const tokensSaved = Math.max(0, tokensBefore - tokensAfter)
        broadcast({ kind: "compress_result", saved, tokensSaved, ts: Date.now() })
        return json(res, 200, { success: true, saved, tokensSaved })
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
      // 历史累计消耗（input/output 含重复计数的历史输入，仅作参考；当前占用看 conversation）
      const usage = msgs.reduce((a, m) => ({ input: a.input + (m.usage?.input ?? 0), output: a.output + (m.usage?.output ?? 0) }), { input: 0, output: 0 })
      const t = (txt) => Math.max(1, Math.ceil(String(txt ?? "").length / 3))
      let agents = 0, systemMd = 0, memory = 0, skills = 0
      const readPrompt = (name) => { try { return t(fs.readFileSync(path.join(USER_PI, "prompts", name), "utf8")) } catch { try { return t(fs.readFileSync(path.join(ROOT, name), "utf8")) } catch { return 0 } } }
      try { agents = readPrompt("AGENTS.md") } catch {}
      try { systemMd = readPrompt("SYSTEM.md") } catch {}
      // 记忆：用户真实记忆（主目录优先，回退项目根）
      try { memory = t(fs.readFileSync(path.join(USER_PI, "prompts", "Memory.md"), "utf8")) } catch { try { memory = t(fs.readFileSync(path.join(ROOT, "Memory.md"), "utf8")) } catch {} }
      // 技能：只统计各技能目录的 SKILL.md（框架实际注入上下文的部分），用户目录优先，同名去重
      {
        const seen = new Set()
        for (const base of [path.join(USER_PI, "skills"), path.join(ROOT, "defaults", "skills")]) {
          let names = []
          try { names = fs.readdirSync(base).filter((x) => { try { return fs.statSync(path.join(base, x)).isDirectory() } catch { return false } }) } catch { continue }
          for (const name of names) {
            if (seen.has(name)) continue
            seen.add(name)
            try { skills += t(fs.readFileSync(path.join(base, name, "SKILL.md"), "utf8")) } catch {}
          }
        }
      }
      // MCP 工具占用：注册时累计的 schema 估算
      let mcp = 0
      try {
        const { getMcpTokensEstimate } = await import(pathToFileURL(path.join(ROOT, "src", "sap-tools", "mcp-register.mjs")).href)
        mcp = getMcpTokensEstimate()
      } catch { /* 未注册则 0 */ }
      // 对话占用：当前可见消息的真实 token 估算（非 usage 累加，避免历史重复计数虚高）
      let conversation = 0
      try {
        const sm = agent?.session?.sessionManager
        if (sm) {
          const sdk = await loadPiSdk()
          const ctx = sdk.buildSessionContext(sm.getEntries())
          conversation = ctx.messages.reduce((a, m) => a + sdk.estimateTokens(m), 0)
        }
      } catch { /* 会话未就绪则 0 */ }
      const piAgent = 1500
      const extensions = EXT_TOKENS
      // 设置读取（主目录优先 → 项目根 .SapBuddy 兼容旧版）
      let cfg = {}
      for (const f of [path.join(USER_PI, "settings.json"), path.join(ROOT, ".SapBuddy", "settings.json")]) {
        try { cfg = JSON.parse(fs.readFileSync(f, "utf8").toString()); break } catch { /* 继续 */ }
      }
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
      let model = a?.session?.model
      // agent 未创建/正在重建时回退显示设置里的模型，让底部状态实时反映当前配置
      if (!model) {
        try {
          const cfg = JSON.parse(fs.readFileSync(path.join(USER_PI, "settings.json"), "utf8"))
          model = { provider: cfg.defaultProvider ?? "deepseek", id: cfg.defaultModel ?? "deepseek-v4-flash" }
        } catch {}
      }
      // ready：服务在线即就绪（agent 懒创建，首次对话才建；连接一次成功即绿灯常驻）
      return json(res, 200, {
        success: true,
        data: {
          ready: true,
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
      if (!isWithinDir(file, sessionsDir())) return json(res, 403, { error: "Forbidden: 仅允许读取会话文件" })
      return json(res, 200, { success: true, data: { path: file, messages: readSessionMessages(file) } })
    }

    // 新建会话（真正创建新会话文件 + 重建 agent，避免数据叠加）
    if (p === "/api/session/new" && req.method === "POST") {
      const dir = sessionsDir()
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `chat-${Date.now()}.jsonl`)
      fs.writeFileSync(file, "")
      // 懒重建：后台重建 agent（约 10s），立即返回不卡 UI；首条消息时若未就绪再等
      rebuildAgent(file).catch((err) => console.error("[session] agent 重建失败", err.message))
      return json(res, 200, { success: true, data: { path: file, sessionId: "", gen: Date.now() } })
    }

    // 会话列表
    if (p === "/api/sessions" && req.method === "GET") {
      const dir = sessionsDir()
      const list = []
      if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
          const full = path.join(dir, f)
          try {
            // 读全文：消息数需精确统计（元数据行/toolResult 不计、连续 assistant 合并成一个气泡），
            // 会话文件通常在几百 KB 内，本地读取开销可忽略；标题取首条 user 消息，自定义名取末尾 session_info。
            const lines = fs.readFileSync(full, "utf8").split("\n").filter(Boolean)
            const messageCount = countVisibleMessages(lines)
            const firstUserLine = lines.find((l) => l.includes('"role":"user"'))
            let title = ""
            if (firstUserLine) {
              try {
                const m = JSON.parse(firstUserLine).message
                title = (m?.content ?? []).map((c) => c.text || "").join("").slice(0, 40)
              } catch { /* 忽略坏行 */ }
            }
            // 自定义名称（session_info 事件，pi /name、Ctrl+R 同机制）；新名字 append 在文件末尾，取最后一条
            let customName = ""
            try {
              const line = lines.filter((l) => l.includes('"type":"session_info"')).pop()
              if (line) { const i = JSON.parse(line); customName = (i.name || "").trim() }
            } catch { /* 忽略 */ }
            list.push({ path: full, name: customName || title || "新会话", time: fs.statSync(full).mtimeMs, messageCount, modified: fs.statSync(full).mtimeMs, firstMessage: title || "新会话" })
          } catch { /* 忽略 */ }
        }
      }
      list.sort((a, b) => b.time - a.time)
      return json(res, 200, { success: true, data: { sessions: list.map((s) => ({ ...s, modified: s.time, firstMessage: s.name, current: false })) } })
    }

    // 删除会话
    if (p === "/api/session/delete" && req.method === "POST") {
      const { path: file } = await readBody(req)
      // 安全：仅允许删除会话目录内的文件（防任意文件删除）
      if (!isWithinDir(file, sessionsDir())) return json(res, 403, { error: "Forbidden: 仅允许删除会话文件" })
      try { if (file && fs.existsSync(file)) fs.unlinkSync(file) } catch {}
      return json(res, 200, { success: true })
    }

    // 重命名会话（写 session_info 事件，与 pi 的 /name、Ctrl+R 同一机制，CLI/Web 共享）
    if (p === "/api/session/rename" && req.method === "POST") {
      const { path: file, name } = await readBody(req)
      if (!file || !fs.existsSync(file)) return json(res, 400, { error: "会话文件不存在" })
      if (!isWithinDir(file, sessionsDir())) return json(res, 403, { error: "Forbidden: 仅允许重命名会话文件" })
      try {
        const { SessionManager } = await import("@earendil-works/pi-coding-agent")
        const sm = await SessionManager.open(file)
        sm.appendSessionInfo(String(name || "").replace(/[\r\n]+/g, " ").trim().slice(0, 100))
        return json(res, 200, { success: true })
      } catch (e) {
        return json(res, 500, { error: e.message })
      }
    }

    // 切换会话（重建 agent 到指定历史文件）
    if (p === "/api/session/switch" && req.method === "POST") {
      const { path: file } = await readBody(req)
      if (!file || !fs.existsSync(file)) return json(res, 400, { error: "会话文件不存在" })
      if (!isWithinDir(file, sessionsDir())) return json(res, 403, { error: "Forbidden: 仅允许切换会话文件" })
      // 懒重建：后台重建 agent 到目标文件，立即返回不阻塞 UI；发消息时再等待完成
      rebuildAgent(file).catch((err) => console.error("[session] agent 重建失败", err.message))
      return json(res, 200, { success: true, data: { path: file, gen: Date.now() } })
    }

    // 截断会话：保留前 N 条用户消息，删除其后所有内容（用于编辑重发/重新生成）
    if (p === "/api/session/truncate" && req.method === "POST") {
      const { path: file, keepUserCount } = await readBody(req)
      if (!file || !fs.existsSync(file)) return json(res, 400, { error: "会话文件不存在" })
      if (!isWithinDir(file, sessionsDir())) return json(res, 403, { error: "Forbidden: 仅允许操作会话文件" })
      const keep = Math.max(0, parseInt(keepUserCount) || 0)
      try {
        const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
        let userCount = 0
        const keepLines = []
        for (const l of lines) {
          let e
          try { e = JSON.parse(l) } catch { keepLines.push(l); continue }
          const m = e.message
          if (userMsgVisible(m)) {
            // 与前端计数口径一致：有文本或图片块的用户消息才计数
            if (userCount >= keep) break
            userCount++
          }
          keepLines.push(l)
        }
        fs.writeFileSync(file, keepLines.length ? keepLines.join("\n") + "\n" : "")
        // 重建 agent（历史已变）
        rebuildAgent(file).catch((err) => console.error("[truncate] agent 重建失败", err.message))
        return json(res, 200, { success: true, keptLines: keepLines.length, keptUsers: userCount })
      } catch (e) {
        return json(res, 500, { error: e.message })
      }
    }

    // 删除指定对话对（用户消息 + 其后的AI回复/工具调用，直到下一条用户消息）
    if (p === "/api/session/delete-messages" && req.method === "POST") {
      const { path: file, userIndices } = await readBody(req)
      if (!file || !fs.existsSync(file)) return json(res, 400, { error: "会话文件不存在" })
      if (!isWithinDir(file, sessionsDir())) return json(res, 403, { error: "Forbidden: 仅允许操作会话文件" })
      const toDelete = new Set((userIndices || []).map((i) => parseInt(i)).filter((i) => !isNaN(i) && i >= 0))
      if (toDelete.size === 0) return json(res, 400, { error: "未指定要删除的对话" })
      try {
        const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
        let userCount = 0
        let deleting = false
        const keepLines = []
        for (const l of lines) {
          let e
          try { e = JSON.parse(l) } catch { keepLines.push(l); continue }
          const m = e.message
          if (userMsgVisible(m)) {
            // 与前端计数口径一致：有文本或图片块的用户消息才计数
            deleting = toDelete.has(userCount)
            userCount++
          }
          if (!deleting) keepLines.push(l)
        }
        fs.writeFileSync(file, keepLines.length ? keepLines.join("\n") + "\n" : "")
        // 重建 agent（历史已变）
        rebuildAgent(file).catch((err) => console.error("[delete-messages] agent 重建失败", err.message))
        return json(res, 200, { success: true, deletedPairs: toDelete.size, keptLines: keepLines.length })
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
            const { getClient, getClientCategory, withConnMutex } = await import(pathToFileURL(path.join(ROOT, "dist", "sap-tools", "adtManager.js")).href)
            const { getConfig, activeConnectionId } = await import(pathToFileURL(path.join(ROOT, "dist", "sap-tools", "config.js")).href)
            let conn
            try { conn = getConfig().connections.find((c) => c.id === activeConnectionId()) } catch {}
            if (!conn) return sendOnce(() => json(res, 200, { success: false, error: "未配置 SAP 连接" }))
            // 与工具调用共用同一连接：加互斥锁，避免状态检测与正在执行的工具踩踏共享客户端
            await withConnMutex(conn.id, async () => {
              const client = await getClient(conn.id)
              await client.runQuery("SELECT MANDT FROM T000", 1, true)
            })
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

    // ── 文件上传（用户附件，AI 用 read 读取）──
    if (p === "/api/upload" && req.method === "POST") {
      const { name, content, base64 } = await readBody(req)
      try {
        if (typeof name !== "string" || typeof content !== "string") return json(res, 400, { error: "参数错误" })
        const clean = path.basename(String(name).replace(/[\\/]/g, "/")).replace(/[^\w.\-\u4e00-\u9fa5]/g, "_").slice(0, 80)
        if (!clean) return json(res, 400, { error: "文件名无效" })
        const buf = base64 ? Buffer.from(content, "base64") : Buffer.from(content, "utf8")
        if (buf.length > 20 * 1024 * 1024) return json(res, 400, { error: "文件超过 20MB" })
        const dir = path.join(USER_PI, "uploads")
        fs.mkdirSync(dir, { recursive: true })
        const file = path.join(dir, clean)
        fs.writeFileSync(file, buf)
        // Office 文件（docx/xlsx/pptx）：提取文本供 AI 读取
        let readPath = file
        let isOffice = false
        if (/\.(docx|xlsx|pptx)$/i.test(clean)) {
          try {
            const { extractOfficeText } = await import(pathToFileURL(path.join(ROOT, "src", "web", "office.mjs")).href)
            const ext = extractOfficeText(buf, clean)
            if (ext && ext.text) {
              const txtFile = path.join(dir, clean + ".txt")
              fs.writeFileSync(txtFile, ext.text, "utf8")
              readPath = txtFile
              isOffice = true
            }
          } catch (e) { /* 提取失败则保留原文件 */ }
        }
        return json(res, 200, { success: true, path: readPath, name: clean, isOffice })
      } catch (e) { return json(res, 500, { error: e.message }) }
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
      if (!isWithinDir(file, OUTPUT_DIR)) return json(res, 403, { error: "Forbidden" })
      if (!fs.existsSync(file)) return json(res, 200, { success: false, error: "文件不存在" })
      const data = fs.readFileSync(file)
      const ext = path.extname(file).toLowerCase()
      const headers = { "Content-Type": MIME[ext] || "application/octet-stream", "Content-Length": data.length }
      if (ext === ".html") {
        // 防存储型 XSS：本地 origin 提供的报告类 HTML 一律加 CSP（禁外连/禁表单/禁脚本外发），
        // 即使报告内嵌了用户可控文本 <script>，也无法调用本地 API 或外发数据
        headers["Content-Security-Policy"] =
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; form-action 'none'"
        headers["X-Content-Type-Options"] = "nosniff"
      }
      if (url.searchParams.get("download")) headers["Content-Disposition"] = `attachment; filename="${path.basename(file)}"`
      res.writeHead(200, headers)
      res.end(data)
      return
    }
    if (p === "/api/open-location" && req.method === "POST") {
      const b = await readBody(req)
      const name = b.path || b.name || ""
      let target = name
      if (!path.isAbsolute(target)) target = path.join(OUTPUT_DIR, name)
      // 安全：仅允许打开产物目录/主目录配置/项目目录内的位置（防任意目录访问）
      const resolved = path.resolve(target)
      const allowedRoots = [path.resolve(OUTPUT_DIR), path.resolve(USER_PI), path.resolve(ROOT)]
      if (!allowedRoots.some((r) => resolved === r || resolved.startsWith(r + path.sep))) {
        return json(res, 403, { error: "Forbidden: 仅允许打开 ~/.SapBuddy 或项目目录内的位置" })
      }
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
          const auth = JSON.parse(fs.readFileSync(path.join(USER_PI, "auth.json"), "utf8"))
          const provider = cfg.defaultProvider ?? "deepseek"
          apiKey = auth[provider]?.key ?? ""
        } catch {}
        // 全部提供商（内置 + 自定义）及各自的模型列表，供前端下拉
        let providers = []
        try {
          const models = JSON.parse(fs.readFileSync(path.join(USER_PI, "models.json"), "utf8"))
          let auth2 = {}
          try { auth2 = JSON.parse(fs.readFileSync(path.join(USER_PI, "auth.json"), "utf8")) } catch {}
          providers = Object.entries(models.providers || {}).map(([name, c]) => ({
            name,
            baseUrl: c?.baseUrl ?? "",
            hasKey: Boolean(auth2[name]?.key && auth2[name].key !== "请输入你的API_KEY"),
            key: auth2[name]?.key ?? "",
            models: (c?.models || []).map((m) => (typeof m === "object" && m ? m.id : m)).filter(Boolean),
          }))
        } catch {}
        return json(res, 200, {
          success: true,
          data: {
            provider: cfg.defaultProvider ?? "deepseek",
            model: cfg.defaultModel ?? "",
            apiKey,
            contextTokens: cfg.contextTokens ?? 200000,
            thinkingLevel: cfg.defaultThinkingLevel ?? "off",
            providers,
          },
        })
      } catch { return json(res, 200, { success: true, data: {} }) }
    }
    if (p === "/api/settings" && req.method === "POST") {
      const body = await readBody(req)
      try {
        const cur = JSON.parse(fs.readFileSync(settingsFile, "utf8"))
        // ── 编辑已有大模型连接（可改名 / 改地址 / 改模型 / 改 Key）──
        if (body.editProvider) {
          const oldName = String(body.editProvider).trim()
          const modelsFile = path.join(USER_PI, "models.json")
          const modelsCfg = fs.existsSync(modelsFile) ? JSON.parse(fs.readFileSync(modelsFile, "utf8")) : {}
          if (!modelsCfg.providers) modelsCfg.providers = {}
          const oldCfg = modelsCfg.providers[oldName]
          if (!oldCfg) return json(res, 400, { error: `提供商「${oldName}」不存在` })
          const name = String(body.providerName ?? oldName).trim()
          const baseUrl = String(body.baseUrl ?? oldCfg.baseUrl ?? "").trim()
          const rawModels = Array.isArray(body.models)
            ? body.models
            : (oldCfg.models || []).map((m) => (typeof m === "object" && m ? m.id : m))
          const modelIds = rawModels.map((m) => {
            if (m && typeof m === "object") return String(m.id ?? "").trim()
            return String(m ?? "").trim()
          }).filter(Boolean)
          if (!name || /\s/.test(name)) return json(res, 400, { error: "提供商名称不能为空且不能含空格" })
          if (!baseUrl) return json(res, 400, { error: "请填写 API 地址" })
          if (modelIds.length === 0) return json(res, 400, { error: "至少填写一个模型名称" })
          if (name !== oldName && modelsCfg.providers[name]) return json(res, 400, { error: `提供商「${name}」已存在` })
          // 每个模型对象：保留已有字段（name/reasoning/contextWindow/maxTokens）并默认支持图片
          const oldModels = (oldCfg.models || []).filter((m) => m && typeof m === "object")
          const models = modelIds.map((id) => {
            const existing = oldModels.find((om) => om.id === id)
            return { ...(existing || {}), id, input: ["text", "image"] }
          })
          // 写配置：改名时删旧建新，否则原地覆盖
          if (name !== oldName) delete modelsCfg.providers[oldName]
          modelsCfg.providers[name] = { baseUrl, api: "openai-completions", models }
          fs.writeFileSync(modelsFile, JSON.stringify(modelsCfg, null, 2))
          // Key：非空则更新；改名时把旧 key 迁到新名
          const key = String(body.apiKey ?? "").trim()
          const authFile = path.join(USER_PI, "auth.json")
          const auth = fs.existsSync(authFile) ? JSON.parse(fs.readFileSync(authFile, "utf8")) : {}
          if (name !== oldName && auth[oldName]) {
            auth[name] = auth[oldName]
            delete auth[oldName]
          }
          if (key) auth[name] = { type: "api_key", key }
          fs.writeFileSync(authFile, JSON.stringify(auth, null, 2))
          // 编辑的正是当前默认提供商 → 同步默认值（改名或模型列表变化时）
          const next2 = { ...cur }
          if (cur.defaultProvider === oldName) {
            next2.defaultProvider = name
            next2.defaultModel = modelIds.includes(cur.defaultModel) ? cur.defaultModel : modelIds[0]
          }
          fs.writeFileSync(settingsFile, JSON.stringify(next2, null, 2))
          maybeRebuildAgent(cur.defaultProvider, cur.defaultModel, next2.defaultProvider, next2.defaultModel)
          return json(res, 200, { success: true, provider: name, model: next2.defaultModel ?? modelIds[0] })
        }
        // ── 新增自定义大模型连接 ──
        if (body.providerName) {
          const name = String(body.providerName).trim()
          const baseUrl = String(body.baseUrl ?? "").trim()
          const modelIds = (Array.isArray(body.models) ? body.models : []).map((m) => {
            if (m && typeof m === "object") return String(m.id ?? "").trim()
            return String(m ?? "").trim()
          }).filter(Boolean)
          if (!name || /\s/.test(name)) return json(res, 400, { error: "提供商名称不能为空且不能含空格" })
          if (!baseUrl) return json(res, 400, { error: "请填写 API 地址" })
          if (modelIds.length === 0) return json(res, 400, { error: "至少填写一个模型名称" })
          const modelsFile = path.join(USER_PI, "models.json")
          const modelsCfg = fs.existsSync(modelsFile) ? JSON.parse(fs.readFileSync(modelsFile, "utf8")) : {}
          if (!modelsCfg.providers) modelsCfg.providers = {}
          if (modelsCfg.providers[name]) return json(res, 400, { error: `提供商「${name}」已存在` })
          // 新增模型默认支持图片（input:["text","image"]）
          const models = modelIds.map((id) => ({ id, input: ["text", "image"] }))
          modelsCfg.providers[name] = { baseUrl, api: "openai-completions", models }
          fs.writeFileSync(modelsFile, JSON.stringify(modelsCfg, null, 2))
          const key = String(body.apiKey ?? "").trim()
          if (key) {
            const authFile = path.join(USER_PI, "auth.json")
            const auth = fs.existsSync(authFile) ? JSON.parse(fs.readFileSync(authFile, "utf8")) : {}
            auth[name] = { type: "api_key", key }
            fs.writeFileSync(authFile, JSON.stringify(auth, null, 2))
          }
          const next2 = { ...cur, defaultProvider: name, defaultModel: modelIds[0] }
          fs.writeFileSync(settingsFile, JSON.stringify(next2, null, 2))
          maybeRebuildAgent(cur.defaultProvider, cur.defaultModel, name, modelIds[0])
          return json(res, 200, { success: true, provider: name, model: modelIds[0] })
        }
        const next = { ...cur }
        if (body.provider) next.defaultProvider = body.provider
        if (body.model) next.defaultModel = body.model
        if (body.contextTokens) next.contextTokens = Number(body.contextTokens)
        if (body.thinkingLevel) next.defaultThinkingLevel = body.thinkingLevel
        fs.writeFileSync(settingsFile, JSON.stringify(next, null, 2))
        if (body.apiKey) {
          const authFile = path.join(USER_PI, "auth.json")
          const auth = fs.existsSync(authFile) ? JSON.parse(fs.readFileSync(authFile, "utf8")) : {}
          auth[next.defaultProvider ?? "deepseek"] = { type: "api_key", key: body.apiKey }
          fs.writeFileSync(authFile, JSON.stringify(auth, null, 2))
        }
        maybeRebuildAgent(cur.defaultProvider, cur.defaultModel, next.defaultProvider, next.defaultModel)
        return json(res, 200, { success: true })
      } catch (e) { return json(res, 500, { error: e.message }) }
    }
    // ── 更新：检查 + 一键更新（更新成功自动重启服务，新进程加载新代码）──
    if (p === "/api/update/check" && req.method === "GET") {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8000)
      try {
        const r = await fetch("https://registry.npmjs.org/sapbuddy/latest", { signal: controller.signal })
        const j = await r.json()
        const latest = String(j?.version || "").trim()
        const out = { success: true, current: CURRENT_VERSION, latest, hasUpdate: latest ? compareVersions(CURRENT_VERSION, latest) < 0 : false }
        // 上次一键更新失败 → 带提示回界面（只带一次）
        if (lastUpdateError) { out.lastUpdateError = lastUpdateError; lastUpdateError = null }
        return json(res, 200, out)
      } catch (e) {
        const msg = e?.name === "AbortError" ? "检查超时，请确认本机网络可访问 npm 仓库" : `无法连接 npm 仓库：${e?.message || e}`
        return json(res, 200, { success: false, error: msg })
      } finally { clearTimeout(timer) }
    }
    if (p === "/api/update/apply" && req.method === "POST") {
      if (updating) return json(res, 409, { error: "正在更新中，请稍候" })
      updating = true
      // 立即返回（旧程序马上要退出，HTTP 响应不能等更新跑完）
      json(res, 200, { success: true, started: true })
      broadcast({
        kind: "update",
        status: "restarting",
        line: "正在更新：旧程序将自动退出，安装完成后自动重新打开（约半分钟，请稍候）",
      })
      // 根因：旧进程正在运行，加载着全局安装目录里的文件，Windows 上这些文件被锁死，
      // 直接 npm install 覆盖必报 EBUSY（4294963214），且这种持久锁重试治不了。
      // 解法：旧进程先退出释放锁，由独立「更新代理」进程负责安装新版并重新启动。
      const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm"
      try {
        fs.mkdirSync(USER_PI, { recursive: true })
        fs.writeFileSync(path.join(USER_PI, "update-agent.mjs"), UPDATE_AGENT_SRC, "utf8")
        // 提权安装辅助脚本：普通权限装失败（EACCES，全局目录仅管理员可写）时，由代理经 UAC 以管理员运行它
        fs.writeFileSync(path.join(USER_PI, "elevate-install.mjs"), ELEVATE_INSTALL_SRC, "utf8")
        const agent = spawn(process.execPath, [path.join(USER_PI, "update-agent.mjs")], {
          detached: true, // 脱离本进程：本进程退出后它继续跑
          stdio: "ignore",
          windowsHide: true,
          cwd: USER_PI, // 代理自身放在用户目录，不在会被替换的安装目录里
          env: {
            ...process.env,
            SB_NPM: npmCmd,
            SB_SELF: path.join(HERE, "server.mjs"),
            SB_ARGS: JSON.stringify(process.argv.slice(2)),
            SB_LOG: path.join(USER_PI, "update.log"),
            SB_RESULT: path.join(USER_PI, "update-result.json"),
            SB_ELEVATE_HELPER: path.join(USER_PI, "elevate-install.mjs"),
          },
        })
        agent.unref()
      } catch (e) {
        updating = false
        broadcast({ kind: "update", status: "error", line: `无法启动更新程序：${e?.message || e}，请手动更新。` })
        return
      }
      // 给界面一点刷新时间，然后退出释放文件锁（更新代理接管后续安装与重启）
      setTimeout(() => process.exit(0), 2000)
      return
    }

    if (p === "/api/models" && req.method === "GET") {
      try {
        const sdk = await import(pathToFileURL(path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")).href)
        const mr = await sdk.ModelRuntime.create({ authPath: path.join(USER_PI, "auth.json"), modelsPath: path.join(USER_PI, "models.json") })
        const provider = url.searchParams.get("provider")
        const available = await mr.getAvailable()
        const models = available.filter((m) => !provider || m.provider === provider)
const ids = models.map((m) => m.id)
        return json(res, 200, { success: true, models: ids })
      } catch (e) {
        return json(res, 200, { success: true, models: [] })
      }
    }
    // 记忆：主目录 ~/.SapBuddy/prompts/Memory.md（首次从包内默认 seed，用户定制优先）
    const memoryFile = path.join(USER_PI, "prompts", "Memory.md")
    if (p === "/api/memory" && req.method === "GET") {
      if (!fs.existsSync(memoryFile)) {
        try { fs.mkdirSync(path.dirname(memoryFile), { recursive: true }); fs.copyFileSync(path.join(ROOT, "Memory.md"), memoryFile) } catch { /* seed 失败则返回空 */ }
      }
      try { return json(res, 200, { success: true, data: { content: fs.readFileSync(memoryFile, "utf8"), path: memoryFile } }) } catch { /* 文件不存在则返回空 */ }
      return json(res, 200, { success: true, data: { content: "", path: memoryFile } })
    }
    if (p === "/api/memory" && req.method === "POST") {
      const { content } = await readBody(req)
      try { fs.mkdirSync(path.dirname(memoryFile), { recursive: true }); fs.writeFileSync(memoryFile, content ?? ""); return json(res, 200, { success: true }) }
      catch (e) { return json(res, 500, { error: e.message }) }
    }
    // ── MCP（已直接集成 48 工具，返回空配置）──
    if (p === "/api/mcp") {
      const { loadMcpServersAll, saveMcpServers, testServer } = await import(pathToFileURL(path.join(ROOT, "src", "web", "mcp-client.mjs")).href)
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
        // 配置变化 → 清预热缓存并重新预热 + 重建 agent（MCP 工具动态注册生效）
        try {
          const mr = await import(pathToFileURL(path.join(ROOT, "src", "sap-tools", "mcp-register.mjs")).href)
          mr.resetMcpCache?.()
        } catch {}
        try { await rebuildAgent(session?.sessionFile) } catch {}
        return json(res, 200, { success: true, config: servers, status })
      }
      // GET：读配置 + 状态缓存（无缓存且配置非空时惰性测一次）
      // config 用全量读取（含 disabled），设置页需展示历史数据；status 只测可用（有 url 且未禁用）
      const servers = loadMcpServersAll()
      const active = Object.fromEntries(Object.entries(servers).filter(([, s]) => s && s.disabled !== true && s.url))
      if (!mcpStatusCache && Object.keys(active).length > 0) {
        try {
          mcpStatusCache = await Promise.all(Object.entries(active).map(([n, s]) => testServer(n, s)))
        } catch {}
      }
      return json(res, 200, { success: true, config: servers, status: mcpStatusCache ?? [] })
    }

    // ── Prompts（提示词）：主目录 ~/.SapBuddy/prompts 优先（首次从包内默认 seed），回退包内 ──
    const promptsDir = path.join(USER_PI, "prompts")
    if (p === "/api/prompt" && req.method === "GET") {
      // 安全：仅允许白名单根文件（防 ../ 路径穿越读任意文件，与 POST 同规则）
      const raw = String(url.searchParams.get("file") || "AGENTS.md")
      const base = raw.split(/[/\\]/).pop()
      const WHITELIST = ["AGENTS.md", "AGENTS.MD", "SYSTEM.md", "Memory.md", "CLAUDE.md"]
      if (!WHITELIST.includes(base)) {
        return json(res, 403, { error: "Forbidden: 仅允许读取 AGENTS.md / SYSTEM.md / Memory.md / CLAUDE.md" })
      }
      const local = path.join(promptsDir, base)
      if (!fs.existsSync(local)) {
        const srcSeed = path.join(ROOT, base)
        if (fs.existsSync(srcSeed)) { try { fs.mkdirSync(promptsDir, { recursive: true }); fs.copyFileSync(srcSeed, local) } catch { /* seed 失败忽略 */ } }
      }
      if (fs.existsSync(local)) return json(res, 200, { success: true, data: { content: fs.readFileSync(local, "utf8"), path: local } })
      return json(res, 200, { success: true, data: { content: "", path: base } })
    }
    if (p === "/api/prompt" && req.method === "POST") {
      const { file, content } = await readBody(req)
      // 安全：仅允许编辑白名单根文件（防 ../ 路径穿越写任意位置）
      const base = String(file || "").split(/[/\\]/).pop()
      const WHITELIST = ["AGENTS.md", "AGENTS.MD", "SYSTEM.md", "Memory.md", "CLAUDE.md"]
      if (!WHITELIST.includes(base)) {
        return json(res, 403, { error: "Forbidden: 仅允许编辑 AGENTS.md / SYSTEM.md / Memory.md" })
      }
      try {
        const target = path.join(promptsDir, base)
        fs.mkdirSync(promptsDir, { recursive: true })
        fs.writeFileSync(target, content ?? "")
        return json(res, 200, { success: true, data: { path: target } })
      } catch (e) { return json(res, 500, { error: e.message }) }
    }

    // ── SAP 连接配置（connections.json 读写）──
    const connFile = path.join(USER_PI, "connections.json")
    if (p === "/api/sap-config" && req.method === "GET") {
      try {
        const conf = JSON.parse(fs.readFileSync(connFile, "utf8"))
        const conns = conf.connections ?? []
        const activeIdx = conns.findIndex((c) => c.active === true)
        const list = conns.map((c, i) => {
          const u = new URL(c.url ?? "https://localhost:44300")
          return {
            id: c.id,
            name: c.name || c.id,
            host: u.hostname,
            port: u.port || "44300",
            protocol: u.protocol.replace(":", ""),
            user: c.username,
            client: c.client,
            active: activeIdx === i || (activeIdx < 0 && i === 0),
            hasPassword: !!c.password,
          }
        })
        return json(res, 200, { success: true, data: { connections: list, readOnly: conf.security?.readOnly ?? true } })
      } catch {
        return json(res, 200, { success: true, data: { connections: [], readOnly: true } })
      }
    }
    if (p === "/api/sap-config" && req.method === "POST") {
      const b = await readBody(req)
      try {
        const existing = fs.existsSync(connFile) ? JSON.parse(fs.readFileSync(connFile, "utf8")) : { connections: [], security: {} }
        const conns = existing.connections ?? []
        // 保存连接（新增/编辑）：origId 空=新增，非空=编辑该连接
        const saveConn = (c) => {
          const name = String(c.name ?? "").trim()
          const host = String(c.host ?? "").trim()
          if (!host) throw new Error("主机地址不能为空")
          if (!name) throw new Error("连接名称不能为空")
          const port = c.port || "44300"
          const url = `${c.protocol || "https"}://${host}:${port}`
          const newId = name.toLowerCase()
          const origId = String(c.origId ?? "").trim().toLowerCase()
          let idx = origId ? conns.findIndex((x) => x.id.toLowerCase() === origId) : -1
          if (idx < 0 && !origId) idx = conns.findIndex((x) => x.id.toLowerCase() === newId) // 同名幂等
          if (idx < 0) {
            if (conns.some((x) => x.id.toLowerCase() === newId)) throw new Error(`已存在名为「${name}」的连接`)
            conns.push({
              id: newId, name, url,
              client: c.client || "100",
              username: c.user ?? "",
              password: c.password ?? "",
              language: "ZH", authMethod: "basic", ssl: { allowSelfSigned: true },
            })
          } else {
            const base = conns[idx]
            conns[idx] = {
              ...base,
              id: newId, name, url,
              client: c.client || base.client || "100",
              username: c.user ?? base.username ?? "",
              password: c.password ?? base.password ?? "",
              language: base.language ?? "ZH", authMethod: base.authMethod ?? "basic",
              ssl: base.ssl ?? { allowSelfSigned: true },
            }
          }
        }
        const action = b.action || (b.host ? "save" : "")
        if (action === "save") {
          saveConn(b.connection ?? b)
          if (conns.length === 1) conns[0].active = true // 只有一条时自动作为当前
        } else if (action === "setActive") {
          const id = String(b.id ?? "").trim().toLowerCase()
          if (!conns.some((x) => x.id.toLowerCase() === id)) return json(res, 400, { error: "连接不存在" })
          conns.forEach((x) => { x.active = x.id.toLowerCase() === id })
        } else if (action === "delete") {
          const id = String(b.id ?? "").trim().toLowerCase()
          const idx = conns.findIndex((x) => x.id.toLowerCase() === id)
          if (idx < 0) return json(res, 400, { error: "连接不存在" })
          if (conns.length <= 1) return json(res, 400, { error: "至少保留一个连接" })
          const wasActive = conns[idx].active === true
          conns.splice(idx, 1)
          if (wasActive) conns.forEach((x, i) => { x.active = i === 0 })
        } else {
          return json(res, 400, { error: "未知操作" })
        }
        existing.connections = conns
        existing.security = { ...(existing.security ?? {}), readOnly: !!b.readOnly }
        fs.writeFileSync(connFile, JSON.stringify(existing, null, 2))
        // 重置配置缓存 + ADT 连接池，使新配置立即生效
        try {
          const { reloadConfig } = await import(pathToFileURL(path.join(ROOT, "dist", "sap-tools", "config.js")).href)
          reloadConfig()
        } catch {}
        try {
          const { dropAllClients, markConnectionDirty } = await import(pathToFileURL(path.join(ROOT, "dist", "sap-tools", "adtManager.js")).href)
          await dropAllClients()
          // 连接已变更：强制下一次先 get_connected_systems 重确认，再放行其他 SAP 工具
          markConnectionDirty()
        } catch {}
        return json(res, 200, { success: true })
      } catch (e) { return json(res, 500, { error: e.message }) }
    }

    const skillsDir = path.join(USER_PI, "skills")
    if (p === "/api/skills" && req.method === "GET") {
      const file = url.searchParams.get("file")
      if (file) {
        const target = path.join(skillsDir, file)
        if (!isWithinDir(target, skillsDir)) return json(res, 403, { error: "Forbidden" })
        try { return json(res, 200, { success: true, data: { content: fs.readFileSync(target, "utf8"), path: target } }) }
        catch { return json(res, 200, { success: true, data: { content: "", path: target } }) }
      }
      // 递归扫描技能目录树（支持嵌套子目录与多文件）
      function buildSkillTree(dir, relPath) {
        let entries = []
        try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
        const result = []
        for (const entry of entries) {
          if (entry.name.startsWith(".")) continue
          const fullPath = path.join(dir, entry.name)
          const childRel = relPath ? relPath + "/" + entry.name : entry.name
          if (entry.isDirectory()) {
            result.push({ type: "dir", name: entry.name, path: childRel, children: buildSkillTree(fullPath, childRel) })
          } else if (entry.isFile()) {
            result.push({ type: "file", name: entry.name, path: childRel })
          }
        }
        return result
      }
      try {
        return json(res, 200, { success: true, data: { tree: buildSkillTree(skillsDir, "") } })
      } catch {
        return json(res, 200, { success: true, data: [] })
      }
    }
    if (p === "/api/skills" && req.method === "POST") {
      const { file, content } = await readBody(req)
      try {
        const target = path.join(skillsDir, file || "")
        if (!isWithinDir(target, skillsDir)) return json(res, 403, { error: "Forbidden" })
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, content ?? "")
        return json(res, 200, { success: true })
      } catch (e) { return json(res, 500, { error: e.message }) }
    }

    // ── 静态资源 ──
    let pathname = decodeURIComponent(url.pathname)
    if (pathname === "/") pathname = "/index.html"
    // index.html 注入版本号（css/js 缓存控制）
    if (pathname === "/index.html" && url.searchParams.get("v") !== "b") {
      // 读原始文件并替换版本占位符
      try {
        const raw = fs.readFileSync(path.join(PUBLIC_DIR, pathname), "utf8")
        const html = raw.replace(/__V__/g, String(START_TS))
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" })
        return res.end(html)
      } catch { /* 落到普通静态 */ }
    }
    const file = path.join(PUBLIC_DIR, pathname)
    if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: "Forbidden" })
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end("Not Found") }
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
        "Cache-Control": "no-cache",
      })
      res.end(data)
    })
  } catch (e) {
    json(res, 500, { error: e.message })
  }
})

/**
 * 提权安装辅助脚本源码（写入 ~/.SapBuddy/elevate-install.mjs，经 UAC 以管理员权限运行）。
 * 职责：仅运行 npm install -g sapbuddy@latest 并写 update-result.json，装完即退出。
 * 应用本体仍由非提权的更新代理负责重启（保持普通权限运行，避免长期管理员权限）。
 * 注意：此脚本只依赖 node 内置模块，且不能使用反引号/模板字符串（自身是模板字符串常量）。
 */
const ELEVATE_INSTALL_SRC = `import fs from "node:fs"
import { spawn } from "node:child_process"

const NPM = process.env.SB_NPM || "npm"
const LOG = process.env.SB_LOG || "update.log"
const RESULT = process.env.SB_RESULT || "update-result.json"

function log(s) {
  try { fs.appendFileSync(LOG, new Date().toLocaleString() + " " + s + "\\n") } catch {}
}
function runInstall() {
  return new Promise((resolve) => {
    const child = spawn(NPM, ["install", "-g", "sapbuddy@latest"], { shell: process.platform === "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    child.stdout.on("data", (d) => log("  " + String(d).trim()))
    child.stderr.on("data", (d) => log("  " + String(d).trim()))
    child.on("error", (e) => { log("无法启动 npm: " + e.message); resolve(-1) })
    child.on("close", (code) => resolve(Number(code) ?? -1))
  })
}
log("=== 以管理员权限安装新版 ===")
const code = await runInstall()
const ok = code === 0
log(ok ? "✅ 管理员安装成功" : "❌ 管理员安装失败（退出码 " + code + "）")
try {
  fs.writeFileSync(RESULT, JSON.stringify({
    status: ok ? "ok" : "error",
    line: ok ? "更新完成，正在启动新版本" : "以管理员安装仍失败（退出码 " + code + "，日志见 " + LOG + "）",
    ts: Date.now(),
  }), "utf8")
} catch {}
process.exit(ok ? 0 : 1)
`

/**
 * 更新代理脚本源码（写入 ~/.SapBuddy/update-agent.mjs 后以独立进程运行）。
 * 职责：旧程序退出 → 装新版（失败自动重试，绕过杀毒瞬时锁；权限不足自动提权）→ 重新启动 SapBuddy；
 * 安装失败则恢复原版本，并把原因写入 update-result.json 供下次启动提示。
 * 注意：此脚本只依赖 node 内置模块，且不能使用反引号/模板字符串（自身是模板字符串常量）。
 */
const UPDATE_AGENT_SRC = `import fs from "node:fs"
import { spawn } from "node:child_process"

const NPM = process.env.SB_NPM || "npm"
const LOG = process.env.SB_LOG || "update.log"
const SELF = process.env.SB_SELF || ""
const RESULT = process.env.SB_RESULT || "update-result.json"
const PS = process.env.SB_PS || "powershell"
let ARGS = []
try { ARGS = JSON.parse(process.env.SB_ARGS || "[]") } catch {}

function log(s) {
  try { fs.appendFileSync(LOG, new Date().toLocaleString() + " " + s + "\\n") } catch {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function runInstall() {
  return new Promise((resolve) => {
    const child = spawn(NPM, ["install", "-g", "sapbuddy@latest"], {
      shell: process.platform === "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    child.stdout.on("data", (d) => log("  " + String(d).trim()))
    child.stderr.on("data", (d) => log("  " + String(d).trim()))
    child.on("error", (e) => { log("无法启动 npm: " + e.message); resolve(-1) })
    child.on("close", (code) => resolve(Number(code) ?? -1))
  })
}

// 关闭残留的旧 SapBuddy 进程（桌面主程序/多开的窗口/僵尸进程）——它们锁着全局安装目录，导致 npm 重命名失败(EBUSY)
function killCompanions() {
  return new Promise((resolve) => {
    const psCmd = "Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Where-Object { $_.CommandLine } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
    const child = spawn(PS, ["-NoProfile", "-NonInteractive", "-Command", psCmd], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    child.stdout.on("data", (d) => { out += d })
    child.stderr.on("data", () => {})
    child.on("error", (e) => { log("无法枚举进程: " + e.message); resolve() })
    child.on("close", () => {
      try {
        const parsed = JSON.parse(out)
        const list = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : [])
        let n = 0
        for (const p of list) {
          const pid = Number(p.ProcessId)
          const cmd = String(p.CommandLine || "").replaceAll(String.fromCharCode(92), "/").toLowerCase()
          if (!pid || pid === process.pid) continue
          const isSapbuddy = cmd.includes("node_modules/sapbuddy") || cmd.includes("/sapbuddy/cli.mjs") || cmd.includes("/sapbuddy/src/web/server.mjs")
          if (!isSapbuddy) continue
          try { process.kill(pid) } catch {}
          n++
        }
        if (n > 0) log("已关闭 " + n + " 个残留的旧 SapBuddy 进程（释放文件锁）")
      } catch { /* 解析失败忽略 */ }
      resolve()
    })
  })
}

function explain(code) {
  const n = Number(code) || 0
  const signed = n > 0x7fffffff ? n - 0x100000000 : n
  if (signed === -4082) return "安装文件被占用（残留的旧程序或杀毒软件仍锁着文件）"
  if (signed === -4092) return "没有权限写入安装目录（请右键以管理员身份运行 SapBuddy 后重试）"
  if (n === 1) return "npm 安装报错（详细日志见 ~/.SapBuddy/update.log）"
  return "安装进程退出（退出码 " + n + "）"
}

// 判断是否为权限不足（EACCES）。npm 常以退出码 1 结束、EACCES 记在日志里，两者都查
function isEaccs(code) {
  const n = Number(code) || 0
  const signed = n > 0x7fffffff ? n - 0x100000000 : n
  if (signed === -4092) return true
  try {
    const tail = fs.readFileSync(LOG, "utf8").split("\\n").slice(-40).join("\\n")
    return /EACCES|EPERM/i.test(tail)
  } catch { return false }
}

// 权限不足（全局安装目录仅管理员可写）→ 经 UAC 以管理员重跑安装。
// 仅这一步提权：应用本体仍由本代理（普通权限）负责重启，避免长期管理员运行。
// 用户取消/拒绝授权 → 提权进程没写结果文件 → 按失败处理。
function runInstallElevated() {
  return new Promise((resolve) => {
    const helper = process.env.SB_ELEVATE_HELPER || ""
    const eres = process.env.SB_RESULT || "update-result.json"
    if (!helper) { log("未找到提权安装脚本"); resolve(-1); return }
    try { fs.writeFileSync(eres, JSON.stringify({ status: "pending" }), "utf8") } catch {}
    const ps = "$p = Start-Process -FilePath '" + process.execPath + "' -ArgumentList '" + helper + "' -Verb RunAs -Wait -PassThru; exit $p.ExitCode"
    log("弹出系统授权确认框（请点击「是」允许以管理员身份安装）…")
    const child = spawn(PS, ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    child.stdout.on("data", (d) => log("  " + String(d).trim()))
    child.stderr.on("data", (d) => log("  " + String(d).trim()))
    child.on("error", (e) => { log("无法启动提权进程: " + e.message); resolve(-1) })
    child.on("close", () => {
      try {
        const j = JSON.parse(fs.readFileSync(eres, "utf8"))
        if (j.status === "ok") { resolve(0); return }
        if (j.status === "error") { log("管理员安装失败: " + (j.line || "")); resolve(1); return }
        log("未取得管理员授权（用户取消）或安装未完成")
        resolve(-1)
      } catch { resolve(-1) }
    })
  })
}

function writeResult(status, line) {
  try { fs.writeFileSync(RESULT, JSON.stringify({ status, line, ts: Date.now() }), "utf8") } catch {}
}

function relaunch() {
  try {
    const child = spawn(process.execPath, [SELF, ...ARGS], { detached: true, stdio: "ignore", windowsHide: true })
    child.unref()
    log("已重新启动 SapBuddy")
  } catch (e) {
    log("重新启动失败: " + e.message)
  }
}

const MAX = 5, DELAY = 5000
log("=== 更新代理启动：等待旧程序退出后安装新版 ===")
await sleep(3000)
let ok = false
let lastReason = ""
let elevatedTried = false
for (let i = 1; i <= MAX; i++) {
  await killCompanions()
  await sleep(1500)
  log("第 " + i + " 次尝试安装…")
  let code = await runInstall()
  if (code === 0) { ok = true; break }
  let reason = explain(code)
  // 全局安装目录仅管理员可写（用户当初以管理员装的 Node）→ 自动提权重装一次
  if (!elevatedTried && isEaccs(code)) {
    elevatedTried = true
    log("检测到权限不足：以管理员身份重试安装（将弹出系统授权确认框）")
    code = await runInstallElevated()
    if (code === 0) { ok = true; break }
    reason = "以管理员身份安装也未成功（可能取消了授权，或杀毒软件仍锁文件）"
    lastReason = reason
    log("第 " + i + " 次失败: " + lastReason)
    break // 权限问题是持续性的，再重试普通安装没有意义
  }
  lastReason = reason
  log("第 " + i + " 次失败: " + lastReason)
  if (i < MAX) await sleep(DELAY)
}
if (ok) {
  log("✅ 安装成功，启动新版本")
  writeResult("ok", "更新完成，正在启动新版本")
} else {
  log("❌ 安装失败: " + lastReason)
  const manual = elevatedTried
    ? "已自动尝试以管理员身份安装，但仍未成功。请完全关闭 SapBuddy（含任务管理器里的 node.exe 进程）后，手动运行 npm install -g sapbuddy@latest；若手动装仍失败，多半是杀毒软件锁文件，请把 SapBuddy 加入白名单后再试。"
    : "请完全关闭 SapBuddy（含任务管理器里的 node.exe 进程）后，以管理员身份运行命令 npm install -g sapbuddy@latest 手动更新一次；若手动装仍失败，多半是杀毒软件锁文件，请把 SapBuddy 加入白名单后再试。"
  writeResult("error", "更新失败：" + lastReason + "。已恢复运行原版本。" + manual)
}
relaunch()
`

// 全局异常兜底：未捕获异常/拒绝给出明确提示，而不是无提示崩溃
process.on("uncaughtException", (err) => {
  console.error("⚠️ 未捕获异常: " + (err?.message ?? err))
  process.exit(1)
})
process.on("unhandledRejection", (reason) => {
  console.error("⚠️ 未处理的 Promise 拒绝: " + (reason?.message ?? reason))
})

// 优雅关闭：Ctrl+C / SIGTERM 时先关 HTTP 服务，给在途请求一个收尾时间再退出
// （SAP 连接由连接池自愈接管；直接杀进程可能残留编辑锁）
function gracefulShutdown(signal) {
  console.log(`\n  收到 ${signal}，正在关闭 Web 服务…`)
  try { server.close() } catch {}
  setTimeout(() => process.exit(0), 800)
}
process.on("SIGINT", () => gracefulShutdown("SIGINT"))
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"))

server.on("error", (err) => {
  if (err?.code === "EADDRINUSE") {
    // 自重启的新进程：旧进程可能还没释放端口 → 稍后重试而非直接退出
    if (process.env.SAPBUDDY_RESTARTING === "1") {
      setTimeout(() => { try { server.close() } catch {} server.listen(PORT, HOST) }, 1500)
      return
    }
    console.error(`\n  ❌ 端口 ${PORT} 已被占用（可能已有 SapBuddy 在运行）`)
    console.error(`  请先关闭旧进程（Ctrl+C 或任务管理器结束 node.exe），或指定新端口：`)
    console.error(`  node cli.mjs web --port 7401\n`)
  } else {
    console.error(err)
  }
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  // 首次运行：初始化 .SapBuddy（技能/提示词/模型/连接迁移）
  import(pathToFileURL(path.join(ROOT, "src", "agent-core.mjs")).href)
    .then((m) => {
      m.ensureRuntimeFiles?.()
      cleanEmptySessions()
    })
    .catch(() => cleanEmptySessions())
  // 后台预热 MCP 服务器：启动即连接（连不上的 5s 内失败），agent 创建时读缓存，主对话零等待
  import(pathToFileURL(path.join(ROOT, "src", "sap-tools", "mcp-register.mjs")).href)
    .then((m) => m.warmMcpServers?.())
    .catch(() => {})
  // 上次一键更新的结果：失败则记入 lastUpdateError（「检查更新」界面会提示），并打印到控制台
  try {
    const rf = path.join(USER_PI, "update-result.json")
    if (fs.existsSync(rf)) {
      const r = JSON.parse(fs.readFileSync(rf, "utf8"))
      fs.unlinkSync(rf)
      if (r?.status === "error" && r?.line) {
        lastUpdateError = r.line
        console.error(`\n  ⚠️ 上次一键更新失败：${r.line}\n`)
      }
    }
  } catch { /* 结果文件损坏则忽略 */ }
  console.log(`\n  🚀 SapBuddy Web 版已启动`)
  console.log(`  📍 http://${HOST}:${PORT}\n`)
})
