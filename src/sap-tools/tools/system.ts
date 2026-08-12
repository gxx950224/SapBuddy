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
        "13. execute_data_query - SQL 查询（只读）\n" +
        "14. get_abap_sql_syntax - SQL 语法参考\n" +
        "15. manage_transport_requests - 传输请求\n" +
        "16. manage_text_elements - 文本元素\n" +
        "17. analyze_abap_dumps - ST22 dump 分析\n" +
        "18. analyze_abap_traces - 性能追踪分析\n" +
        "19. get_version_history - 版本历史\n" +
        "20. get_sap_system_info - 系统信息\n" +
        "21. adt_discovery_export - ADT 服务发现\n" +
        "22. create_mermaid_diagram / validate_mermaid_syntax / get_mermaid_documentation / detect_mermaid_diagram_type - Mermaid 图表\n" +
        "23. create_object_programmatically / abap_activate / replace_string_in_abap_object / create_test_include - 写操作（需 readOnly=false）\n" +
        "24. get_abap_diagnostics - 语法检查\n" +
        "25. read_table_contents - 直接读表（不用写 SQL，限行数，只读）\n" +
        "26. find_code_definition - 定位标识符定义处\n" +
        "27. get_class_hierarchy - 类的父/子继承结构\n" +
        "28. get_abap_documentation - 查询 ABAP 帮助文档\n" +
        "29. find_where_used(includeSnippets=true) - 引用分析带代码片段\n" +
        "30. get_abap_object_info(includeStructure=true) - 类组件/表字段清单\n" +
        "31. analyze_abap_traces(statements/db_access) - 追踪语句与DB访问明细"
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
