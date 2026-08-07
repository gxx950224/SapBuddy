/** 工具组：系统信息与扩展（get_sap_system_info、adt_discovery_export、abap_fs_documentation、调试工具降级） */
import { z } from "zod"
import { getClient, CLIENT_CATEGORY_LABELS } from "../adtManager.js"
import { resolveConnectionId, toToolError, connectionIdSchema } from "./shared.js"

// ─── get_sap_system_info ────────────────────────────────────────────────────
export const sapSystemInfoTool = {
  name: "get_sap_system_info",
  title: "Get SAP System Info",
  description:
    "获取 SAP 系统信息：系统类型（S/4HANA vs ECC）、版本（CVERS/SVERS）、当前客户端（T000）、时区（TTZ）。通过 SQL 查询系统表获得。",
  inputSchema: z.object({
    connectionId: connectionIdSchema,
  }),
  async execute(args: { connectionId?: string }): Promise<string> {
    try {
      const connId = await resolveConnectionId(args.connectionId)
      const client = await getClient(connId)
      const { getConnection } = await import("../adtManager.js")
      const conf = getConnection(connId)

      const lines = [
        `SAP 系统信息: ${conf.url}（Client ${conf.client}，连接 ${connId}）`,
        `登录用户: ${client.username}`,
      ]

      // 当前客户端 T000
      try {
        const t000 = await client.runQuery(
          `SELECT MANDT, CCTYP, CCCATEGORY FROM T000 WHERE MANDT = '${conf.client}'`,
          1,
          true
        )
        const row = (t000?.values?.[0] ?? {}) as Record<string, unknown>
        if (row && Object.keys(row).length > 0) {
          const cat = String(row.CCCATEGORY ?? "")
          const label = CLIENT_CATEGORY_LABELS[cat] ?? ""
          lines.push(`客户端类型: ${cat || "?"}${label ? `（${label}）` : ""}`)
        }
      } catch { /* 某些系统 T000 不可查询 */ }

      // 产品版本 CVERS
      try {
        const cvers = await client.runQuery(
          "SELECT COMPONENT, RELEASE FROM CVERS ORDER BY COMPONENT",
          50,
          true
        )
        const comps = (cvers?.values ?? []) as Array<Record<string, unknown>>
        if (comps.length > 0) {
          const isS4 = comps.some((r) => String(r.COMPONENT ?? "").startsWith("S4CORE"))
          lines.push(`产品: ${isS4 ? "S/4HANA" : "ECC / 传统"} | 组件版本: ${comps.map((r) => `${r.COMPONENT}=${r.RELEASE}`).join(", ")}`)
        }
      } catch { /* 无权限 */ }

      // 内核版本 SVERS
      try {
        const svers = await client.runQuery("SELECT COMPONENT, RELEASE FROM SVERS", 10, true)
        const comps = (svers?.values ?? []) as Array<Record<string, unknown>>
        if (comps.length > 0) {
          lines.push(`内核版本: ${comps.map((r) => `${r.COMPONENT}=${r.RELEASE}`).join(", ")}`)
        }
      } catch { /* 无权限 */ }

      // 时区 TTZ
      try {
        const ttz = await client.runQuery(
          "SELECT TIMEZONE, TZNAME FROM TTZ WHERE DST = ' '",
          1,
          true
        )
        const row = (ttz?.values?.[0] ?? {}) as Record<string, unknown>
        if (row && Object.keys(row).length > 0) lines.push(`时区: ${row.TIMEZONE} (${row.TZNAME ?? "?"})`)
      } catch { /* 无权限 */ }

      return lines.join("\n")
    } catch (err) {
      return toToolError(err)
    }
  },
}

// ─── adt_discovery_export ───────────────────────────────────────────────────
export const adtDiscoveryTool = {
  name: "adt_discovery_export",
  title: "ADT Discovery Export",
  description:
    "导出 SAP 系统的 ADT 服务发现树（所有可用的 ADT 服务、集合、功能）。用于 API 调研和集成开发。输出为 markdown 列表。",
  inputSchema: z.object({
    connectionId: connectionIdSchema,
    maxResults: z.number().int().min(1).max(200).optional().describe("最大条目数，默认 100"),
  }),
  async execute(args: { connectionId?: string; maxResults?: number }): Promise<string> {
    try {
      const connId = await resolveConnectionId(args.connectionId)
      const client = await getClient(connId)
      const max = args.maxResults ?? 100
      const tree = await client.adtDiscovery()
      const items = tree ?? []
      if (items.length === 0) return "该系统的 ADT discovery 返回空。"
      const lines = [`ADT 服务发现（共 ${items.length} 项，显示 ${Math.min(max, items.length)}）:`, ""]
      for (const item of items.slice(0, max)) {
        const title = (item as { title?: string }).title ?? "?"
        const href = (item as { href?: string }).href ?? "?"
        lines.push(`- ${title}: ${href}`)
      }
      return lines.join("\n")
    } catch (err) {
      return toToolError(err)
    }
  },
}

