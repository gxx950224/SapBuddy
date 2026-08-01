/** 工具：按名称模式搜索 ABAP 对象（对应 abap_fs 的 search_abap_objects） */
import { z } from "zod"
import { getClient } from "../adtManager.js"
import {
  DEFAULT_SEARCH_TYPES,
  connectionIdSchema,
  formatSearchResult,
  resolveConnectionId,
  toToolError,
} from "./shared.js"

export const searchObjectsTool = {
  name: "search_abap_objects",
  title: "Search ABAP Objects",
  description:
    "在 SAP 系统中按名称模式搜索 ABAP 对象（支持通配符 *，如 Z*PRICING*、BAPI_USER*）。" +
    "未指定 types 时搜索所有常用类型。用于确认对象是否存在、查找对象名和类型。",
  inputSchema: z.object({
    pattern: z
      .string()
      .describe("搜索模式，支持通配符 *，如 ZCL_MY*、BAPI_USER*。系统会自动转为大写"),
    connectionId: connectionIdSchema,
    types: z
      .array(z.string())
      .optional()
      .describe("限定对象类型列表，如 [\"CLAS\",\"PROG\"]。省略则搜索全部常用类型"),
    maxResults: z.number().int().min(1).max(200).optional().describe("最大返回条数，默认 20"),
  }),
  async execute(args: {
    pattern: string
    connectionId?: string
    types?: string[]
    maxResults?: number
  }): Promise<string> {
    try {
      const connId = await resolveConnectionId(args.connectionId)
      const client = await getClient(connId)
      const pattern = args.pattern.toUpperCase()
      const types = args.types && args.types.length > 0 ? args.types : [...DEFAULT_SEARCH_TYPES]
      const max = args.maxResults ?? 20

      const results: string[] = []
      const seen = new Set<string>()

      for (const type of types) {
        try {
          const hits = await client.searchObject(pattern, type, max)
          for (const r of hits) {
            const key = `${r["adtcore:type"]}:${r["adtcore:name"]}`
            if (seen.has(key)) continue
            seen.add(key)
            results.push(formatSearchResult(r))
            if (results.length >= max) break
          }
        } catch {
          // 该类型搜索失败则跳过（部分系统不支持某些类型）
        }
        if (results.length >= max) break
      }

      if (results.length === 0) {
        return `未找到匹配 "${pattern}" 的 ABAP 对象。可尝试：\n- 使用更宽泛的模式（如 Z*）\n- 指定正确的 types\n- 确认 SAP 账号有查看权限`
      }
      return `搜索 "${pattern}" 结果（${results.length} 条，最多 ${max}）:\n\n${results.join("\n")}`
    } catch (err) {
      return toToolError(err)
    }
  },
}
