/**
 * Agent 内核：pi SDK 会话管理 + 注册 42 个 SAP 工具
 */
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, "..")
/**
 * 用户配置目录：<cwd>/.SapBuddy（当前工作目录下的隐藏目录）
 * 在项目根运行即数据在项目目录；auth/settings/models/connections/sessions/skills/prompts/output 都在这里
 */
export const CONFIG_DIR = path.join(process.cwd(), ".SapBuddy")
/** 旧迁移源：用户主目录 ~/.SapBuddy（之前版本的位置） */
export const HOME_SAPBUDDY = path.join(os.homedir(), ".SapBuddy")
/** 兼容旧版：cwd/.pi（历史配置，优先于包内默认） */
export const LEGACY_PI = path.join(process.cwd(), ".pi")

// pi SDK 通过绝对路径 require 加载（项目结构特殊）
const PI_SDK_PATH = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent")
const {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} = require(PI_SDK_PATH)

/** 读取认证（.pi/auth.json） */
export function loadAuth() {
  for (const f of [path.join(CONFIG_DIR, "auth.json"), path.join(LEGACY_PI, "auth.json"), path.join(ROOT, ".SapBuddy", "auth.json")]) {
    try { return JSON.parse(fs.readFileSync(f, "utf8")) } catch { /* 继续 */ }
  }
  return {}
}

/**
 * MCP 服务器工具动态注册（扩展）：
 * 读取 .pi/mcp.json 的服务器 → 连接拉取 tools/list → 注册为 customTools（前缀 mcp_<server>_）
 */
