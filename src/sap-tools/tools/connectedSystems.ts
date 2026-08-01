/** 工具：列出可用 SAP 连接（相当于 abap_fs 的 get_connected_systems） */
import { z } from "zod"
import { getConfig } from "../config.js"

export const connectedSystemsTool = {
  name: "get_connected_systems",
  title: "Get Connected Systems",
  description:
    "列出所有已配置的 SAP 系统连接 ID。调用任何其他工具前，如不确定 connectionId，请先调用本工具确认可用的连接 ID。",
  inputSchema: z.object({}),
  async execute(): Promise<string> {
    const config = getConfig()
    if (config.connections.length === 0) {
      return "未配置任何 SAP 连接。请在 connections.json 中配置后再使用。"
    }
    const lines = config.connections.map((c) => {
      const auth = c.authMethod === "oauth" ? "OAuth2" : "Basic"
      return `- ${c.id.padEnd(12)} ${c.url}  Client: ${c.client}  Auth: ${auth}${c.description ? `  (${c.description})` : ""}`
    })
    return (
      `可用 SAP 连接（${config.connections.length} 个）:\n${lines.join("\n")}\n\n` +
      `只读模式: ${config.security?.readOnly === false ? "关闭（允许写操作）" : "开启（仅只读工具）"}`
    )
  },
}
