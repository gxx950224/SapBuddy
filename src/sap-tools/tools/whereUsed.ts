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
    "用于变更影响分析、依赖分析。返回引用对象的名称、类型、包和使用信息。",
  inputSchema: z.object({
    objectName: z.string().describe("对象名称，如 ZCL_MY_CLASS、ZREPORT、结构 ZS_HEADER"),
    objectType: objectTypeSchema,
    connectionId: connectionIdSchema,
    maxResults: z.number().int().min(1).max(200).optional().describe("最大返回条数，默认 50"),
  }),
  async execute(args: {
    objectName: string
    objectType?: string
    connectionId?: string
    maxResults?: number
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

      const lines: string[] = [
        `${obj["adtcore:type"]} ${args.objectName} 被 ${refs.length} 处引用${max < refs.length ? `（显示前 ${max} 条）` : ""}:\n`,
      ]
      const shown = refs.slice(0, max)
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
      return lines.join("\n")
    } catch (err) {
      return toToolError(err)
    }
  },
}
