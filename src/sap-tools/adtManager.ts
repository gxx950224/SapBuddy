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

function buildClientOptions(conf: ConnectionConfig): ClientOptions {
  const options: ClientOptions = { timeout: 120_000 } // SAP 系统响应慢，放宽超时
  if (conf.url.match(/https:/i)) {
    const ssl = createSSLConfig(conf.ssl?.allowSelfSigned ?? false, conf.ssl?.customCA)
    return { ...options, ...ssl }
  }
  return options
}

function createAdtClient(conf: ConnectionConfig): ADTClient {
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
  return managed.ready.then(() => managed!.client)
}

/** 释放指定连接（用于测试/连接重置） */
export async function dropClient(connId: string): Promise<void> {
  const managed = pool.get(connId.toLowerCase())
  if (!managed) return
  await managed.client.dropSession().catch(() => undefined)
  pool.delete(connId.toLowerCase())
}

/** 释放所有连接 */
export async function dropAllClients(): Promise<void> {
  await Promise.all([...pool.keys()].map(dropClient))
}

export function connectedIds(): string[] {
  return [...pool.keys()]
}
