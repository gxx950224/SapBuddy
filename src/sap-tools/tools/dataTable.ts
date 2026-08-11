/** 工具：直接读取表内容（read_table_contents）——不用写 SQL，跟 SE16 查表一样，只读 */
import { z } from "zod"
import { getClient } from "../adtManager.js"
import { resolveConnectionId, toToolError, connectionIdSchema } from "./shared.js"

const DML_RE = /\b(INSERT|UPDATE|DELETE|DROP|CREATE|TRUNCATE|ALTER|MERGE|GRANT|REVOKE)\b/i

export const readTableContentsTool = {
  name: "read_table_contents",
  title: "Read Table Contents",
  description:
    "直接读取 SAP 数据库表的内容（无需写 SQL，跟 SE16 查表一样）。可选筛选条件。只读，不锁表，默认限制行数，安全适合生产系统。" +
    "表名需真实存在（如 MARC、T001、自定义表 ZXXX）。筛选条件只写 WHERE 子句内容（如 BUKRS = '1000'），不要带 WHERE 关键字。",
  inputSchema: z.object({
    tableName: z.string().describe("表名（大写，如 MARC、T001、ZITABLE）"),
    filter: z
      .string()
      .optional()
      .describe("筛选条件（WHERE 子句内容，不带 WHERE 关键字），如 BUKRS = '1000' AND WERKS = '1000'。不填则返回表的前 N 行"),
    rowLimit: z.number().int().min(1).max(500).optional().describe("最大返回行数，默认 50，最大 500"),
    connectionId: connectionIdSchema,
  }),
  async execute(args: { tableName: string; filter?: string; rowLimit?: number; connectionId?: string }): Promise<string> {
    try {
      const connId = await resolveConnectionId(args.connectionId)
      const table = String(args.tableName || "").trim().toUpperCase()
      if (!/^[A-Z][A-Z0-9_/]{1,29}$/.test(table)) return "表名不合法：应为大写字母/数字/下划线（如 MARC、ZITABLE）。"
      const limit = Math.min(args.rowLimit ?? 50, 500)
      const client = await getClient(connId)

      let sqlQuery = ""
      if (args.filter && String(args.filter).trim()) {
        const f = String(args.filter).trim()
        if (f.includes(";")) return "安全限制：筛选条件含非法字符（;），已拒绝执行。"
        if (DML_RE.test(f)) return "安全限制：筛选条件含写操作关键字（INSERT/UPDATE/DELETE 等），已拒绝执行。"
        if (/^SELECT\b/i.test(f)) return "筛选条件只需 WHERE 子句内容（如 BUKRS = '1000'），不要写 SELECT。"
        sqlQuery = `SELECT * FROM ${table} WHERE ${f}`
      }

      const result = await client.tableContents(table, limit, true, sqlQuery)
      const rows = (result?.values ?? []) as Array<Record<string, unknown>>
      if (rows.length === 0) {
        return `表 ${table} 查询完成，0 行结果。${args.filter ? `\n筛选条件: ${args.filter}` : ""}`
      }
      const headers = (result?.columns ?? []) as Array<{ name: string }>
      const lines = [
        `表 ${table} 内容: ${rows.length} 行（上限 ${limit}）${args.filter ? `，筛选: ${args.filter}` : ""}`,
        "",
        headers.map((c) => c.name).join(" | "),
        headers.map(() => "---").join("-+-"),
      ]
      for (const row of rows) {
        const cells = headers.map((c) => String(row[c.name] ?? ""))
        lines.push(cells.join(" | "))
      }
      if (rows.length >= limit) {
        lines.push("", `已达上限 ${limit} 行。可用更大的 rowLimit 或加筛选条件缩小范围。`)
      }
      return lines.join("\n")
    } catch (err) {
      return toToolError(err)
    }
  },
}
