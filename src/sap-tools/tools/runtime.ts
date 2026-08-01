/** 工具组：运行时分析（analyze_abap_dumps、analyze_abap_traces、get_version_history） */
import { z } from "zod"
import { getClient } from "../adtManager.js"
import { requireObject, resolveConnectionId, toToolError, connectionIdSchema, objectTypeSchema } from "./shared.js"

// ─── analyze_abap_dumps ─────────────────────────────────────────────────────
export const dumpAnalysisTool = {
  name: "analyze_abap_dumps",
  title: "Analyze ABAP Dumps",
  description:
    "分析 ABAP 运行时错误（ST22 dumps）：列出最近的 dumps 或查看单个 dump 详情。用于故障排查和根因分析。",
  inputSchema: z.object({
    action: z.enum(["list_dumps", "analyze_dump"]).describe("list_dumps=列出最近 dumps; analyze_dump=查看单个 dump 详情"),
    dumpId: z.string().optional().describe("dump ID（analyze_dump 必填，从 list_dumps 结果获取）"),
    maxResults: z.number().int().min(1).max(100).optional().describe("list_dumps 最大条数，默认 20"),
    connectionId: connectionIdSchema,
  }),
  async execute(args: { action: string; dumpId?: string; maxResults?: number; connectionId?: string }): Promise<string> {
    try {
      const connId = await resolveConnectionId(args.connectionId)
      const client = await getClient(connId)

      if (args.action === "list_dumps") {
        const max = Math.min(args.maxResults ?? 20, 100)
        const feed = await client.dumps()
        const dumps = feed?.dumps ?? []
        if (dumps.length === 0) {
          return "系统当前没有可访问的 ABAP dumps（可能无权限或系统不支持 dump feed）。"
        }
        const lines = [`最近 ${Math.min(dumps.length, max)} 个 ABAP dumps:`, ""]
        for (const d of dumps.slice(0, max)) {
          // dump id 形如 20260801035640vhsxgds4ci_DS4_00...，前 14 位是时间戳 YYYYMMDDHHMMSS
          const ts = d.id.match(/^(\d{14})/)?.[1]
          const time = ts
            ? `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} ${ts.slice(8, 10)}:${ts.slice(10, 12)}:${ts.slice(12, 14)}`
            : "?"
          const txt = (d.text ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 90)
          lines.push(`- [${time}] 用户: ${d.author ?? "?"} | ${txt}`)
          lines.push(`  dumpId: ${d.id}`)
        }
        lines.push("", "用 analyze_dump + dumpId 查看某个 dump 的完整详情。")
        return lines.join("\n")
      }

      if (args.action === "analyze_dump") {
        if (!args.dumpId) return "analyze_dump 需要 dumpId 参数（先用 list_dumps 获取）。"
        const rawId = args.dumpId
        // 全量获取后精确/后缀匹配（避免 feed query 语法问题）
        const feed = await client.dumps()
        const all = feed?.dumps ?? []
        const dump =
          all.find((d) => d.id === rawId) ??
          all.find((d) => d.id.endsWith(rawId)) ??
          all.find((d) => d.id.replace(/\s/g, "").endsWith(rawId.replace(/\s/g, ""))) ??
          all.find((d) => d.id.includes(rawId.slice(-24)))
        if (!dump) return `未找到 dump: ${args.dumpId.slice(0, 80)}...（可从 list_dumps 结果复制完整 dumpId）`
        const lines = [
          `Dump 详情: ${dump.id}`,
          `类型: ${dump.type}`,
          `用户: ${dump.author ?? "?"}`,
          "",
          dump.text,
        ]
        if (dump.links?.length) {
          lines.push("", "关联链接:")
          for (const l of dump.links) lines.push(`  - ${l.title ?? l.rel}: ${l.href}`)
        }
        return lines.join("\n")
      }
      return `未知操作: ${args.action}`
    } catch (err) {
      return toToolError(err)
    }
  },
}

// ─── analyze_abap_traces ────────────────────────────────────────────────────
export const traceAnalysisTool = {
  name: "analyze_abap_traces",
  title: "Analyze ABAP Traces",
  description:
    "分析 ABAP 性能追踪（ST05）：列出用户的追踪请求，或查看单个追踪的命中明细（表访问、语句耗时）。用于性能瓶颈分析。",
  inputSchema: z.object({
    action: z.enum(["list_traces", "analyze_trace"]).describe("list_traces=列出追踪请求; analyze_trace=分析单个追踪的命中明细"),
    traceId: z.string().optional().describe("追踪 ID（analyze_trace 必填）"),
    connectionId: connectionIdSchema,
  }),
  async execute(args: { action: string; traceId?: string; connectionId?: string }): Promise<string> {
    try {
      const connId = await resolveConnectionId(args.connectionId)
      const client = await getClient(connId)

      if (args.action === "list_traces") {
        const data = await client.tracesListRequests(client.username)
        const list = data?.requests ?? []
        if (list.length === 0) return `${client.username} 没有可用的性能追踪请求。可在 SAP GUI（ST05）中创建后重试。`
        const lines = [`用户 ${client.username} 的追踪请求:`, ""]
        for (const t of list.slice(0, 50)) {
          lines.push(`- ${t.id} ${t.title ?? ""}`)
        }
        lines.push("", "用 analyze_trace + traceId 分析具体追踪。")
        return lines.join("\n")
      }

      if (args.action === "analyze_trace") {
        if (!args.traceId) return "analyze_trace 需要 traceId 参数（先用 list_traces 获取）。"
        const hits = await client.tracesHitList(args.traceId, true)
        const lines = [`追踪 ${args.traceId} 命中明细:`, ""]
        const hitList = (hits as { traceHitList?: unknown[] })?.traceHitList
        const items = hitList ?? (Array.isArray(hits) ? hits : null)
        if (!items || items.length === 0) {
          return `追踪 ${args.traceId} 无命中记录。`
        }
        for (const h of items.slice(0, 100)) {
          const row = h as Record<string, unknown>
          const title = String(row.title ?? row.statement ?? row.traceName ?? "?")
          const time = row.executionTime ?? row.time ?? "?"
          const count = row.executions ?? row.hitCount ?? "?"
          lines.push(`- ${title}  [耗时: ${time}ms] [次数: ${count}]`)
        }
        if (items.length > 100) lines.push(`... 其余 ${items.length - 100} 条省略`)
        return lines.join("\n")
      }
      return `未知操作: ${args.action}`
    } catch (err) {
      return toToolError(err)
    }
  },
}