// ─── abap_fs_documentation（本项目文档查询）────────────────────────────────
export const documentationTool = {
  name: "abap_fs_documentation",
  title: "ABAP ADT MCP Documentation",
  description:
    "查询本 MCP 服务的工具文档与使用说明。不访问 SAP。当你不知道某个工具怎么用、或需要了解可用能力时，先调用本工具。",
  inputSchema: z.object({
    topic: z
      .string()
      .optional()
      .describe("要查询的主题：工具列表(tools)、编辑流程(edit)、查询(query)、权限(security)、全部(默认)"),
  }),
  async execute(args: { topic?: string }): Promise<string> {
    const topic = (args.topic ?? "all").toLowerCase()
    if (topic.includes("tool") || topic.includes("list")) {
      return (
        "可用工具:\n" +
        "1. get_connected_systems - 列出可用 SAP 连接\n" +
        "2. search_abap_objects - 按名称搜索对象\n" +
        "3. get_abap_object_lines - 读对象源码\n" +
        "4. search_abap_object_lines - 源码内搜索\n" +
        "5. get_abap_object_info - 对象元数据\n" +
        "6. get_batch_lines - 批量读源码\n" +
        "7. get_object_by_uri - 按 URI 读源码\n" +
        "8. get_abap_object_workspace_uri - 获取 adt:// URI\n" +
        "9. get_abap_object_url - WebGUI URL\n" +
        "10. find_where_used - where-used 分析\n" +
        "11. run_unit_tests - 运行单元测试\n" +
        "12. run_atc_analysis - ATC 代码检查\n" +
        "13. get_atc_decorations - ATC 说明（独立部署用 run_atc_analysis）\n" +
        "14. execute_data_query - SQL 查询（只读）\n" +
        "15. get_abap_sql_syntax - SQL 语法参考\n" +
        "16. manage_transport_requests - 传输请求\n" +
        "17. manage_text_elements - 文本元素\n" +
        "18. analyze_abap_dumps - ST22 dump 分析\n" +
        "19. analyze_abap_traces - 性能追踪分析\n" +
        "20. get_version_history - 版本历史\n" +
        "21. get_sap_system_info - 系统信息\n" +
        "22. adt_discovery_export - ADT 服务发现\n" +
        "23. create_mermaid_diagram / validate_mermaid_syntax / get_mermaid_documentation / detect_mermaid_diagram_type - Mermaid 图表\n" +
        "24. create_object_programmatically / abap_activate / replace_string_in_abap_object / create_test_include - 写操作（需 readOnly=false）\n" +
        "25. get_abap_diagnostics - 语法检查\n" +
        "26. abap_debug_* - 调试（独立部署不支持，需 VS Code）"
      )
    }
    if (topic.includes("edit")) {
      return (
        "编辑 ABAP 代码的完整流程:\n" +
        "1. get_abap_object_workspace_uri(objectName, objectType) -> 获取 adt:// URI\n" +
        "2. get_abap_object_lines 读取当前源码（注意行尾为 CRLF，oldString 匹配会自动归一化）\n" +
        "3. replace_string_in_abap_object(fileUri, oldString, newString) - 唯一匹配替换，自动保存\n" +
        "4. get_abap_diagnostics(fileUri) - 语法检查\n" +
        "5. abap_activate(objectName, objectType) - 激活\n\n" +
        "⚠️ 写操作需要服务器配置 security.readOnly=false，且 SAP 账号有编辑权限。\n" +
        "⚠️ 函数模块编辑（FUGR/FF）：创建用 create_object_programmatically(objectType=FUGR/FF, parentName=<函数组名>)。写参数与逻辑：① get_abap_object_workspace_uri(objectName, \"FUGR/FF\") 拿到函数模块自身的 /fmodules/<函数模块> 工作区 URI；② 直接 replace_string_in_abap_object 传 fullSource=完整源码一步写入（FUNCTION 行不带句点 + 参数段 + 独立 . + 函数体 + ENDFUNCTION.），不要先读模板、不要构造 oldString 去匹配模板空行；保存时服务器自动把参数提取进接口（SE37）。参数（IMPORTING/EXPORTING/CHANGING/TABLES/EXCEPTIONS）写在 FUNCTION 行后、结束句点 . 之前，函数体（SELECT 等）写在 . 之后。保存时服务器自动把参数提取进接口（SE37）。⚠️ Open SQL 里引用接口参数必须带 @ 前缀（WHERE WERKS = @IV_WERKS、INTO TABLE @ET_MARC），不带 @ 报 \"must be escaped using @\"（replace_string 会自动补 @ 但请规范书写）。⚠️ 返回一张表最稳的写法是 TABLES 段：TABLES ET_MARC LIKE MARC（函数体用 INTO TABLE @ET_MARC），真机验证可正常激活；不能写 TYPE STANDARD TABLE OF <表>（SAP 报 Parameter OF declares no type）。⚠️ TYPE 后的类型名必须是系统中真实存在的名称（replace_string 会校验存在性）：数据元素（工厂 WERKS_D、物料 MATNR）、表类型，或表/结构（TYPE MARC、TYPE ZAIG_TEST02_S 引用结构/表本身，合法，不拦截）。要传整个结构或表可直接 TYPE <名字>；要传单个字段值才用数据元素名（不是字段名 WERKS）。拿不准先 search_abap_objects 确认或改用 LIKE <表>。replace_string 会自动检查：EXPORTING 不能带 DEFAULT、DEFAULT 与 OPTIONAL 不能并存（自动修正）；参数段漏写结束句点 . 会自动补；内联表类型/用 *\" 注释写参数会中止并提示正确写法。⚠️ 函数模块内不能定义 FORM；激活函数组不连带激活函数模块，写入后需单独 abap_activate(objectName, \"FUGR/FF\")。⚠️ 写代码守则：不要反复试错烧 token——每次写入前想清楚结构，同一编辑连续失败 2 次必须停下向用户说明现状与下一步并等待决定。\n" +
        "⚠️ 对象描述修改用 update_object_description 工具（SE38 标题）。\n" +
        "⚠️ 文本元素（TEXT-xxx/选择文本/标题）用 manage_text_elements 工具（symbols id 为 3 字符，自动补 maxLength）。"
      )
    }
    if (topic.includes("query") || topic.includes("sql")) {
      return (
        "数据查询:\n" +
        "- 用 execute_data_query 执行只读 SQL（SELECT/WITH）\n" +
        "- 先查 get_abap_sql_syntax 了解语法\n" +
        "- 生产系统建议 limit 小一些"
      )
    }
    if (topic.includes("security") || topic.includes("perm")) {
      return (
        "权限与安全:\n" +
        "- 服务器默认 readOnly=true，只读工具可用\n" +
        "- 写工具（create/activate/replace/test include）需管理员设置 readOnly=false\n" +
        "- 所有请求以共享 service user 身份执行（服务端配置）\n" +
        "- HTTP 模式可用 API key 保护（Bearer token）"
      )
    }
    return (
      "ABAP ADT MCP 服务：通过 ADT 协议连接 SAP，为 AI Agent 提供 ABAP 开发能力。\n" +
      "可用主题: tools(工具列表), edit(编辑流程), query(查询), security(权限)。\n" +
      "典型用法: 搜索对象 -> 读源码 -> where-used 分析 -> 修改 -> 激活。"
    )
  },
}

