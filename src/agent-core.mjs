/**
 * Agent 内核：pi SDK 会话管理 + 注册 42 个 SAP 工具
 */
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"
import fs from "node:fs"

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, "..")

// pi SDK 通过绝对路径 require 加载（项目结构特殊，与 webide/server.mjs 一致）
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
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, ".pi", "auth.json"), "utf8"))
  } catch {
    return {}
  }
}

/** 读取设置（默认模型等） */
export function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, ".pi", "settings.json"), "utf8"))
  } catch {
    return {}
  }
}

/**
 * 创建带 42 个 SAP 工具的 Agent 会话
 */
export async function createAgent(opts = {}) {
  // 动态 import 工具注册层（编译产物 dist/sap-tools/register.js）
  const { registerSapTools } = await import(
    pathToFileURL(path.join(ROOT, "dist", "sap-tools", "register.js")).href
  )

  const settings = loadSettings()

  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(ROOT, ".pi", "auth.json"),
    modelsPath: path.join(ROOT, ".pi", "models.json"),
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
      console.log(`[abapbuddy] 模型 ${provider}/${modelId} 未找到，回退 ${model?.id ?? "默认"}`)
    }
  } catch {
    model = undefined
  }

  const loader = new DefaultResourceLoader({
    cwd: ROOT,
    agentDir: path.join(ROOT, ".pi"),
    settingsManager: SettingsManager.inMemory(),
    extensionFactories: [
      (pi) => {
        // 加载期直接注册（不能调 getAllTools 等 action method，registerTool 本身可用）
        try {
          const n = registerSapTools(pi)
          console.log(`[abapbuddy] 已注册 ${n} 个 SAP 工具`)
        } catch (e) {
          console.log(`[abapbuddy] 工具注册失败: ${e.message}`)
        }
      },
    ],
  })
  await loader.reload()

  const { session } = await createAgentSession({
    cwd: ROOT,
    resourceLoader: loader,
    modelRuntime,
    model,
    thinkingLevel: settings.defaultThinkingLevel ?? "off",
    // 持久化会话到 .pi/sessions（历史会话可用）
    sessionManager: SessionManager.create(ROOT),
    settingsManager: SettingsManager.inMemory(),
  })
  return { session, settings }
}
