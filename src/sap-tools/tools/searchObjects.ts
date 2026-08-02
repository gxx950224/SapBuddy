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
    "**确认对象是否存在时用精确名称（不带通配符）**，避免模糊搜索返回大量无关对象浪费 token；" +
    "查找同类对象/未知名称时才用通配符。未指定 types 时搜索所有常用类型。" +
    "用于确认对象是否存在、查找对象名和类型。",
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
      // 性能：常用类型优先并行查，命中即返回；未命中再并行查剩余类型（原串行最多 42 次往返）
      const COMMON_TYPES = ["PROG", "CLAS", "INTF", "FUGR", "TABL", "DTEL", "DDLS", "DOMA", "TTYP", "MSAG", "DEVC", "FUNC"]
      const ordered = COMMON_TYPES.filter((t) => types.includes(t)).concat(types.filter((t) => !COMMON_TYPES.includes(t)))

      async function searchBatch(batch: string[]): Promise<string[]> {
        const found: string[] = []
        const batchSeen = new Set<string>()
        const batchResults = await Promise.allSettled(
          batch.map(async (type) => {
            try {
              const hits = await client.searchObject(pattern, type, max)
              return { type, hits }
            } catch {
              return { type, hits: [] as never[] }
            }
          }),
        )
        for (const r of batchResults) {
          const hits = r.status === "fulfilled" ? (r.value.hits as never[]) : []
          for (const hit of hits) {
            const key = `${(hit as Record<string, string>)["adtcore:type"]}:${(hit as Record<string, string>)["adtcore:name"]}`
            if (batchSeen.has(key)) continue
            batchSeen.add(key)
            found.push(formatSearchResult(hit as never))
            if (found.length >= max) break
          }
          if (found.length >= max) break
        }
        return found
      }

      // 阶段 1：常用类型并行（最多 12 个并发）；阶段 2：未命中再查剩余
      let results = await searchBatch(ordered.slice(0, 12))
      if (results.length === 0 && ordered.length > 12) {
        results = await searchBatch(ordered.slice(12))
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
