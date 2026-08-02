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
import net from "node:net"
import { createAgent, loadAuth, loadSettings, ensureRuntimeFiles, ROOT, CONFIG_DIR } from "./src/agent-core.mjs"

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

// ── SAPBUDDY ASCII art ──
const FIGLET = {
  S: ["███████╗", "██╔════╝", "███████╗", "╚════██║", "███████║", "╚══════╝"],
  A: [" █████╗ ", "██╔══██╗", "███████║", "██╔══██║", "██║  ██║", "╚═╝  ╚═╝"],
  P: ["██████╗ ", "██╔══██╗", "██████╔╝", "██╔═══╝ ", "██║     ", "╚═╝     "],
  B: ["██████╗ ", "██╔══██╗", "██████╔╝", "██╔══██╗", "██████╔╝", "╚═════╝ "],
  U: ["██╗   ██╗", "██║   ██║", "██║   ██║", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
  D: ["██████╗ ", "██╔══██╗", "██║  ██║", "██║  ██║", "██████╔╝", "╚═════╝ "],
  Y: ["██╗   ██╗", "╚██╗ ██╔╝", " ╚████╔╝ ", "  ╚██╔╝  ", "   ██║   ", "   ╚═╝   "],
}
function renderBanner() {
  const word = "SAPBUDDY"
  const rows = Array(6).fill("")
  for (const ch of word) {
    const glyph = FIGLET[ch] || ["      ", "      ", "      ", "      ", "      ", "      "]
    for (let i = 0; i < 6; i++) rows[i] += glyph[i]
  }
  return rows.join("\n") + "\n"
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
  // MCP 外部工具（.SapBuddy/mcp.json 配置的服务器）
  try {
    const { loadMcpServers, testServer } = await import(pathToFileURL(path.join(ROOT, "src", "web", "mcp-client.mjs")).href)
    const servers = loadMcpServers()
    if (!Object.keys(servers).length) {
      console.log(`\n🔌 MCP 外部工具：未配置（Web 设置-MCP 可添加）`)
      return
    }
    for (const [name, s] of Object.entries(servers)) {
      const st = await testServer(name, s)
      if (!st.connected) {
        console.log(`\n🔌 MCP ${name}：连接失败（${st.error}）`)
        continue
      }
      const names = st.tools.map((t) => `mcp_${name}_${t.name}`)
      console.log(`\n🔌 MCP ${name}（${names.length} 个）：${names.join(", ")}`)
    }
  } catch (e) {
    console.log(`\n🔌 MCP 外部工具：列出失败（${e instanceof Error ? e.message : e}）`)
  }
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
  console.log(`API Key: ${hasKey ? "✅ 已配置" : "❌ 未配置（复制 config/auth.example.json 为 ~/.SapBuddy/auth.json）"}`)
  const settings = loadSettings()
  console.log(`默认模型: ${settings.defaultProvider ?? "deepseek"}/${settings.defaultModel ?? "deepseek-v4-flash"}`)
  const confPath = [path.join(CONFIG_DIR, "connections.json"), path.join(process.cwd(), "connections.json")].find((f) => fs.existsSync(f))
  if (confPath) {
    try {
      const conf = JSON.parse(fs.readFileSync(confPath, "utf8"))
      console.log(`SAP 连接: ✅ ${conf.connections?.length ?? 0} 个已配置（${confPath}）`)
    } catch { console.log("SAP 连接: ⚠️ connections.json 格式错误") }
  } else {
    console.log("SAP 连接: ⚠️ 未找到 connections.json（复制 config/connections.example.json 为 ~/.SapBuddy/connections.json）")
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

// ===== 交互式对话：直接复用 pi CLI（完整 TUI + 42 工具扩展）=====
async function cmdChat() {
  // 首次运行：初始化默认技能/models.json（从包内 defaults/ 拷贝到 .SapBuddy/）
  try { ensureRuntimeFiles() } catch { /* 初始化失败不阻塞，pi CLI 会继续 */ }
  // 首次运行引导
  const auth = loadAuth()
  const hasKey = Object.values(auth).some((v) => v?.type === "api_key" && v.key && v.key !== "请输入你的API_KEY")
  if (!hasKey) {
    console.log("⚠️  未配置 AI 模型 API Key。请先：")
    console.log("    mkdir -p ~/.SapBuddy && cp config/auth.example.json ~/.SapBuddy/auth.json   # 然后填入你的 API Key")
    console.log("    或运行: node cli.mjs doctor\n")
  }
  const settings = loadSettings()
  const piCli = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js")
  if (!fs.existsSync(piCli)) {
    console.error("❌ 未找到 pi CLI（node_modules/@earendil-works/pi-coding-agent），请先 npm install")
    process.exit(1)
  }
  const args = [
    piCli,
    "--extension", path.join(ROOT, "dist", "sap-tools", "pi-extension.js"),
    "--provider", settings.defaultProvider ?? "deepseek",
    "--model", settings.defaultModel ?? "deepseek-v4-flash",
    "--session-dir", path.join(CONFIG_DIR, "sessions"),
    "--skill", path.join(CONFIG_DIR, "skills"),
    "--append-system-prompt", path.join(ROOT, "SYSTEM.md"),
    "--append-system-prompt", path.join(ROOT, "Memory.md"),
  ]
  // API Key（从 .SapBuddy/auth.json 读取，避免手工配置）
  const apiKey = Object.values(auth).find((v) => v?.type === "api_key" && v.key)?.key
  if (apiKey && apiKey !== "请输入你的API_KEY") args.push("--api-key", apiKey)
  // 思考级别
  const tl = settings.defaultThinkingLevel
  if (tl && tl !== "off") args.push("--thinking", tl)
  // 会话目录不存在时创建（pi --session-dir 需要存在）
  fs.mkdirSync(path.join(CONFIG_DIR, "sessions"), { recursive: true })
  // 复用已有 fd/rg 二进制（PI_CODING_AGENT_DIR 隔离后 bin 目录在 .SapBuddy/bin，避免内网重新下载）
  try {
    const srcBin = path.join(os.homedir(), ".pi", "agent", "bin")
    const dstBin = path.join(CONFIG_DIR, "bin")
    fs.mkdirSync(dstBin, { recursive: true })
    for (const f of ["fd", "fd.exe", "rg", "rg.exe"]) {
      const s = path.join(srcBin, f)
      const d = path.join(dstBin, f)
      if (fs.existsSync(s) && !fs.existsSync(d)) fs.copyFileSync(s, d)
    }
  } catch {}
  // quietStartup：禁用 pi 启动公告（What's New / 版本说明）
  try {
    const sf = path.join(CONFIG_DIR, "settings.json")
    const sc = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, "utf8")) : {}
    if (!sc.quietStartup) { sc.quietStartup = true; fs.writeFileSync(sf, JSON.stringify(sc, null, 2)) }
  } catch {}

  const { spawn } = await import("node:child_process")

  // ── 自动附带 Web 服务（子进程隔离，避免同进程干扰 pi CLI 的 TTY/进程生命周期）──
  const WEB_PORT = 7400
  let webProcess = null
  if (!process.argv.includes("--no-web")) {
    const portInUse = await new Promise((resolve) => {
      const s = net.connect(WEB_PORT, "127.0.0.1")
      s.on("connect", () => { s.destroy(); resolve(true) })
      s.on("error", () => resolve(false))
    })
    if (portInUse) {
      console.log(`🌐 Web 版已在 http://127.0.0.1:${WEB_PORT} 运行（同一会话）`)
    } else {
      try {
        webProcess = spawn(process.execPath, [path.join(HERE, "src", "web", "server.mjs")], { cwd: ROOT, stdio: "ignore", detached: false })
        webProcess.unref()
        await new Promise((r) => setTimeout(r, 1500)) // 给 server 启动时间（失败静默）
        console.log(`🌐 Web 版已启动：http://127.0.0.1:${WEB_PORT}（浏览器打开即可；与当前 CLI 共享会话/产物/记忆；--no-web 可禁用）`)
      } catch (e) {
        console.log(`⚠️  Web 版启动失败（不影响 CLI）：${e.message}`)
      }
    }
  }

  // 隔离全局 ~/.pi 配置（不加载 pi-obsidian/mcp-adapter 等无关扩展/技能）
  const env = { ...process.env, PI_CODING_AGENT_DIR: CONFIG_DIR }
  const child = spawn(process.execPath, args, { stdio: "inherit", cwd: ROOT, env })
  child.on("exit", (code) => {
    // 退出时关闭附带的 Web 子进程（如果还活着）
    if (webProcess && !webProcess.killed) { try { webProcess.kill() } catch {} }
    process.exit(code ?? 0)
  })
  child.on("error", (e) => { console.error("❌ 启动失败: " + e.message); process.exit(1) })
}

// ===== web：启动 Web 版 =====
async function cmdWeb() {
  // server.mjs 自身解析 --port 并监听（argv 共享），import 即启动
  await import(pathToFileURL(path.join(HERE, "src", "web", "server.mjs")).href)
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
  // 无参数：默认进入全屏对话（TUI）
  return cmdChat()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
