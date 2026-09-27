/** 工具：列出可用 SAP 连接（相当于 abap_fs 的 get_connected_systems） */
import { z } from "zod"
import { getConfig, activeConnectionId } from "../config.js"
import { getClientCategory, CLIENT_CATEGORY_LABELS, withAllConnMutex, clearConnectionDirty } from "../adtManager.js"

export const connectedSystemsTool = {
  name: "get_connected_systems",
  title: "Get Connected Systems",
  description:
    "返回用户当前启用的 SAP 连接。只探测当前系统，不访问其他连接。连接失败时禁止自动切换系统，必须请用户在设置中切换。连接配置被修改后必须先调用本工具。",
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
      for (const c of config.connections.filter(c => c.id === activeId)) {
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
        `可用 SAP 连接（仅当前启用连接）:\n${lines.join("\n")}\n\n禁止自动切换系统；如需其他系统，请用户在连接设置中切换。\n` +
        `安全策略: ${config.security?.readOnly === false ? "允许写操作（受开发客户端守卫约束）" : "只读模式开启（仅只读工具）"}`
      )
    })
  },
}
