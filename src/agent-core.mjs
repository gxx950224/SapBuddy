/**
 * Agent 内核：pi SDK 会话管理 + 注册 41 个 SAP 工具
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
 * 用户配置目录：固定在主目录 ~/.SapBuddy（无论在哪里运行 sapbuddy，配置都在同一个地方）
 * auth/settings/models/connections/sessions/skills/prompts/output 都在这里
 */
export const CONFIG_DIR = path.join(os.homedir(), ".SapBuddy")
/** 旧版迁移源：cwd/.SapBuddy 与项目根 .SapBuddy（之前版本配置跟随运行目录/项目根） */
const LEGACY_CWD_CONFIG = path.join(process.cwd(), ".SapBuddy")
const LEGACY_ROOT_CONFIG = path.join(ROOT, ".SapBuddy")
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
 * 创建带 41 个 SAP 工具的 Agent 会话
 * @param opts.sessionFile 指定会话文件（切换历史会话用）
 */
/** 技能默认内容同步：包内 defaults/skills 首次运行整体拷贝；升级时合并补发本地缺失的技能（已有技能视为用户管理，不覆盖） */
export function syncDefaultSkills(dst, defaultsSrc, legacySrc) {
  if (!fs.existsSync(dst)) {
    // 首次运行：整体拷贝（旧 cwd/.pi 优先，其次包内 defaults/）
    for (const src of [legacySrc, defaultsSrc]) {
      if (fs.existsSync(src)) { fs.cpSync(src, dst, { recursive: true }); break }
    }
    return
  }
  // 升级场景：skills 目录已存在 → 合并补发 defaults 中本地缺失的技能（已有技能视为用户管理，不覆盖）
  if (fs.existsSync(defaultsSrc)) {
    try {
      for (const e of fs.readdirSync(defaultsSrc, { withFileTypes: true })) {
        const s = path.join(defaultsSrc, e.name)
        const d = path.join(dst, e.name)
        if (fs.existsSync(d)) continue
        if (e.isDirectory()) fs.cpSync(s, d, { recursive: true })
        else fs.copyFileSync(s, d)
      }
    } catch { /* 单个技能补发失败不影响整体 */ }
  }
}
/** 系统提示默认内容同步：AGENTS.md / SYSTEM.md 随包版本更新（升级时覆盖为包内最新，本地改动请同步回仓库）；Memory.md 为 AI 记忆，首次 seed 后永不覆盖（用户管理） */
export function syncDefaultPrompts(dstPrompts, pkgRoot) {
  let pkgVersion = ""
  try { pkgVersion = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8")).version ?? "" } catch { /* 忽略 */ }
  fs.mkdirSync(dstPrompts, { recursive: true })
  const stateFile = path.join(dstPrompts, ".version")
  let lastSync = ""
  try { lastSync = fs.readFileSync(stateFile, "utf8").trim() } catch { /* 首次运行 */ }
  const upgraded = !!pkgVersion && lastSync !== pkgVersion
  for (const f of ["AGENTS.md", "SYSTEM.md"]) {
    const s = path.join(pkgRoot, f)
    const d = path.join(dstPrompts, f)
    if (!fs.existsSync(s)) continue
    if (upgraded || !fs.existsSync(d)) {
      try { fs.copyFileSync(s, d) } catch { /* 单个文件同步失败不影响整体 */ }
    }
  }
  for (const f of ["Memory.md"]) {
    const d = path.join(dstPrompts, f)
    if (fs.existsSync(d)) continue
    const s = path.join(pkgRoot, f)
    if (fs.existsSync(s)) { try { fs.copyFileSync(s, d) } catch { /* 忽略 */ } }
  }
  if (upgraded) { try { fs.writeFileSync(stateFile, pkgVersion) } catch { /* 忽略 */ } }
}

/** 首次运行引导：初始化 ~/.SapBuddy（技能/提示词/模型注册表），来源优先旧配置 cwd/.pi（迁移）→ 包内默认 */
export function ensureRuntimeFiles() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
    // 历史配置迁移：旧版 cwd/.SapBuddy、项目根 .SapBuddy → 主目录 ~/.SapBuddy（合并不覆盖，仅补缺）
    for (const src of [LEGACY_ROOT_CONFIG, LEGACY_CWD_CONFIG]) {
      if (src === CONFIG_DIR || !fs.existsSync(src)) continue
      try {
        for (const f of fs.readdirSync(src)) {
          const s = path.join(src, f)
          const d = path.join(CONFIG_DIR, f)
          if (fs.existsSync(d)) continue
          if (fs.statSync(s).isDirectory()) fs.cpSync(s, d, { recursive: true })
          else fs.copyFileSync(s, d)
        }
      } catch { /* 单个源失败不影响整体 */ }
    }
    // 技能默认内容（来源：旧 cwd/.pi → 包内 defaults/，随 npm 包发布；升级时合并补发缺失技能）。
    // ⚠️ 不再迁移 prompts（已弃用，由技能覆盖）
    for (const sub of ["skills"]) {
      syncDefaultSkills(path.join(CONFIG_DIR, sub), path.join(ROOT, "defaults", sub), path.join(LEGACY_PI, sub))
    }
    // 配置示例模板：拷贝到 ~/.SapBuddy/config/（用户照着填，存在不覆盖）
    const dstCfg = path.join(CONFIG_DIR, "config")
    fs.mkdirSync(dstCfg, { recursive: true })
    for (const ex of ["auth.example.json", "connections.example.json", "settings.example.json"]) {
      const d = path.join(dstCfg, ex)
      if (fs.existsSync(d)) continue
      const s = path.join(ROOT, "config", ex)
      if (fs.existsSync(s)) { try { fs.copyFileSync(s, d) } catch { /* 忽略 */ } }
    }
    // 配置文件初始生成：缺失时用 config/ 下的示例模板 seed（auth/settings），旧配置/默认值仍可作源
    const EXAMPLE_MAP = { "auth.json": "auth.example.json", "settings.json": "settings.example.json" }
    for (const f of ["models.json", "auth.json", "settings.json"]) {
      const dst = path.join(CONFIG_DIR, f)
      if (fs.existsSync(dst)) continue
      const srcs = [path.join(LEGACY_PI, f)]
      if (EXAMPLE_MAP[f]) srcs.push(path.join(ROOT, "config", EXAMPLE_MAP[f]))
      srcs.push(path.join(ROOT, "defaults", f))
      for (const src of srcs) {
        if (fs.existsSync(src)) { fs.copyFileSync(src, dst); break }
      }
    }
    // 多模态模型能力补全：openai-completions 通道只有模型声明 input 含 "image" 才会真正把图片发给模型，
    // 否则 pi 会在发送前把图片降级成占位符（模型仍显示"看不到图"）。
    // 统一策略：所有模型默认允许发图（input=["text","image"]），模型若不支持图片由 API 层报错（用户可见）。
    // 只补 input，不改 reasoning/thinkingLevelMap/contextWindow/maxTokens，避免给其它模型误设属性。
    try {
      const mf = path.join(CONFIG_DIR, "models.json")
      if (fs.existsSync(mf)) {
        const mj = JSON.parse(fs.readFileSync(mf, "utf8"))
        let changed = false
        for (const prov of Object.values(mj?.providers ?? {})) {
          for (const m of prov?.models ?? []) {
            if (!(Array.isArray(m.input) && m.input.includes("image"))) {
              m.input = ["text", "image"]
              changed = true
            }
          }
        }
        if (changed) {
          fs.writeFileSync(mf, JSON.stringify(mj, null, 2))
          console.log("[sapbuddy] 已为全部模型补全多模态 input 能力")
        }
      }
    } catch { /* 补全失败不影响运行 */ }
    if (!fs.existsSync(path.join(CONFIG_DIR, "connections.json"))) {
      for (const src of [path.join(LEGACY_PI, "connections.json"), path.join(process.cwd(), "connections.json"), path.join(ROOT, "config", "connections.example.json")]) {
        if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(CONFIG_DIR, "connections.json")); break }
      }
    }
    // 系统提示/记忆默认内容同步（AGENTS/SYSTEM 随包版本更新；Memory 首次 seed 后不覆盖）
    syncDefaultPrompts(path.join(CONFIG_DIR, "prompts"), ROOT)
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
      for (const src of [path.join(LEGACY_PI, "mcp.json")]) {
        if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(CONFIG_DIR, "mcp.json")); break }
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

  // 系统提示/记忆：主目录 ~/.SapBuddy/prompts 优先（用户定制），不存在回退包内默认
  const promptFile = (name) => { const f = path.join(CONFIG_DIR, "prompts", name); return fs.existsSync(f) ? f : path.join(ROOT, name) }
  const loader = new DefaultResourceLoader({
    cwd: ROOT,
    agentDir: CONFIG_DIR,
    settingsManager: SettingsManager.inMemory(),
    appendSystemPrompt: [promptFile("SYSTEM.md"), promptFile("Memory.md")], // 与 CLI 一致：主目录优先，回退包内
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
        const { registerMcpTools } = await import(pathToFileURL(path.join(ROOT, "src", "sap-tools", "mcp-register.mjs")).href)
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
  return { session, settings, modelRuntime }
}
