/**
 * ADT 客户端池：按连接 ID 懒创建 ADTClient，复用连接，统一错误处理
 * 认证：basic（用户名/密码）| oauth（S/4HANA OAuth client credentials）
 */
import { ADTClient, ClientOptions } from "abap-adt-api"
import { createSSLConfig } from "abap-adt-api"
import { ConnectionConfig, getConfig } from "./config.js"

interface ManagedClient {
  client: ADTClient
  /** 保证并发下只 login 一次 */
  ready: Promise<void>
}

const pool = new Map<string, ManagedClient>()

/**
 * 每连接互斥锁：ADTClient 是共享状态（cookie jar / stateful 会话），
 * 并行工具调用会互相踩踏（解锁命中错误会话 → 残留编辑锁）。用 promise 链把
 * 同一连接上的所有操作串行化。并发场景下后到的调用排队等待先到的完成。
 */
const mutexQueues = new Map<string, Promise<unknown>>()

/** 串行执行：同一连接 id 上的操作按顺序执行，互不并发。 */
export function withConnMutex<T>(connId: string, fn: () => Promise<T>): Promise<T> {
  const id = connId.toLowerCase()
  const prev = mutexQueues.get(id) ?? Promise.resolve()
  const next = prev.catch(() => undefined).then(fn)
  // 存 settled 后的 promise，保证队列不因某次失败而卡死；错误仍向调用方抛出
  mutexQueues.set(id, next.catch(() => undefined))
  return next
}

/**
 * 标记连接为不健康：从池中移除缓存（客户端 + 类别），下次调用自动重新 login。
 * 会话自愈的核心——连接级故障（401/5xx/网络错误）不保留坏会话，宁可重连。
 */
export function markConnectionUnhealthy(connId: string): void {
  const id = connId.toLowerCase()
  pool.delete(id)
  clientCategoryCache.delete(id)
}

/** 判断是否连接级故障（会话失效/网络断了），而非业务错误 */
export function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const status = (err as { status?: unknown }).status
  if (typeof status === "number") return status === 401 || status === 403 || status >= 500
  return /ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|EPIPE|socket hang up|fetch failed|Failed to fetch|network error|read ECONNRESET|write EPIPE|CERT_|self-signed/.test(
    err.message
  )
}

/** 包装客户端：方法抛连接级错误时自动标记不健康，实现自愈 */
function wrapSelfHeal(client: ADTClient, connId: string): ADTClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== "function") return value
      return (...args: unknown[]) => {
        try {
          const result = value.apply(target, args)
          if (result && typeof (result as Promise<unknown>).then === "function") {
            return (result as Promise<unknown>).catch((err: unknown) => {
              if (isConnectionError(err)) markConnectionUnhealthy(connId)
              throw err
            })
          }
          return result
        } catch (err) {
          if (isConnectionError(err)) markConnectionUnhealthy(connId)
          throw err
        }
      }
    },
  })
}

/** 客户端类别缓存：connId → T000.CCCATEGORY（P=生产 T=测试 C=定制 D=演示 E=培训/教育 S=SAP参考） */
const clientCategoryCache = new Map<string, Promise<string>>()

/**
 * 获取客户端类别（T000.CCCATEGORY），按连接缓存
 * 查询失败时抛出（fail-closed）
 */
export function getClientCategory(connId: string): Promise<string> {
  const id = connId.toLowerCase()
  let p = clientCategoryCache.get(id)
  if (!p) {
    p = (async () => {
      const conf = getConnection(id)
      const client = await getClient(id)
      const result = await client.runQuery(
        `SELECT MANDT, CCCATEGORY FROM T000 WHERE MANDT = '${conf.client}'`,
        1,
        true
      )
      const row = (result?.values?.[0] ?? {}) as Record<string, unknown>
      return String(row.CCCATEGORY ?? "").toUpperCase()
    })().catch((err) => {
      clientCategoryCache.delete(id)
      throw err
    })
    clientCategoryCache.set(id, p)
  }
  return p
}

/** T000.CCCATEGORY 官方角色标签 */
export const CLIENT_CATEGORY_LABELS: Record<string, string> = {
  P: "生产",
  T: "测试",
  C: "定制(客户开发)",
  D: "演示",
  E: "培训/教育",
  S: "SAP 参考",
}

/**
 * 写操作安全守卫：只允许在开发类客户端上修改代码。
 * SAP 官方角色中仅 C（定制/客户开发）允许开发；
 * 测试（T）/生产（P）/演示（D）/培训（E）/SAP参考（S）一律拦截。
 * 默认 developmentCategories=["C"]，可用连接配置调整。
 * 无法确认类别时 fail-closed（拒绝）。
 * 连接配置 security.requireDevClient=false 可显式放行（不推荐）。
 */
