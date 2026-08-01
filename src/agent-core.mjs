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

/**
 * MCP 服务器工具动态注册（方案 C 扩展）：
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
    return JSON.parse(fs.readFileSync(path.join(ROOT, ".pi", "settings.json"), "utf8"))
  } catch {
    return {}
  }
}

/**
 * 创建带 42 个 SAP 工具的 Agent 会话
 * @param opts.sessionFile 指定会话文件（切换历史会话用）
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
      console.log(`[sapbuddy] 模型 ${provider}/${modelId} 未找到，回退 ${model?.id ?? "默认"}`)
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
          console.log(`[sapbuddy] 已注册 ${n} 个 SAP 工具`)
        } catch (e) {
          console.log(`[sapbuddy] 工具注册失败: ${e.message}`)
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
    : SessionManager.create(ROOT)

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
