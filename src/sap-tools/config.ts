/**
 * 连接配置加载：支持多 SAP 系统、${ENV} 环境变量展开（secret manager 友好）
 *
 * 配置文件示例见 connections.example.json
 * 可通过环境变量 ABAP_MCP_CONFIG 指定配置文件路径，
 * 默认读取 ~/.SapBuddy/connections.json（兼容旧版项目根 connections.json）
 */
import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { homedir } from "node:os"

export interface ConnectionConfig {
  /** 连接 ID，工具调用时用 connectionId 指定，如 "dev" */
  id: string
  /** SAP 系统地址，如 https://sap-dev.example.com:443 */
  url: string
  /** SAP 客户端，如 100 */
  client: string
  username: string
  password: string
  /** 登录语言，默认 EN */
  language?: string
  /** 认证方式：basic | oauth（oauth 需配置 oauth 段） */
  authMethod?: "basic" | "oauth"
  /** OAuth2 client credentials（用于 S/4HANA OAuth 场景） */
  oauth?: {
    tokenUrl: string
    clientId: string
    clientSecret: string
    scope?: string
  }
  ssl?: {
    /** 允许自签名证书（内网 SAP 常用），默认 false */
    allowSelfSigned?: boolean
    /** 自定义 CA 证书路径 */
    customCA?: string
  }
  /**
   * 安全策略
   * requireDevClient: 默认 true——仅允许在开发类客户端上写操作；设为 false 可显式放行（不推荐）
   * developmentCategories: 视为开发机的 T000.CCCATEGORY 列表，默认 ["C"]（SAP 角色：C=定制/客户开发）
   *   P=生产、T=测试、C=定制(开发)、D=演示、E=培训/教育、S=SAP参考
   */
  security?: {
    requireDevClient?: boolean
    developmentCategories?: string[]
  }
  description?: string
}

export interface ServerSecurity {
  /** HTTP 模式下校验 Bearer token（企业网关场景建议启用） */
  apiKey?: string
  /**
   * 只读模式：为 true 时拒绝任何写工具调用（企业治理推荐默认开启）
   * 当前版本仅实现只读工具，默认 true
   */
  readOnly?: boolean
}

export interface ServerConfig {
  connections: ConnectionConfig[]
  security?: ServerSecurity
}

/** 展开 ${ENV_VAR} 占位符 */
function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, name: string) => {
    const env = process.env[name]
    if (env === undefined) {
      throw new Error(`环境变量 ${name} 未设置（配置项引用了 ${value}）`)
    }
    return env
  })
}

function resolveConfigPath(): string {
  if (process.env.ABAP_MCP_CONFIG) return resolve(process.env.ABAP_MCP_CONFIG)
  const user = resolve(process.cwd(), ".SapBuddy", "connections.json")
  if (existsSync(user)) return user
  const home = resolve(homedir(), ".SapBuddy", "connections.json")
  if (existsSync(home)) return home // 兼容旧版：主目录配置
  return resolve(process.cwd(), "connections.json") // 兼容旧版：项目根配置
}

export function loadConfig(): ServerConfig {
  const path = resolveConfigPath()
  if (!existsSync(path)) {
    throw new Error(
      `未找到连接配置文件: ${path}\n` +
        `请复制 connections.example.json 为 connections.json 并填写 SAP 系统信息，` +
        `或用环境变量 ABAP_MCP_CONFIG 指定路径。`
    )
  }
  const raw = JSON.parse(readFileSync(path, "utf-8")) as ServerConfig

  if (!Array.isArray(raw.connections) || raw.connections.length === 0) {
    throw new Error(`配置文件 ${path} 中 connections 为空，至少需要一个 SAP 连接`)
  }

  const connections = raw.connections.map((c) => {
    const id = c.id.toLowerCase()
    return {
      ...c,
      id,
      language: c.language ?? "EN",
      authMethod: c.authMethod ?? "basic",
      username: expandEnv(c.username),
      password: expandEnv(c.password),
      oauth: c.oauth
        ? {
            ...c.oauth,
            clientSecret: expandEnv(c.oauth.clientSecret),
          }
        : undefined,
      apiKey: undefined as never,
    }
  })

  const ids = new Set(connections.map((c) => c.id))
  if (ids.size !== connections.length) {
    throw new Error(`配置文件中有重复的连接 ID: ${[...ids].join(", ")}`)
  }

  return {
    connections,
    security: {
      readOnly: raw.security?.readOnly ?? true,
      apiKey: raw.security?.apiKey !== undefined ? expandEnv(raw.security.apiKey) : undefined,
    },
  }
}

/** 供 tools 获取当前配置（避免每次重新读文件） */
let cached: ServerConfig | undefined
export function getConfig(): ServerConfig {
  if (!cached) cached = loadConfig()
  return cached
}

export function reloadConfig(): ServerConfig {
  cached = loadConfig()
  return cached
}