// ─── 调试工具（独立部署降级说明）────────────────────────────────────────────
function debugNotSupported(name: string, reason: string): string {
  return (
    `${name}: 当前独立 MCP 部署不支持交互式 ABAP 调试。\n` +
    `原因: ${reason}\n` +
    `替代方案:\n` +
    `- 使用 VS Code + abap_fs 扩展进行实时调试（断点、单步、变量查看）\n` +
    `- 使用 SAP GUI 调试器\n` +
    `- 对运行时报错使用 analyze_abap_dumps 分析 ST22 dump`
  )
}

export const debugTools = [
  {
    name: "abap_debug_session",
    title: "ABAP Debug Session",
    description: "启动/停止 ABAP 调试会话。注意：独立 MCP 部署不支持交互式调试，本工具返回说明。",
    inputSchema: z.object({ action: z.enum(["start", "stop"]).optional().describe("start/stop，默认 start") }),
    async execute(): Promise<string> {
      return debugNotSupported("调试会话", "调试器需要 VS Code 调试适配器与 UI 交互")
    },
  },
  {
    name: "abap_debug_breakpoint",
    title: "ABAP Debug Breakpoint",
    description: "设置/移除断点。注意：独立 MCP 部署不支持交互式调试，本工具返回说明。",
    inputSchema: z.object({ action: z.enum(["set", "remove"]).optional() }),
    async execute(): Promise<string> {
      return debugNotSupported("断点管理", "断点需要调试会话上下文")
    },
  },
  {
    name: "abap_debug_step",
    title: "ABAP Debug Step",
    description: "调试单步执行（step over/into/return/continue）。注意：独立 MCP 部署不支持交互式调试。",
    inputSchema: z.object({ stepType: z.enum(["step_over", "step_into", "step_return", "continue"]).optional() }),
    async execute(): Promise<string> {
      return debugNotSupported("单步执行", "需要活动调试会话")
    },
  },
  {
    name: "abap_debug_variable",
    title: "ABAP Debug Variable",
    description: "查看调试变量值。注意：独立 MCP 部署不支持交互式调试。",
    inputSchema: z.object({ variableName: z.string().optional() }),
    async execute(): Promise<string> {
      return debugNotSupported("变量查看", "需要活动调试会话")
    },
  },
  {
    name: "abap_debug_stack",
    title: "ABAP Debug Stack",
    description: "查看调试调用栈。注意：独立 MCP 部署不支持交互式调试。",
    inputSchema: z.object({}),
    async execute(): Promise<string> {
      return debugNotSupported("调用栈", "需要活动调试会话")
    },
  },
  {
    name: "abap_debug_status",
    title: "ABAP Debug Status",
    description: "检查调试会话状态。注意：独立 MCP 部署不支持交互式调试。",
    inputSchema: z.object({}),
    async execute(): Promise<string> {
      return debugNotSupported("会话状态", "调试器仅在 VS Code 中可用")
    },
  },
]
