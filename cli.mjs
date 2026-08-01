#!/usr/bin/env node
/**
 * SapBuddy CLI — SAP ABAP AI 助手（跨平台）
 *
 * 用法:
 *   sapbuddy chat               交互式对话
 *   sapbuddy "提问内容"         单次提问
 *   sapbuddy --json "提问"      单次提问（JSON 输出）
 *   sapbuddy web                启动 Web 版（浏览器访问 http://127.0.0.1:7400）
 *   sapbuddy tools              列出 42 个 SAP 工具
 *   sapbuddy doctor             环境自检
 */
import path from "node:path"
import fs from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createAgent, loadAuth, loadSettings } from "./src/agent-core.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)

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
  console.log(`API Key: ${hasKey ? "✅ 已配置" : "❌ 未配置（复制 config/auth.example.json 为 ~/.SapBuddy/auth.json）"}`)
  const settings = loadSettings()
  console.log(`默认模型: ${settings.defaultProvider ?? "deepseek"}/${settings.defaultModel ?? "deepseek-v4-flash"}`)
  const confPath = path.join(process.cwd(), "connections.json")
  if (fs.existsSync(confPath)) {
    try {
      const conf = JSON.parse(fs.readFileSync(confPath, "utf8"))
      console.log(`SAP 连接: ✅ ${conf.connections?.length ?? 0} 个已配置`)
    } catch { console.log("SAP 连接: ⚠️ connections.json 格式错误") }
  } else {
    console.log("SAP 连接: ⚠️ 未找到 connections.json（复制 config/connections.example.json）")
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

// ===== 交互式对话（REPL，类 pi / Claude Code）=====
const BANNER = `
╔══════════════════════════════════════╗
║   🤖 SapBuddy  v2.0                 ║
║   SAP ABAP AI 助手 · 42 个工具        ║
╚══════════════════════════════════════╝
`

async function cmdChat() {
  console.log(BANNER)
  // 首次运行引导：未配置 API Key / 连接时给出提示
  const auth = loadAuth()
  const hasKey = Object.values(auth).some((v) => v?.type === "api_key" && v.key && v.key !== "请输入你的API_KEY")
  if (!hasKey) {
    console.log("⚠️  未配置 AI 模型 API Key。请先：")
    console.log("    mkdir -p ~/.SapBuddy && cp config/auth.example.json ~/.SapBuddy/auth.json   # 然后填入你的 API Key")
    console.log("    或运行: node cli.mjs doctor\n")
  }
  const { session } = await createAgent()
  const readline = await import("node:readline").then((m) =>
    m.createInterface({ input: process.stdin, output: process.stdout })
  )
  let streaming = false

  // Ctrl+C：流式中停止当前生成；空闲时退出
  readline.on("SIGINT", async () => {
    if (streaming) {
      streaming = false
      try { await session.abort() } catch { /* 忽略 */ }
      process.stdout.write("\n⏹ 已停止\n")
      ask()
    } else {
      process.stdout.write("\n👋 再见\n")
      session.dispose()
      process.exit(0)
    }
  })

  const helpText = `
  可用命令:
    /exit       退出
    /tools      查看 42 个 SAP 工具
    /compact    压缩上下文（节省 tokens）
    /stop       停止当前生成
    /model      切换模型
    /clear      清屏
    /help       帮助
  `

  const ask = () => {
    readline.question("\n❯ ", async (input) => {
      const t = input.trim()
      if (!t) return ask()

      // ── 命令处理 ──
      switch (t) {
        case "/exit":
        case "/quit":
          console.log("👋 再见")
          session.dispose()
          readline.close()
          process.exit(0)
        case "/tools":
          await cmdTools()
          return ask()
        case "/help":
          console.log(helpText)
          return ask()
        case "/clear":
          process.stdout.write("\x1bc")
          console.log(BANNER)
          return ask()
        case "/stop":
          if (streaming) { streaming = false; await session.abort().catch(() => {}); console.log("⏹ 已停止") }
          else console.log("当前没有生成中的内容")
          return ask()
        case "/compact":
          console.log("🧹 正在压缩上下文…")
          try {
            await session.compact()
            console.log("✅ 压缩完成")
          } catch (e) { console.log(`⚠️ 压缩失败: ${e.message}`) }
          return ask()
        case "/model": {
          const result = await session.cycleModel().catch(() => undefined)
          if (result?.model) console.log(`🔄 已切换: ${result.model.provider}/${result.model.id}`)
          else console.log("⚠️ 没有可切换的模型")
          return ask()
        }
      }

      // ── 普通对话 ──
      streaming = true
      process.stdout.write("\n")
      const unsub = session.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          process.stdout.write(event.assistantMessageEvent.delta)
        }
        if (event.type === "tool_execution_start") {
          process.stdout.write(`\n[🔧 ${event.toolName}] `)
        }
      })
      await session.prompt(t).catch((e) => console.log(`\n[错误] ${e.message}`))
      unsub()
      streaming = false
      console.log("\n")
      ask()
    })
  }
  ask()
}

// ===== web：启动 Web 版 =====
async function cmdWeb() {
  const port = args.includes("--port") ? args[args.indexOf("--port") + 1] : 7400
  await import(pathToFileURL(path.join(HERE, "src", "web", "server.mjs")).href)
    .then((m) => undefined)
  // server.mjs 自带 listen，等待
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
  sapbuddy chat                  交互式对话
  sapbuddy "提问"                单次提问
  sapbuddy web [--port 7400]     启动 Web 版
  sapbuddy tools                 列出 SAP 工具
  sapbuddy doctor                环境自检
`)
}

main().catch((e) => { console.error("错误:", e.message); process.exit(1) })
