/** 工具：列出可用 SAP 连接（相当于 abap_fs 的 get_connected_systems） */
import { z } from "zod"
import { getConfig, activeConnectionId } from "../config.js"
import { getClientCategory, CLIENT_CATEGORY_LABELS, withAllConnMutex, clearConnectionDirty } from "../adtManager.js"

export const connectedSystemsTool = {
  name: "get_connected_systems",
  title: "Get Connected Systems",
  description:
    "列出所有已配置的 SAP 系统连接 ID。调用任何其他工具前，如不确定 connectionId，请先调用本工具确认可用的连接 ID。连接配置被修改后必须先调用本工具（其他工具会被拦截直到本工具成功）。",
  inputSchema: z.object({}),
  async execute(): Promise<string> {
    // 全连接独占：连接切换后必须单独执行，其他请求不能与它并行
    return withAllConnMutex(async () => {
      const config = getConfig()
      if (config.connections.length === 0) {
        return "未配置任何 SAP 连接。请在 connections.json 中配置后再使用。"
      }
      const lines: string[] = []
      const activeId = activeConnectionId()
      for (const c of config.connections) {
        const auth = c.authMethod === "oauth" ? "OAuth2" : "Basic"
        // 客户端类别 + 写操作守卫状态（T000.CCCATEGORY）
        let guard = "类别未知（写操作将被拦截）"
        try {
          const cat = await getClientCategory(c.id)
          const label = CLIENT_CATEGORY_LABELS[cat] ?? `未知(${cat || "未维护"})`
          const allow = (c.security?.developmentCategories ?? ["C"]).map((x) => x.toUpperCase())
          guard = allow.includes(cat) ? `写操作: 允许（${label}）` : `写操作: 拦截（${label}）`
        } catch (e) { console.error(`[sapbuddy] 客户端类别查询失败（${c.id}）: ${e instanceof Error ? e.message.slice(0, 120) : e}`) /* 类别查询失败，默认拦截 */ }
        const isActive = c.id === activeId
        const label = c.name || c.id
        const idPart = c.id !== label ? ` [${c.id}]` : ""
        lines.push(`- ${label}${isActive ? "（当前使用）" : ""}${idPart} ${c.url}  Client: ${c.client}  Auth: ${auth}  ${guard}${c.description ? `  (${c.description})` : ""}`)
      }
      // 连接确认成功 → 清除"连接已变更"强制标记，放行其他工具
      clearConnectionDirty()
      return (
        `可用 SAP 连接（${config.connections.length} 个）:\n${lines.join("\n")}\n\n` +
        `安全策略: ${config.security?.readOnly === false ? "允许写操作（受开发客户端守卫约束）" : "只读模式开启（仅只读工具）"}`
      )
    })
  },
}
