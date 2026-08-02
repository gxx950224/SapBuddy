#!/usr/bin/env node
/**
 * SapBuddy CLI — SAP ABAP AI 助手（跨平台）
 *
 * 用法:
 *   sapbuddy chat               交互式对话（全屏 TUI）
 *   sapbuddy "提问内容"         单次提问
 *   sapbuddy --json "提问"      单次提问（JSON 输出）
 *   sapbuddy web                启动 Web 版（浏览器访问 http://127.0.0.1:7400）
 *   sapbuddy tools              列出 42 个 SAP 工具
 *   sapbuddy doctor             环境自检
 */
import path from "node:path"
import fs from "node:fs"
import os from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createAgent, loadAuth, loadSettings, ROOT } from "./src/agent-core.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)

// ===== ANSI 与渲染辅助 =====
const ANSI = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", cyan: "\x1b[36m", yellow: "\x1b[33m", magenta: "\x1b[35m", red: "\x1b[31m", blue: "\x1b[34m" }
function esc(s) { return String(s ?? "").replace(/\x1b/g, "") }
function visibleLen(s) { return String(s).replace(/\x1b\[[0-9;]*m/g, "") }
function mdToAnsi(text) {
  let out = esc(text)
  out = out.replace(/^```[\w-]*\n?([\s\S]*?)\n?```$/gm, (m, code) => ANSI.cyan + code.replace(/^/gm, "  │ ") + ANSI.reset)
  out = out.replace(/^```[\w-]*$/gm, "")
  out = out.replace(/^(#{1,4})\s+(.+)$/gm, (m, h, t) => ANSI.cyan + ANSI.bold + t + ANSI.reset)
  out = out.replace(/\*\*([^*\n]+)\*\*/g, ANSI.bold + "$1" + ANSI.reset)
  out = out.replace(/`([^`\n]+)`/g, ANSI.green + "$1" + ANSI.reset)
  out = out.replace(/^\s*[-*]\s+(.+)$/gm, "  " + ANSI.yellow + "•" + ANSI.reset + " $1")
  out = out.replace(/^>\s?(.+)$/gm, ANSI.dim + "│ $1" + ANSI.reset)
  return out
}
function sepLine() {
  const w = process.stdout.columns || 80
  return ANSI.dim + "─".repeat(Math.min(w, 100)) + ANSI.reset
}

// ===== tools：列出工具 =====
async function cmdTools() {
  const { listToolNames } = await import(pathToFileURL(path.join(HERE, "dist", "sap-tools", "register.js")).href)
  const tools = listToolNames()
  const read = tools.filter((t) => !t.write)
  const write = tools.filter((t) => t.write)
  console.log(`SAP 工具共 ${tools.length} 个：`)
  console.log(`\n📖 只读（${read.length}）：${read.map((t) => t.name).join(", ")}`)
  console.log(`\n✏️ 写操作（${write.length}）：${write.map((t) => t.name).join(", ")}`)
}

// ===== doctor：环境自检 =====
async function cmdDoctor() {
  console.log("=== SapBuddy 环境自检 ===")
  console.log(`Node: ${process.version}`)
  try {
    const { tools } = await import(pathToFileURL(path.join(HERE, "dist", "sap-tools", "tools", "index.js")).href)
    console.log(`SAP 工具: ${tools.length} 个已加载`)
  } catch (e) {
    console.log(`SAP 工具: 加载失败 ${e.message}`)
  }
  const auth = loadAuth()
  const hasKey = Object.values(auth).some((v) => v?.type === "api_key" && v.key && v.key !== "请输入你的API_KEY")
  console.log(`API Key: ${hasKey ? "✅ 已配置" : "❌ 未配置（复制 config/auth.example.json 为 .SapBuddy/auth.json）"}`)
  const settings = loadSettings()
  console.log(`默认模型: ${settings.defaultProvider ?? "deepseek"}/${settings.defaultModel ?? "deepseek-v4-flash"}`)
  const confPath = [path.join(process.cwd(), ".SapBuddy", "connections.json"), path.join(process.cwd(), "connections.json")].find((f) => fs.existsSync(f))
  if (confPath) {
    try {
      const conf = JSON.parse(fs.readFileSync(confPath, "utf8"))
      console.log(`SAP 连接: ✅ ${conf.connections?.length ?? 0} 个已配置（${confPath}）`)
    } catch { console.log("SAP 连接: ⚠️ connections.json 格式错误") }
  } else {
    console.log("SAP 连接: ⚠️ 未找到 connections.json（复制 config/connections.example.json 为 .SapBuddy/connections.json）")
  }
}

// ===== 单次提问 =====
async function cmdPrompt(text, jsonMode) {
  const { session } = await createAgent()
  let out = ""
  const unsub = session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      if (jsonMode) out += event.assistantMessageEvent.delta
      else process.stdout.write(event.assistantMessageEvent.delta)
    }
  })
  await session.prompt(text)
  unsub()
  if (jsonMode) console.log(JSON.stringify({ answer: out }))
  else console.log("\n")
  session.dispose()
}

// ===== 交互式对话：全屏 TUI（pi 风格） =====
async function cmdChat() {
  // 非 TTY（管道/CI）：降级为简化 REPL
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return simpleChat()
  }
  const { createInterface } = await import("node:readline")
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdout.write("\x1b[?1049h")  // 备用屏幕
  process.stdout.write("\x1b[?25l")    // 隐藏光标

  const settings = loadSettings()
  const modelId = (settings.defaultProvider ?? "deepseek") + "/" + (settings.defaultModel ?? "deepseek-v4-flash")
  const ctxMax = Number(settings.contextTokens) || 200000

  const history = []      // { role, text }
  let inputBuf = ""
  let historyIdx = -1
  let streaming = false
  let reply = ""
  let spinnerTimer = null
  let renderTimer = null
  let exitDone = false

  function ctxUsed() {
    try {
      const msgs = session?.agent?.state?.messages ?? []
      let n = 0
      for (const m of msgs) n += (m.usage?.input ?? 0) + (m.usage?.output ?? 0)
      return n
    } catch { return 0 }
  }

  function statusBar() {
    const used = ctxUsed()
    const pct = ctxMax > 0 ? Math.min(999, Math.round((used / ctxMax) * 100)) : 0
    const home = process.env.USERPROFILE || process.env.HOME || ""
    const short = home ? process.cwd().replace(home, "~") : process.cwd()
    const left = "  " + ANSI.dim + short + ANSI.reset +
      ANSI.dim + "  ·  模型 " + ANSI.reset + modelId +
      ANSI.dim + "  ·  上下文 " + ANSI.reset + pct + "%/" + (ctxMax >= 1000000 ? (ctxMax / 1000000).toFixed(1) + "M" : ctxMax)
    const right = ANSI.dim + "消息 " + history.length + " · " + new Date().toLocaleTimeString("zh-CN", { hour12: false }) + ANSI.reset
    const pad = Math.max(1, (process.stdout.columns || 100) - visibleLen(left) - visibleLen(right))
    return left + " ".repeat(pad) + right
  }

  function messagesBlock() {
    const lines = []
    for (const h of history) {
      if (h.role === "user") lines.push("", sepLine(), ANSI.bold + "❯ " + ANSI.reset + esc(h.text))
      else lines.push("", sepLine(), ANSI.cyan + ANSI.bold + "SapBuddy" + ANSI.reset, mdToAnsi(h.text))
    }
    if (streaming) {
      lines.push("", sepLine(), ANSI.cyan + ANSI.bold + "SapBuddy" + ANSI.reset)
      lines.push(mdToAnsi(reply))
    }
    const rows = (process.stdout.rows || 30) - 6
    if (lines.length > rows) return lines.slice(-rows).join("\n")
    return lines.join("\n")
  }

  function render() {
    let out = "\x1b[2J\x1b[H"
    out += statusBar() + "\n"
    out += ANSI.dim + "  Ctrl+C 停止/退出 · ↑↓ 历史 · /help 帮助 · /tools 工具 · /compact 压缩 · /clear 清屏" + ANSI.reset + "\n\n"
    out += messagesBlock() + "\n\n"
    out += sepLine() + "\n"
    out += "❯ " + inputBuf
    process.stdout.write(out)
    const row = process.stdout.rows || 30
    const col = 3 + visibleLen(inputBuf).length
    process.stdout.write("\x1b[" + row + ";" + col + "H")
  }
  function scheduleRender() {
    if (renderTimer) return
    renderTimer = setTimeout(() => { renderTimer = null; render() }, 60)
  }

  function cleanup() {
    if (exitDone) return
    exitDone = true
    if (spinnerTimer) clearInterval(spinnerTimer)
    if (renderTimer) clearTimeout(renderTimer)
    try { process.stdin.setRawMode(false) } catch {}
    process.stdout.write("\x1b[?25h\x1b[?1049l\x1b[2J\x1b[H")
    console.log("👋 再见\n")
    try { session.dispose() } catch {}
    process.exit(0)
  }

  // ── 输入处理（raw mode + keypress）──
  process.stdin.on("keypress", async (ch, key) => {
    if (!key) return
    if (streaming) {
      // 生成中：Ctrl+C 停止
      if (key.ctrl && key.name === "c") {
        streaming = false
        if (spinnerTimer) { clearInterval(spinnerTimer); spinnerTimer = null }
        history.push({ role: "assistant", text: reply || "(已停止)" })
        reply = ""
        render()
      }
      return
    }
    if (key.ctrl && key.name === "c") return cleanup()
    if (key.name === "return") {
      const t = inputBuf.trim()
      inputBuf = ""
      historyIdx = -1
      if (!t) return render()
      if (["/exit", "/quit"].includes(t)) return cleanup()
      if (t === "/help" || t === "--help" || t === "-h") {
        history.push({ role: "user", text: t })
        history.push({ role: "assistant", text: "可用命令:\n  /exit 退出 · /tools 42 个工具 · /compact 压缩上下文 · /stop 停止 · /model 切换模型 · /clear 清屏 · /help 帮助" })
        return render()
      }
      if (t === "/clear") { history.length = 0; return render() }
      if (t === "/compact") {
        history.push({ role: "user", text: t })
        history.push({ role: "assistant", text: "🧹 正在压缩上下文…" })
        render()
        try { await session.compact(); history[history.length - 1].text = "✅ 压缩完成" }
        catch (e) { history[history.length - 1].text = "⚠️ 压缩失败: " + e.message }
        return render()
      }
      if (t === "/model") {
        history.push({ role: "user", text: t })
        const r = await session.cycleModel().catch(() => undefined)
        history.push({ role: "assistant", text: r?.model ? ("🔄 已切换: " + r.model.provider + "/" + r.model.id) : "⚠️ 没有可切换的模型" })
        return render()
      }
      if (t === "/tools") {
        history.push({ role: "user", text: t })
        history.push({ role: "assistant", text: "42 个 SAP 工具可用（执行 `sapbuddy tools` 查看完整清单）。" })
        return render()
      }
      if (t === "/stop") { history.push({ role: "assistant", text: "当前没有生成中的内容" }); return render() }

      // ── 普通对话 ──
      history.push({ role: "user", text: t })
      streaming = true
      reply = ""
      const spin = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
      let si = 0
      spinnerTimer = setInterval(() => {
        process.stdout.write("\r" + ANSI.dim + " " + spin[si++ % spin.length] + " Working..." + ANSI.reset)
      }, 100)
      render()
      const unsub = session.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          reply += event.assistantMessageEvent.delta
          scheduleRender()
        }
      })
      await session.prompt(t).catch(() => {})
      unsub()
      streaming = false
      if (spinnerTimer) { clearInterval(spinnerTimer); spinnerTimer = null }
      history.push({ role: "assistant", text: reply || "(无输出)" })
      reply = ""
      render()
    } else if (key.name === "backspace") {
      inputBuf = inputBuf.slice(0, -1)
      render()
    } else if (key.name === "up") {
      const userMsgs = history.filter((h) => h.role === "user").map((h) => h.text)
      if (userMsgs.length) {
        historyIdx = historyIdx === -1 ? userMsgs.length - 1 : Math.max(0, historyIdx - 1)
        inputBuf = userMsgs[historyIdx]
        render()
      }
    } else if (key.name === "down") {
      const userMsgs = history.filter((h) => h.role === "user").map((h) => h.text)
      if (userMsgs.length && historyIdx >= 0) {
        historyIdx++
        inputBuf = historyIdx < userMsgs.length ? userMsgs[historyIdx] : ""
        if (historyIdx >= userMsgs.length) historyIdx = -1
        render()
      }
    } else if (key.ctrl && key.name === "u") {
      inputBuf = ""
      render()
    } else if (key.name === "tab" || key.name === "escape") {
      // 忽略
    } else if (ch) {
      inputBuf += ch
      render()
    }
  })

  render()
  rl.on("close", () => cleanup())
  await new Promise(() => {})  // 常驻，由 cleanup 退出
}

// ===== 简化 REPL（非 TTY 降级：管道/CI）=====
async function simpleChat() {
  const { createInterface } = await import("node:readline")
  process.stdin.resume()
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false })
  let session = null
  let processing = false
  const queue = []

  console.log("SapBuddy 交互模式（简化）· 模型: " + (loadSettings().defaultProvider ?? "deepseek") + "/" + (loadSettings().defaultModel ?? "deepseek-v4-flash"))
  console.log("输入 /help 查看命令，/exit 退出\n")

  // 逐行处理（队列串行；agent 懒创建，兼容管道输入在启动期间到达）
  async function handleLine(raw) {
    const t = raw.trim()
    if (!t) return
    if (["/exit", "/quit"].includes(t)) {
      console.log("👋 再见")
      try { session?.dispose() } catch {}
      process.exit(0)
    }
    if (t === "/help" || t === "--help") { console.log("  /exit 退出 · /compact 压缩上下文 · /stop 停止 · /model 切换模型 \n"); return }
    if (!session) session = (await createAgent()).session
    if (t === "/compact") { try { await session.compact(); console.log("✅ 压缩完成") } catch (e) { console.log("⚠️ " + e.message) } return }
    if (t === "/model") { const r = await session.cycleModel().catch(() => undefined); console.log(r?.model ? "🔄 " + r.model.id : "⚠️ 无模型可切"); return }
    console.log()
    const unsub = session.subscribe((e) => {
      if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") process.stdout.write(e.assistantMessageEvent.delta)
      if (e.type === "tool_execution_start") process.stdout.write("\n[🔧 " + e.toolName + "] ")
    })
    await session.prompt(t).catch((e) => console.log("\n[错误] " + e.message))
    unsub()
    console.log("\n")
  }

  rl.on("line", async (line) => {
    queue.push(line)
    if (processing) return
    processing = true
    while (queue.length) {
      await handleLine(queue.shift())
    }
    processing = false
  })
  rl.on("close", () => { console.log("👋 再见"); try { session?.dispose() } catch {}; process.exit(0) })
}

// ===== web：启动 Web 版 =====
async function cmdWeb() {
  const port = args.includes("--port") ? args[args.indexOf("--port") + 1] : 7400
  await import(pathToFileURL(path.join(HERE, "src", "web", "server.mjs")).href)
    .then((m) => undefined)
  process.stdin.resume()
}

// ===== 入口 =====
async function main() {
  const first = args[0]
  if (first === "tools") return cmdTools()
  if (first === "doctor") return cmdDoctor()
  if (first === "chat") return cmdChat()
  if (first === "web") return cmdWeb()
  if (first === "--json") return cmdPrompt(args.slice(1).join(" "), true)
  if (first && !first.startsWith("-")) return cmdPrompt(args.join(" "), false)
  console.log(`SapBuddy — SAP ABAP AI 助手

用法:
  sapbuddy chat                  交互式对话（全屏 TUI）
  sapbuddy "提问"                单次提问
  sapbuddy web [--port 7400]     启动 Web 版
  sapbuddy tools                 列出 SAP 工具
  sapbuddy doctor                环境自检
`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