// ─── get_version_history ────────────────────────────────────────────────────
export const versionHistoryTool = {
  name: "get_version_history",
  title: "Get Version History",
  description:
    "查看对象的版本历史：列出历史版本（作者/时间/版本号）、获取某版本源码、比较两个版本。用于代码回溯和变更审查。",
  inputSchema: z.object({
    action: z.enum(["list_versions", "get_version_source", "compare_versions"]).describe("操作类型"),
    objectName: z.string().describe("对象名称"),
    objectType: objectTypeSchema,
    versionNumber: z.number().int().min(1).optional().describe("get_version_source: 版本序号（1=最新）"),
    version1: z.number().int().min(1).optional().describe("compare_versions: 第一个版本序号（1=最新）"),
    version2: z.number().int().min(1).optional().describe("compare_versions: 第二个版本序号"),
    maxResults: z.number().int().min(1).max(50).optional().describe("list_versions 最大条数，默认 20"),
    connectionId: connectionIdSchema,
  }),
  async execute(args: {
    action: string
    objectName: string
    objectType?: string
    versionNumber?: number
    version1?: number
    version2?: number
    maxResults?: number
    connectionId?: string
  }): Promise<string> {
    try {
      const connId = await resolveConnectionId(args.connectionId)
      const obj = await requireObject(connId, args.objectName, args.objectType)
      const client = await getClient(connId)
      const revisions = await client.revisions(obj["adtcore:uri"])

      if (!revisions || revisions.length === 0) {
        return `${obj["adtcore:type"]} ${args.objectName} 无版本历史（新对象或系统不支持）。`
      }

      if (args.action === "list_versions") {
        const max = args.maxResults ?? 20
        const lines = [`${obj["adtcore:type"]} ${args.objectName} 的版本历史（共 ${revisions.length} 个版本，最新在前）:`, ""]
        for (let i = 0; i < Math.min(revisions.length, max); i++) {
          const r = revisions[i]
          lines.push(`  #${i + 1}  ${r.date}  ${r.author ?? "?"}  [${r.version}] ${r.versionTitle ?? ""}`)
        }
        lines.push("", "用 get_version_source（versionNumber）取某版本源码，或用 compare_versions 比较。")
        return lines.join("\n")
      }

      if (args.action === "get_version_source") {
        const idx = (args.versionNumber ?? 1) - 1
        if (idx < 0 || idx >= revisions.length) {
          return `versionNumber 超出范围（1-${revisions.length}）。`
        }
        const source = await client.getObjectSource(revisions[idx].uri)
        return `版本 #${args.versionNumber ?? 1}（${revisions[idx].date}，${revisions[idx].author}）源码:\n\n${source}`
      }

      if (args.action === "compare_versions") {
        const i1 = (args.version1 ?? 1) - 1
        const i2 = (args.version2 ?? 2) - 1
        if (i1 < 0 || i2 < 0 || i1 >= revisions.length || i2 >= revisions.length) {
          return `版本序号超出范围（1-${revisions.length}）。`
        }
        const [s1, s2] = await Promise.all([
          client.getObjectSource(revisions[i1].uri),
          client.getObjectSource(revisions[i2].uri),
        ])
        const l1 = s1.split("\n")
        const l2 = s2.split("\n")
        const maxLen = Math.max(l1.length, l2.length)
        const lines = [
          `版本比较 #${i1 + 1}（${revisions[i1].date}）vs #${i2 + 1}（${revisions[i2].date}）:`,
          "",
        ]
        let diffs = 0
        for (let i = 0; i < maxLen; i++) {
          const a = l1[i] ?? ""
          const b = l2[i] ?? ""
          if (a !== b) {
            diffs++
            lines.push(`行 ${i + 1}:`)
            if (a) lines.push(`  - ${a}`)
            if (b) lines.push(`  + ${b}`)
          }
        }
        if (diffs === 0) lines.push("两个版本内容相同。")
        return lines.join("\n")
      }
      return `未知操作: ${args.action}`
    } catch (err) {
      return toToolError(err)
    }
  },
}
