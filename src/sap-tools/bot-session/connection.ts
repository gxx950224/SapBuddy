/**
 * bot session 的连接选择。
 * 只读 connections.json：按 id 或显示名 name 解析，不改写 active，也不改用“当前启用连接”顶替已锁定的会话。
 * 交互式 CLI / Web / MCP 仍走 tools/shared.ts 的 resolveConnectionId，不受这里影响。
 */
import { activeConnectionId, getConfig, type ConnectionConfig } from "../config.js"
import { BotGateError } from "./gates.js"

export type ConnectionSelection = "explicit" | "default"

export interface SelectedConnection {
  id: string
  selection: ConnectionSelection
}

/** open 时解析。显式 selector 优先；省略时用 active，没有 active 则用第一个。 */
export function selectConnectionForOpen(selector?: string): SelectedConnection {
  const connections = getConfig().connections
  if (connections.length === 0) throw new BotGateError("connection_missing", "没有配置任何 SAP 连接")
  const requested = selector?.trim() ?? ""
  if (!requested) {
    let active = ""
    try {
      active = activeConnectionId()
    } catch (err) {
      throw new BotGateError("connection_missing", err instanceof Error ? err.message : String(err))
    }
    const found = findById(connections, active)
    if (!found) throw new BotGateError("connection_missing", `默认连接 ${active} 不在当前配置中`)
    return { id: found.id, selection: "default" }
  }
  return { id: matchSelector(connections, requested).id, selection: "explicit" }
}

/** 会话文件里的 connectionId 必须仍在配置中。找不到就拒绝，不回退到 active。 */
export function requireSessionConnection(connectionId: string): ConnectionConfig {
  const id = String(connectionId ?? "").trim()
  if (!id) throw new BotGateError("connection_missing", "会话没有记录连接，已拒绝。")
  const found = findById(getConfig().connections, id)
  if (!found) {
    const available = getConfig().connections.map((item) => item.id).join(", ")
    throw new BotGateError(
      "connection_missing",
      `会话锁定的连接「${id}」不在当前 connections.json 中（现有: ${available || "(无)"}）。不会改用当前 active 连接。`,
    )
  }
  return found
}

function findById(connections: ConnectionConfig[], id: string): ConnectionConfig | undefined {
  const key = id.toLowerCase()
  return connections.find((item) => item.id.toLowerCase() === key)
}

function matchSelector(connections: ConnectionConfig[], requested: string): ConnectionConfig {
  const byId = findById(connections, requested)
  if (byId) return byId
  const key = requested.toLowerCase()
  const byName = connections.filter((item) => (item.name ?? "").trim().toLowerCase() === key)
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) {
    throw new BotGateError(
      "connection_ambiguous",
      `连接名称「${requested}」对应多个连接：${byName.map((item) => item.id).join(", ")}。请改用连接 id。`,
    )
  }
  const available = connections.map((item) => item.name ? `${item.id}（${item.name}）` : item.id).join(", ")
  throw new BotGateError(
    "connection_missing",
    `找不到连接「${requested}」。可用连接: ${available || "(无)"}。会话不会改用当前 active 连接。`,
  )
}