async function registerMcpTools(pi) {
  const { loadMcpServers, testServer, callMcpTool } = await import(pathToFileURL(path.join(ROOT, "src", "web", "mcp-client.mjs")).href)
  const { jsonSchemaToTypebox } = await import(pathToFileURL(path.join(ROOT, "dist", "sap-tools", "register.js")).href)
  const servers = loadMcpServers()
  for (const [name, server] of Object.entries(servers)) {
    try {
      const st = await testServer(name, server)
      if (!st.connected) {
        console.log(`[sapbuddy] MCP ${name} 连接失败: ${st.error}`)
        continue
      }
      for (const t of st.tools) {
        const toolName = `mcp_${name}_${t.name}`
        pi.registerTool({
          name: toolName,
          label: `${name}/${t.name}`,
          description: `[MCP:${name}] ${t.description}。来自外部 MCP 服务器 "${name}"（${server.url}）。`,
          promptSnippet: `外部 MCP 工具（${name}）`,
          parameters: jsonSchemaToTypebox(t.inputSchema),
          async execute(_id, args) {
            try {
              const text = await callMcpTool(server, t.name, args ?? {})
              return { content: [{ type: "text", text }], details: {} }
            } catch (err) {
              return {
                content: [{ type: "text", text: `MCP 工具 ${t.name} 执行失败: ${err instanceof Error ? err.message : String(err)}` }],
                details: {},
                isError: true,
              }
            }
          },
        })
      }
      console.log(`[sapbuddy] MCP ${name} 已注册 ${st.tools.length} 个工具（${st.tools.map((x) => x.name).join(", ")}）`)
    } catch (e) {
      console.log(`[sapbuddy] MCP ${name} 注册失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

/** 读取设置（默认模型等） */
export function loadSettings() {
  try {
    for (const f of [path.join(CONFIG_DIR, "settings.json"), path.join(LEGACY_PI, "settings.json"), path.join(ROOT, ".SapBuddy", "settings.json")]) {
      try { return JSON.parse(fs.readFileSync(f, "utf8")) } catch { /* 继续 */ }
    }
    return {}
  } catch {
    return {}
  }
}

/**
 * 创建带 42 个 SAP 工具的 Agent 会话
 * @param opts.sessionFile 指定会话文件（切换历史会话用）
 */
/** 首次运行引导：初始化 ~/.SapBuddy（技能/提示词/模型注册表），来源优先旧配置 cwd/.pi（迁移）→ 包内默认 */
export function ensureRuntimeFiles() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
    // 技能默认内容（来源：旧 cwd/.pi → 包内默认）。
    // ⚠️ 不再迁移 prompts（已弃用，由技能覆盖）；绝不复制主目录 ~/.SapBuddy 整套配置（含 auth.json，曾污染目录）
    for (const sub of ["skills"]) {
      const dst = path.join(CONFIG_DIR, sub)
      if (fs.existsSync(dst)) continue
      for (const src of [path.join(LEGACY_PI, sub), path.join(ROOT, ".SapBuddy", sub)]) {
        if (fs.existsSync(src)) { fs.cpSync(src, dst, { recursive: true }); break }
      }
    }
    for (const f of ["models.json", "auth.json", "settings.json"]) {
      const dst = path.join(CONFIG_DIR, f)
      if (fs.existsSync(dst)) continue
      for (const src of [path.join(LEGACY_PI, f), path.join(ROOT, ".SapBuddy", f)]) {
        if (fs.existsSync(src)) { fs.copyFileSync(src, dst); break }
      }
    }
    if (!fs.existsSync(path.join(CONFIG_DIR, "connections.json"))) {
      for (const src of [path.join(LEGACY_PI, "connections.json"), path.join(process.cwd(), "connections.json")]) {
        if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(CONFIG_DIR, "connections.json")); break }
      }
    }
    // 历史会话迁移（旧 cwd/.pi/sessions → ~/.SapBuddy/sessions，补复制不覆盖）
    const dstSessions = path.join(CONFIG_DIR, "sessions")
    const legacySessions = path.join(LEGACY_PI, "sessions")
fs.mkdirSync(dstSessions, { recursive: true })
    for (const srcS of [legacySessions]) if (fs.existsSync(srcS)) {
      for (const f of fs.readdirSync(srcS)) {
        const dst = path.join(dstSessions, f)
        if (fs.existsSync(dst)) continue
        try {
          // 跳过空会话（仅初始化条目，无对话消息）
          const src = path.join(srcS, f)
          let hasMsg = false
          for (const line of fs.readFileSync(src, "utf8").split(String.fromCharCode(10))) {
            if (!line.trim()) continue
            const e = JSON.parse(line)
            const r = e?.message?.role
            if (r === "user" || r === "assistant") { hasMsg = true; break }
          }
          if (hasMsg) fs.copyFileSync(src, dst)
        } catch { /* 忽略 */ }
      }
    }
    // 产物迁移（旧项目根 output / cwd/output → ~/.SapBuddy/output，补复制不覆盖）
    const dstOut = path.join(CONFIG_DIR, "output")
    fs.mkdirSync(dstOut, { recursive: true })
    for (const srcOut of [path.join(ROOT, "output"), path.join(process.cwd(), "output")]) {
      if (fs.existsSync(srcOut)) {
        for (const f of fs.readdirSync(srcOut)) {
          const dst = path.join(dstOut, f)
          if (!fs.existsSync(dst)) {
            try { fs.copyFileSync(path.join(srcOut, f), dst) } catch { /* 忽略 */ }
          }
        }
      }
    }
    // MCP 配置迁移（旧 .pi/mcp.json → ~/.SapBuddy/mcp.json）
    if (!fs.existsSync(path.join(CONFIG_DIR, "mcp.json"))) {
      for (const src of [path.join(LEGACY_PI, "mcp.json"), path.join(HOME_SAPBUDDY, "mcp.json")]) {
        if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(CONFIG_DIR, "mcp.json")); break }
      }
    }
    // 记忆文件迁移（旧 .pi/memory.md / 根 Memory.md → ~/.SapBuddy/memory.md）
    if (!fs.existsSync(path.join(CONFIG_DIR, "memory.md"))) {
      for (const src of [path.join(LEGACY_PI, "memory.md"), path.join(ROOT, "Memory.md")]) {
        if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(CONFIG_DIR, "memory.md")); break }
      }
    }
  } catch { /* 初始化失败不影响运行 */ }
}

export async function createAgent(opts = {}) {
  ensureRuntimeFiles()
  // 动态 import 工具注册层（编译产物 dist/sap-tools/register.js）
  const { registerSapTools } = await import(
    pathToFileURL(path.join(ROOT, "dist", "sap-tools", "register.js")).href
  )
  const { installWriteGate } = await import(
    pathToFileURL(path.join(ROOT, "dist", "sap-tools", "register.js")).href
  )

  const settings = loadSettings()

  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(CONFIG_DIR, "auth.json"),
    modelsPath: path.join(CONFIG_DIR, "models.json"),
  })

  // 显式解析默认模型（SDK 不自动读 settings 的 defaultModel）
  let model
  try {
    const provider = settings.defaultProvider ?? "deepseek"
    const modelId = settings.defaultModel ?? "deepseek-v4-flash"
    model = modelRuntime.getModel(provider, modelId)
    if (!model) {
      const ds = (await modelRuntime.getAvailable()).filter((m) => m.provider === provider)
      model = ds[0]
      console.log(`[sapbuddy] 模型 ${provider}/${modelId} 未找到，回退 ${model?.id ?? "默认"}`)
    }
  } catch {
    model = undefined
  }

  const loader = new DefaultResourceLoader({
    cwd: ROOT,
    agentDir: CONFIG_DIR,
    settingsManager: SettingsManager.inMemory(),
    appendSystemPrompt: [path.join(ROOT, "SYSTEM.md"), path.join(ROOT, "Memory.md")], // 与 CLI 一致：SYSTEM.md + 项目根 Memory.md 记忆
    extensionFactories: [
      (pi) => {
        // 加载期直接注册（不能调 getAllTools 等 action method，registerTool 本身可用）
        try {
          const n = registerSapTools(pi)
          console.log(`[sapbuddy] 已注册 ${n} 个 SAP 工具`)
          // 写操作人工确认：Web 模式 block 后通过回调通知 server 广播确认浮层
          installWriteGate(pi, {
            onBlocked: (info) => {
              try {
                opts.onWriteBlocked?.(info)
              } catch { /* 回调失败不影响主流程 */ }
            },
          })
        } catch (e) {
          console.log(`[sapbuddy] 工具注册失败: ${e.message}`)
        }
        // 授权窗口：确认词/拒绝词统一处理（CLI/Web 同规则，扩展层强制）。
        // 行为规则（创建/修改流程、避坑记录等）已统一在 SYSTEM.md（单一来源），不再按关键词动态注入。
        try {
          pi.on("before_agent_start", async (event, _ctx) => {
            try {
              const r = await import(pathToFileURL(path.join(ROOT, "dist", "sap-tools", "register.js")).href)
              r.handleUserMessage?.(event?.prompt || "")
            } catch { /* 忽略 */ }
          })
        } catch (e) {
          console.log(`[sapbuddy] 授权窗口钩子安装失败: ${e.message}`)
        }
      },
      // MCP 服务器工具动态注册（async factory：设置-MCP 保存的服务器在此生效）
      async (pi) => {
        await registerMcpTools(pi)
      },
    ],
  })
  await loader.reload()

  // 持久化会话到 .pi/sessions（历史会话可用）；指定文件时打开该会话
  const sessionManager = opts.sessionFile
    ? SessionManager.open(opts.sessionFile)
    : SessionManager.create(process.cwd(), path.join(CONFIG_DIR, "sessions"))

  const { session } = await createAgentSession({
    cwd: ROOT,
    resourceLoader: loader,
    modelRuntime,
    model,
    thinkingLevel: settings.defaultThinkingLevel ?? "off",
    sessionManager,
    settingsManager: SettingsManager.inMemory(),
  })
  return { session, settings }
}
