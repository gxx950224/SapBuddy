/** 工具：where-used 引用分析（对应 abap_fs 的 find_where_used） */
import { z } from "zod"
import { getClient } from "../adtManager.js"
import {
  findObject,
  resolveConnectionId,
  toToolError,
  connectionIdSchema,
  objectTypeSchema,
} from "./shared.js"

export const whereUsedTool = {
  name: "find_where_used",
  title: "Find Where Used",
  description:
    "查找 ABAP 对象被引用的位置（where-used）：哪些对象调用了它、使用了它。" +
    "用于变更影响分析、依赖分析。返回引用对象的名称、类型、包和使用信息。" +
    "可设置 includeSnippets=true 附上引用处那一段代码，直接看引用上下文（比只报位置更能判断影响）。",
  inputSchema: z.object({
    objectName: z.string().describe("对象名称，如 ZCL_MY_CLASS、ZREPORT、结构 ZS_HEADER"),
    objectType: objectTypeSchema,
    connectionId: connectionIdSchema,
    maxResults: z.number().int().min(1).max(200).optional().describe("最大返回条数，默认 50"),
    includeSnippets: z
      .boolean()
      .optional()
      .describe("是否附上每处引用的代码片段（默认 false；开启会额外请求服务器，返回内容更多）"),
  }),
  async execute(args: {
    objectName: string
    objectType?: string
    connectionId?: string
    maxResults?: number
    includeSnippets?: boolean
  }): Promise<string> {
    try {
      const connId = await resolveConnectionId(args.connectionId)
      const obj = await findObject(connId, args.objectName, args.objectType)
      if (!obj) {
        return `未找到 ABAP 对象 "${args.objectName}"${args.objectType ? `（类型 ${args.objectType}）` : ""}。` +
          `请先用 search_abap_objects 确认。`
      }
      const client = await getClient(connId)
      const max = args.maxResults ?? 50

      // usageReferences 需要源码上下文定位，这里用对象 URI 全量分析
      const refs = await client.usageReferences(obj["adtcore:uri"])

      if (!refs || refs.length === 0) {
        return `${obj["adtcore:type"]} ${args.objectName} 未找到引用。可能未被任何对象使用，或引用分析被授权限制。`
      }

      const shown = refs.slice(0, max)
      const lines: string[] = [
        `${obj["adtcore:type"]} ${args.objectName} 被 ${refs.length} 处引用${max < refs.length ? `（显示前 ${max} 条）` : ""}:`,
      ]
      for (const r of shown) {
        const type = r["adtcore:type"] ?? "?"
        const name = r["adtcore:name"] ?? r.objectIdentifier
        const info = r.usageInformation ? ` - ${r.usageInformation}` : ""
        const pkg = r.packageRef?.["adtcore:name"] ? ` [${r.packageRef["adtcore:name"]}]` : ""
        const parent = r.parentUri && r.parentUri !== r.uri ? ` (父对象: ${r.parentUri.split("/").pop()})` : ""
        lines.push(`${type.padEnd(6)} ${name}${pkg}${parent}${info}`)
      }
      if (refs.length > max) {
        lines.push("", `提示: 还有 ${refs.length - max} 条未显示，可用更大的 maxResults 获取。`)
      }

      if (args.includeSnippets && shown.length > 0) {
        try {
          const snippets = await client.usageReferenceSnippets(shown)
          lines.push("", "引用处代码片段:")
          for (const s of snippets) {
            const refName = s.objectIdentifier || "?"
            for (const sn of s.snippets ?? []) {
              const where = sn.uri?.uri ? sn.uri.uri.split("/").pop() : refName
              const at = sn.uri?.start ? ` @${sn.uri.start.line}:${sn.uri.start.column}` : ""
              const content = String(sn.content ?? "").replace(/\s+/g, " ").trim()
              lines.push(`- ${where}${at}: ${content.slice(0, 200)}`)
            }
          }
        } catch {
          lines.push("", "（引用代码片段获取失败，仅显示位置信息）")
        }
      }
      return lines.join("\n")
    } catch (err) {
      return toToolError(err)
    }
  },
}
