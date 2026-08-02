/** 工具：获取对象元数据/结构信息（对应 abap_fs 的 get_abap_object_info） */
import { z } from "zod"
import { isClassStructure } from "abap-adt-api"
import { getClient } from "../adtManager.js"
import {
  findObject,
  resolveConnectionId,
  toToolError,
  connectionIdSchema,
  objectTypeSchema,
} from "./shared.js"

export const getObjectInfoTool = {
  name: "get_abap_object_info",
  title: "Get ABAP Object Info",
  description:
    "获取 ABAP 对象的元数据：类型、名称、URI、包、责任人、最后修改时间、子对象列表（如类的 include、程序的事件块）等。" +
    "适合在深入阅读源码前了解对象结构。",
  inputSchema: z.object({
    objectName: z.string().describe("对象名称，如 ZCL_MY_CLASS"),
    objectType: objectTypeSchema,
    connectionId: connectionIdSchema,
  }),
  async execute(args: {
    objectName: string
    objectType?: string
    connectionId?: string
  }): Promise<string> {
    try {
      const connId = await resolveConnectionId(args.connectionId)
      const obj = await findObject(connId, args.objectName, args.objectType)
      if (!obj) {
        return `未找到 ABAP 对象 "${args.objectName}"${args.objectType ? `（类型 ${args.objectType}）` : ""}。` +
          `请先用 search_abap_objects 确认。`
      }
      const client = await getClient(connId)
      const structure = await client.objectStructure(obj["adtcore:uri"])

      const meta = structure.metaData as unknown as Record<string, unknown>
      const lines: string[] = [
        `对象信息: ${obj["adtcore:type"]} ${obj["adtcore:name"]}`,
        `URI: ${obj["adtcore:uri"]}`,
        `描述: ${meta["adtcore:description"] ?? "(无)"}`,
      ]
      if (meta["adtcore:packageName"]) lines.push(`包: ${meta["adtcore:packageName"]}`)
      if (meta["adtcore:responsible"]) lines.push(`责任人: ${meta["adtcore:responsible"]}`)
      if (meta["adtcore:version"]) lines.push(`版本: ${meta["adtcore:version"]}`)
      if (meta["adtcore:changedBy"]) {
        const at = typeof meta["adtcore:changedAt"] === "number"
          ? new Date(meta["adtcore:changedAt"] as number).toISOString()
          : "?"
        lines.push(`最后修改: ${meta["adtcore:changedBy"]} @ ${at}`)
      }

      if (isClassStructure(structure)) {
        const includes = structure.includes ?? []
        if (includes.length > 0) {
          lines.push("", `类 include（${includes.length} 个）:`)
          for (const inc of includes) {
            lines.push(`  - [${inc["class:includeType"]}] ${inc["adtcore:name"]}`)
          }
        }
      }
      return lines.join("\n")
    } catch (err) {
      return toToolError(err)
    }
  },
}