export async function assertDevClient(connId: string): Promise<void> {
  const conf = getConnection(connId)
  if (conf.security?.requireDevClient === false) return
  const allow = (conf.security?.developmentCategories ?? ["C"]).map((c) => c.toUpperCase())
  let category: string
  try {
    category = await getClientCategory(connId)
  } catch (err) {
    throw new Error(
      `无法确认客户端 ${conf.client}（连接 ${conf.id}）的类别，已按安全策略拒绝写操作。` +
        `原因: ${err instanceof Error ? err.message : String(err)}。` +
        `如确认该连接为开发机，请检查账号的 T000 查询权限；` +
        `或在连接配置中显式设置 security.requireDevClient=false 放行（不推荐）。`
    )
  }
  if (allow.includes(category)) return // 开发类客户端放行
  const label = CLIENT_CATEGORY_LABELS[category] ?? `未知(${category || "未维护"})`
  throw new Error(
    `安全拦截：客户端 ${conf.client}（连接 ${conf.id}）属于 ${label} 环境（T000.CCCATEGORY=${category || "未维护"}）。` +
      `只允许在开发类客户端（${allow.join("/")}，SAP 角色 C=定制）上修改代码，` +
      `测试/生产/演示/培训/SAP参考 客户端禁止任何写操作（创建/修改/激活/删除/DDIC 变更/传输等）。`
  )
}

function buildClientOptions(conf: ConnectionConfig): ClientOptions {
  const options: ClientOptions = { timeout: 120_000 } // SAP 系统响应慢，放宽超时
  if (conf.url.match(/https:/i)) {
    const ssl = createSSLConfig(conf.ssl?.allowSelfSigned ?? false, conf.ssl?.customCA)
    return { ...options, ...ssl }
  }
  return options
}

let clientFactoryOverride: ((conf: ConnectionConfig) => ADTClient) | null = null

/** 测试专用：注入假客户端工厂（仅单测验证错误路径用，生产勿调） */
export function __setClientFactoryForTest(fn: ((conf: ConnectionConfig) => ADTClient) | null): void {
  clientFactoryOverride = fn
}

function createAdtClient(conf: ConnectionConfig): ADTClient {
  if (clientFactoryOverride) return clientFactoryOverride(conf)
  const options = buildClientOptions(conf)

  if (conf.authMethod === "oauth" && conf.oauth) {
    const oauth = conf.oauth
    // BearerFetcher：每次需要 token 时自动获取（含缓存由 abap-adt-api 管理）
    const fetchBearer = async (): Promise<string> => {
      const params = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
      })
      if (oauth.scope) params.set("scope", oauth.scope)
      const res = await fetch(oauth.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params,
      })
      if (!res.ok) {
        throw new Error(`OAuth token 获取失败: HTTP ${res.status} ${await res.text().catch(() => "")}`)
      }
      const json = (await res.json()) as { access_token: string }
      return json.access_token
    }
    return new ADTClient(conf.url, conf.username, fetchBearer, conf.client, conf.language, options)
  }

  return new ADTClient(conf.url, conf.username, conf.password, conf.client, conf.language, options)
}

export function getConnection(id: string): ConnectionConfig {
  const conf = getConfig().connections.find((c) => c.id === id.toLowerCase())
  if (!conf) {
    const available = getConfig().connections.map((c) => c.id).join(", ")
    throw new Error(
      `未知的连接 ID: "${id}"。可用连接: ${available || "(无)"}。请先用 get_connected_systems 工具查看可用连接。`
    )
  }
  return conf
}

/** 获取（并懒初始化）ADTClient，自动 login */
export function getClient(connId: string): Promise<ADTClient> {
  const conf = getConnection(connId)

  let managed = pool.get(conf.id)
  if (!managed) {
    const client = createAdtClient(conf)
    const ready = client.login().catch((err) => {
      // 登录失败时移除缓存，允许下次重试
      pool.delete(conf.id)
      throw err
    })
    managed = { client, ready }
    pool.set(conf.id, managed)
  }
  // 包自愈代理：连接级故障自动标记不健康 → 下次调用重新 login
  return managed.ready.then(() => wrapSelfHeal(managed!.client, conf.id))
}

/** 释放指定连接（用于测试/连接重置） */
export async function dropClient(connId: string): Promise<void> {
  const managed = pool.get(connId.toLowerCase())
  if (!managed) return
  await managed.client.dropSession().catch(() => undefined)
  pool.delete(connId.toLowerCase())
  clientCategoryCache.delete(connId.toLowerCase())
}

/** 释放所有连接 */
export async function dropAllClients(): Promise<void> {
  await Promise.all([...pool.keys()].map(dropClient))
  clientCategoryCache.clear()
}

export function connectedIds(): string[] {
  return [...pool.keys()]
}
