#!/usr/bin/env node
/**
 * AbapBuddy CLI — SAP ABAP AI 助手（跨平台）
 *
 * 用法:
 *   abapbuddy chat               交互式对话
 *   abapbuddy "提问内容"         单次提问
 *   abapbuddy --json "提问"      单次提问（JSON 输出）
 *   abapbuddy web                启动 Web 版（浏览器访问 http://127.0.0.1:7400）
 *   abapbuddy tools              列出 42 个 SAP 工具
 *   abapbuddy doctor             环境自检
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
  console.log("=== AbapBuddy 环境自检 ===")
  console.log(`Node: ${process.version}`)
  try {
    const { tools } = await import(pathToFileURL(path.join(HERE, "dist", "sap-tools", "tools", "index.js")).href)
    console.log(`SAP 工具: ${tools.length} 个已加载`)
  } catch (e) {
    console.log(`SAP 工具: 加载失败 ${e.message}`)
  }
  const auth = loadAuth()
  const hasKey = Object.values(auth).some((v) => v?.type === "api_key" && v.key && v.key !== "请输入你的API_KEY")
  console.log(`API Key: ${hasKey ? "✅ 已配置" : "❌ 未配置（复制 config/auth.example.json 为 .pi/auth.json）"}`)
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

// ===== 交互式对话（REPL）=====
async function cmdChat() {
  const { session } = await createAgent()
  console.log("\n🤖 AbapBuddy 交互模式（/exit 退出，/tools 查看工具，/help 帮助）")
  const readline = await import("node:readline").then((m) =>
    m.createInterface({ input: process.stdin, output: process.stdout })
  )
  const ask = () => {
    readline.question("\n❯ ", async (input) => {
      const t = input.trim()
      if (t === "/exit" || t === "/quit") { session.dispose(); readline.close(); process.exit(0) }
      if (t === "/tools") { await cmdTools(); return ask() }
      if (t === "/help") {
        console.log("  /exit 退出  /tools 工具列表  /help 帮助")
        return ask()
      }
      if (!t) return ask()
      process.stdout.write("\n")
      const unsub = session.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          process.stdout.write(event.assistantMessageEvent.delta)
        }
      })
      await session.prompt(t).catch((e) => console.log(`\n[错误] ${e.message}`))
      unsub()
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
  console.log(`AbapBuddy — SAP ABAP AI 助手

用法:
  abapbuddy chat                  交互式对话
  abapbuddy "提问"                单次提问
  abapbuddy web [--port 7400]     启动 Web 版
  abapbuddy tools                 列出 SAP 工具
  abapbuddy doctor                环境自检
`)
}

main().catch((e) => { console.error("错误:", e.message); process.exit(1) })
