/** 工具组：质量/测试/数据（run_unit_tests、run_atc_analysis、execute_data_query、get_abap_sql_syntax） */
import { z } from "zod"
import { getClient } from "../adtManager.js"
import {
  findObject,
  requireObject,
  resolveConnectionId,
  toToolError,
  connectionIdSchema,
  objectTypeSchema,
} from "./shared.js"

// ─── run_unit_tests ─────────────────────────────────────────────────────────
export const runUnitTestsTool = {
  name: "run_unit_tests",
  title: "Run Unit Tests",
  description:
    "在 SAP 系统中运行对象的 ABAP 单元测试，返回测试类/方法级结果（通过、失败、错误、耗时）。支持类（含测试 include）、报表等。",
  inputSchema: z.object({
    objectName: z.string().describe("对象名称，如 ZCL_MY_CLASS"),
    objectType: objectTypeSchema,
    connectionId: connectionIdSchema,
  }),
  async execute(args: { objectName: string; objectType?: string; connectionId?: string }): Promise<string> {
    try {
      const connId = await resolveConnectionId(args.connectionId)
      const obj = await requireObject(connId, args.objectName, args.objectType)
      const client = await getClient(connId)
      const classes = await client.unitTestRun(obj["adtcore:uri"])
      if (!classes || classes.length === 0) {
        return `${args.objectName} 没有可运行的单元测试。可用 create_test_include 创建测试 include 后添加测试。`
      }
      const lines: string[] = []
      let total = 0, passed = 0, failed = 0
      for (const clas of classes) {
        lines.push(`测试类: ${clas["adtcore:name"]}`)
        const methods = await client.unitTestEvaluation(clas)
        for (const m of methods) {
          total++
          const hasAlert = (m.alerts ?? []).length > 0
          if (!hasAlert) passed++
          else failed++
          const icon = hasAlert ? "❌" : "✅"
          const alerts = (m.alerts ?? [])
            .map((a) => `${a.title}${a.details?.length ? `: ${a.details.join("; ").slice(0, 120)}` : ""}`)
            .join(" | ")
          lines.push(`  ${icon} ${m["adtcore:name"]}${hasAlert ? ` - ${alerts}` : ""}`)
        }
      }
      const summary = failed === 0 ? "✅ 全部通过" : `❌ ${failed}/${total} 失败`
      return `单元测试结果 for ${args.objectName}: ${summary}\n总计: ${total} | 通过: ${passed} | 失败: ${failed}\n\n${lines.join("\n")}`
    } catch (err) {
      return toToolError(err)
    }
  },
}

// ─── run_atc_analysis ───────────────────────────────────────────────────────
export const atcTool = {
  name: "run_atc_analysis",
  title: "Run ATC Analysis",
  description:
    "对对象运行 ABAP Test Cockpit（ATC）代码质量检查，返回检查发现的问题（严重级别、行号、消息、检查项）。用于代码质量门禁和上线前检查。",
  inputSchema: z.object({
    objectName: z.string().describe("对象名称"),
    objectType: objectTypeSchema,
    connectionId: connectionIdSchema,
    maxResults: z.number().int().min(1).max(200).optional().describe("最大结果数，默认 100"),
  }),
  async execute(args: { objectName: string; objectType?: string; connectionId?: string; maxResults?: number }): Promise<string> {
    try {
      const connId = await resolveConnectionId(args.connectionId)
      const obj = await requireObject(connId, args.objectName, args.objectType)
      const client = await getClient(connId)

      // 1. 读取系统检查变体
      const customizing = await client.atcCustomizing()
      const variantProp = customizing.properties?.find((p: { name: string }) => p.name === "systemCheckVariant")
      let checkVariant = "DEFAULT"
      if (variantProp?.value) {
        checkVariant = await client.atcCheckVariant(String(variantProp.value))
      }

      // 2. 运行 ATC
      const run = await client.createAtcRun(checkVariant, obj["adtcore:uri"], args.maxResults ?? 100)
      if (!run?.id) return `ATC 检查未返回结果 ID（对象 ${args.objectName} 可能无问题或无权限）。`
      const worklist = await client.atcWorklists(run.id) as unknown as {
        objectSets?: Array<{ findings?: Array<{ priority?: number; checkTitle?: string; messageTitle?: string; location?: { range?: { start?: { line?: number } } } }> }>
      }

      const findings = worklist?.objectSets?.flatMap((s) => s.findings ?? []) ?? []
      if (findings.length === 0) {
        return `✅ ATC 检查通过（变体: ${checkVariant}），未发现问题。`
      }
      const lines = [
        `ATC 检查结果 for ${args.objectName}（变体: ${checkVariant}）: ${findings.length} 个问题`,
      ]
      for (const f of findings.slice(0, 100)) {
        const sev = f.priority ?? "?"
        const line = f.location?.range?.start?.line ?? "?"
        const msg = f.messageTitle ?? f.checkTitle ?? "?"
        lines.push(`  [${sev}] 行 ${line}: ${msg}`)
      }
      if (findings.length > 100) lines.push(`  ... 其余 ${findings.length - 100} 条省略`)
      return lines.join("\n")
    } catch (err) {
      return toToolError(err)
    }
  },
}

// ─── execute_data_query ─────────────────────────────────────────────────────

/** 从 SQL 提取涉及的表名（FROM + JOIN），去重，最多取 2 张，避免重试查询扩大成本 */
export function extractTablesFromSql(sql: string): string[] {
  const cleaned = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, " ")
  const tables: string[] = []
  const from = cleaned.match(/\bFROM\s+([A-Za-z0-9_/]+)/i)
  if (from) tables.push(from[1])
  const joinRe = /\bJOIN\s+([A-Za-z0-9_/]+)/gi
  let m: RegExpExecArray | null
  while ((m = joinRe.exec(cleaned))) tables.push(m[1])
  return tables.filter((t, i) => tables.indexOf(t) === i).slice(0, 2)
}

