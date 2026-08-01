/** 工具：读取 ABAP 对象源码（对应 abap_fs 的 get_abap_object_lines） */
import { z } from "zod"
import { getClient } from "../adtManager.js"
import {
  findObject,
  readSourceSmart,
  resolveConnectionId,
  toToolError,
  connectionIdSchema,
  objectTypeSchema,
} from "./shared.js"

export const getObjectLinesTool = {
  name: "get_abap_object_lines",
  title: "Get ABAP Object Lines",
  description:
    "读取 ABAP 对象的完整源码或指定行区间。支持类、报表、函数组、表等所有 ADT 对象。" +
    "通过对象名称+类型定位（对象不存在时会先给出搜索建议）。" +
    "读取类时可用 methodName 只提取某个方法，节省上下文。",
  inputSchema: z.object({
    objectName: z.string().describe("对象名称，如 ZCL_MY_CLASS、ZREPORT"),
    objectType: objectTypeSchema,
    connectionId: connectionIdSchema,
    methodName: z
      .string()
      .optional()
      .describe("类对象专用：只提取该方法的实现代码（METHOD xxx. 到 ENDMETHOD.）"),
    startLine: z.number().int().min(1).optional().describe("起始行号（1 起），省略则从头开始"),
    lineCount: z.number().int().min(1).max(5000).optional().describe("读取行数，省略则读取全部"),
  }),
  async execute(args: {
    objectName: string
    objectType?: string
    connectionId?: string
    methodName?: string
    startLine?: number
    lineCount?: number
  }): Promise<string> {
    try {
      const connId = await resolveConnectionId(args.connectionId)
      const obj = await findObject(connId, args.objectName, args.objectType)
      if (!obj) {
        return `未找到 ABAP 对象 "${args.objectName}"${args.objectType ? `（类型 ${args.objectType}）` : ""}。` +
          `请先用 search_abap_objects 确认对象名称和类型是否正确。`
      }
      const client = await getClient(connId)
      const source = await readSourceSmart(client, obj["adtcore:type"], obj["adtcore:uri"])

      const lines = source.split("\n")
      let content = source
      let header = ""

      // 方法提取（仅当 methodName 提供）
      if (args.methodName && obj["adtcore:type"] === "CLAS") {
        const upper = args.methodName.toUpperCase()
        const startIdx = lines.findIndex((l) => l.trim().toUpperCase() === `METHOD ${upper}.`)
        if (startIdx === -1) {
          return `在 ${args.objectName} 中未找到方法 ${args.methodName}。可用 search_abap_object_lines 或读取全部源码确认方法名。`
        }
        let endIdx = startIdx
        for (let i = startIdx + 1; i < lines.length; i++) {
          if (lines[i].trim().toUpperCase() === "ENDMETHOD.") {
            endIdx = i
            break
          }
        }
        const methodLines = lines.slice(startIdx, endIdx + 1)
        header = `方法 ${upper} 的源码（第 ${startIdx + 1}-${endIdx + 1} 行，共 ${methodLines.length} 行）:\n\n`
        content = methodLines.join("\n")
      } else if (args.startLine !== undefined) {
        const start = Math.max(1, args.startLine)
        const count = args.lineCount ?? lines.length - start + 1
        const slice = lines.slice(start - 1, start - 1 + count)
        header = `${args.objectName} 源码（第 ${start}-${start + slice.length - 1} 行，共 ${lines.length} 行）:\n\n`
        content = slice.join("\n")
      } else {
        header = `${args.objectName}（${obj["adtcore:type"]}）完整源码，共 ${lines.length} 行:\n\n`
      }

      return header + content
    } catch (err) {
      return toToolError(err)
    }
  },
}