/** SQL 报错时给 LLM 附上真实列名，避免反复猜列名烧 token：对涉及的表跑 SELECT * LIMIT 1 拿列名 */
async function hintRealColumns(connId: string, sql: string): Promise<string> {
  const tables = extractTablesFromSql(sql)
  if (!tables.length) return ""
  const parts: string[] = []
  for (const t of tables) {
    try {
      const client = await getClient(connId)
      const res = await client.runQuery(`SELECT * FROM ${t} UP TO 1 ROWS`, 1, true)
      const cols = (res?.columns ?? []) as Array<{ name: string }>
      if (cols.length) parts.push(`表 ${t} 真实可用列: ${cols.map((c) => c.name).join(", ")}`)
    } catch {
      /* 表不存在/无权限，跳过该表 */
    }
  }
  return parts.join("\n")
}

export const dataQueryTool = {
  name: "execute_data_query",
  title: "Execute Data Query",
  description:
    "在 SAP 系统上执行 SQL 查询（仅允许 SELECT 和 WITH 语句，禁止 DML/DDL），返回表格数据。用于查询业务数据、排查问题。注意：生产系统谨慎使用，默认限制返回行数。",
  inputSchema: z.object({
    sqlQuery: z.string().describe("SQL 查询语句，如 SELECT * FROM ZTABLE WHERE ...，必须以 SELECT 或 WITH 开头"),
    limit: z.number().int().min(1).max(1000).optional().describe("最大返回行数，默认 50"),
    connectionId: connectionIdSchema,
  }),
  async execute(args: { sqlQuery: string; limit?: number; connectionId?: string }): Promise<string> {
    let connId = ""
    let sql = ""
    try {
      connId = await resolveConnectionId(args.connectionId)
      sql = args.sqlQuery.trim()
      // 先去掉块注释 /**/ 与字符串字面量再校验：注释里写 INSERT 不会误判，也防 /**/ 把关键字拆开
      // 用空格替换（而非删除），避免 1/**/INSERT 拼成 1INSERT 绕过 \b 词边界
      const cleaned = sql
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/'(?:[^']|'')*'/g, " ")
      if (!/^(SELECT|WITH)\b/i.test(cleaned)) {
        return "安全限制：仅允许 SELECT 和 WITH 开头的查询（只读）。已拒绝执行。"
      }
      if (/\b(INSERT|UPDATE|DELETE|DROP|CREATE|TRUNCATE|ALTER)\b/i.test(cleaned)) {
        return "安全限制：检测到写操作关键字，已拒绝执行。"
      }
      const client = await getClient(connId)
      const limit = args.limit ?? 50
      const result = await client.runQuery(sql, limit, true)

      const rows = (result?.values ?? []) as Array<Record<string, unknown>>
      if (rows.length === 0) {
        return `查询完成，0 行结果。\nSQL: ${sql}`
      }
      const headers = result?.columns ?? []
      const lines = [
        `查询结果: ${rows.length} 行${limit < 1000 ? `（上限 ${limit}）` : ""}`,
        `SQL: ${sql}`,
        "",
        headers.map((c) => c.name).join(" | "),
        headers.map(() => "---").join("-+-"),
      ]
      for (const row of rows.slice(0, limit)) {
        const cells = headers.map((c) => String(row[c.name] ?? ""))
        lines.push(cells.join(" | "))
      }
      if (rows.length > limit) {
        lines.push(`... 其余 ${rows.length - limit} 行省略（增大 limit 获取）`)
      }
      return lines.join("\n")
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // 列名/类型类错误时附上真实列名，让 LLM 一次改对，不再反复猜
      if (connId && /unknown column|invalid column|column .* (not found|does not exist)|未知列|列名/i.test(msg)) {
        const hint = await hintRealColumns(connId, sql)
        if (hint) return `${toToolError(err)}\n\n${hint}`
      }
      return toToolError(err)
    }
  },
}

// ─── get_abap_sql_syntax ────────────────────────────────────────────────────
export const sqlSyntaxTool = {
  name: "get_abap_sql_syntax",
  title: "Get ABAP SQL Syntax",
  description:
    "返回编写 ABAP Open SQL 查询的语法规则与注意事项（SAP 版本差异、关键字、变量绑定）。写 execute_data_query 之前建议先查本工具避免语法错误。",
  inputSchema: z.object({}),
  async execute(): Promise<string> {
    return (
      "ABAP Open SQL 语法要点（execute_data_query 使用）:\n\n" +
      "1. 仅支持 SELECT / WITH（只读），禁止 DML/DDL\n" +
      "2. 表名/字段名大写，如 SELECT * FROM ZTABLE WHERE ZFIELD = 'X'\n" +
      "3. 关键字: SELECT, FROM, WHERE, GROUP BY, HAVING, ORDER BY, UP TO n ROWS\n" +
      "4. 字符串字面量用单引号，内部单引号转义为两个单引号 ''\n" +
      "5. 日期格式 'YYYYMMDD'，时间 'HHMMSS'，时间戳 'YYYYMMDDHHMMSS'\n" +
      "6. 避免 SELECT * 于宽表，建议显式列名\n" +
      "7. 可用 WITH +AS 子查询（HANA/S4 支持）\n" +
      "8. 大小写不敏感，但建议统一大写\n" +
      "9. 示例: SELECT MANDT, BUKRS FROM T001 WHERE BUKRS = '1000' ORDER BY BUKRS\n" +
      "10. 示例: SELECT * FROM ZTABLE UP TO 100 ROWS"
    )
  },
}
