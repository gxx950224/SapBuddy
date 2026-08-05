/** 工具组：对象管理/写操作（create_object_programmatically、abap_activate、replace_string_in_abap_object、get_abap_diagnostics、create_test_include） */
import { z } from "zod"
import { session_types } from "abap-adt-api"
import { getClient } from "../adtManager.js"
import {
  requireObject,
  resolveConnectionId,
  toToolError,
  escapeXmlAttr,
  connectionIdSchema,
  objectTypeSchema,
} from "./shared.js"

/** 编辑类操作需要 stateful 会话（lock/setObjectSource） */
async function withStateful<T>(
  client: Awaited<ReturnType<typeof getClient>>,
  fn: () => Promise<T>
): Promise<T> {
  const oldState = client.stateful
  client.stateful = session_types.stateful
  try {
    return await fn()
  } finally {
    client.stateful = oldState
  }
}

/** 解析对象实际源码 URI：优先 /source/main（CLAS/PROG/INTF 等），回退对象 URI（XML 元数据对象） */
async function resolveSourceUri(
  client: Awaited<ReturnType<typeof getClient>>,
  adtUri: string
): Promise<string> {
  const main = adtUri.endsWith("/source/main") ? adtUri : `${adtUri}/source/main`
  try {
    await client.getObjectSource(main)
    return main
  } catch {
    return adtUri
  }
}

// ─── create_object_programmatically ─────────────────────────────────────────
export const createObjectTool = {
  name: "create_object_programmatically",
  title: "Create ABAP Object",
  description:
    "在 SAP 系统中创建新的 ABAP 对象（类、报表、接口、表、包等）。\n" +
    "强制规则：创建前必须先向用户收集这些信息（包名/对象名/描述/请求描述），缺少即拦截。\n" +
    "包名可为正式开发包，也可为 $TMP（临时测试包，对象不进传输请求、无法发布）；用户确认后再创建。\n" +
    "可执行报表用 PROG/P（主程序）；标准模板拆分的 INCLUDE 段（如 *_TOP/*_CLS/*_IMP）用 PROG/I 创建。\n" +
    "requestText 提供时自动创建传输请求并挂载对象。创建后对象未激活，用 abap_activate 激活。",
  write: true,
  inputSchema: z.object({
    objectType: z
      .enum([
        "CLAS/OC", "INTF/OI", "PROG/I", "PROG/P", "FUGR/F", "FUGR/FF",
        "TABL/DT", "TABL/DS", "DTEL/DE", "DOMA/DD", "MSAG/N", "DEVC/K",
        "DDLS/DF", "DDLX/EX", "DDLA/ADF", "SRVD/SRV", "AUTH", "SUSO/B", "SRVB/SVB",
      ])
      .describe("对象类型 ID：CLAS/OC(类) INTF/OI(接口) PROG/P(可执行报表/主程序) PROG/I(Include 程序段，模板拆 TOP/CLS/IMP 用) FUGR/FF(函数模块,需 parentName) TABL/DT(表) DEVC/K(包)"),
    name: z.string().describe("对象名称（大写，如 ZCL_MY_CLASS）"),
    description: z.string().describe("对象描述"),
    packageName: z.string().describe("所属开发包：正式开发包名，或 $TMP（临时测试包，不进传输）；先向用户确认"),
    requestText: z.string().optional().describe("传输请求描述（可选；提供时自动创建请求并挂载对象，推荐格式 sapbuddy_<摘要>_<YYYYMMDD>）"),
    parentName: z.string().optional().describe("父对象名（函数组/FUGR 需要）"),
    connectionId: connectionIdSchema,
  }),
  async execute(args: {
    objectType: string
    name: string
    description: string
    packageName: string
    requestText?: string
    parentName?: string
    connectionId?: string
  }): Promise<string> {
    try {
      const connId = await resolveConnectionId(args.connectionId)
      // ── 强制规则：对象类型（写死，不允许自由发挥）──
      const objType = (args.objectType || "").toUpperCase()
      if (objType.startsWith("FUGR")) {
        if (objType !== "FUGR/FF") {
          return "⛔ 强制规则拦截：函数模块必须用 FUGR/FF 类型（不是 FUGR/F）。"
        }
        if (!args.parentName || !String(args.parentName).trim()) {
          return "⛔ 强制规则拦截：创建函数模块（FUGR/FF）必须提供 parentName（函数组名）。请先向用户收集函数组名称。"
        }
      }
      // ── 强制规则：创建必须有包名/描述；包名缺省时向用户确认写哪个包 ──
      const pkg = (args.packageName || "").trim()
      if (!pkg) {
        return "⛔ 创建对象需要指定开发包（packageName）。请先向用户确认要写入哪个包：\n" +
          "· 正式开发包名（如 ZPKG，对象可挂传输请求、发布到正式系统）；\n" +
          "· $TMP（临时测试包，对象不进传输请求、无法发布）。\n" +
          "请把确认到的包名填入 packageName 后重试。"
      }
      if (!args.description || !args.description.trim()) {
        return "⛔ 强制规则拦截：创建对象必须提供描述（description）。请先向用户收集。"
      }
      const client = await getClient(connId)
      // ── 强制规则：先搜后建（工具内置精确查重，不依赖 LLM 自觉）──
      const searchType = (args.objectType || "").split("/")[0]
      if (searchType) {
        try {
          const found = await client.searchObject(args.name.toUpperCase(), searchType, 1)
          if (Array.isArray(found) && found.length > 0) {
            return (
              `⛔ 对象已存在：${args.objectType} ${args.name.toUpperCase()}（强制规则：先搜后建，存在不重复创建）。\n` +
              `请改为"修改"流程：读源码（get_abap_object_lines）→ 确认修改点 → 展示方案 → replace_string_in_abap_object → abap_activate。`
            )
          }
        } catch { /* 查重失败不阻塞创建，ADT createObject 会对已存在对象报错兜底 */ }
      }
      const { objectPath } = await import("abap-adt-api")
      const devClass = pkg
      const parentName = args.parentName ?? devClass
      const parentPath = objectPath(
        args.objectType as never,
        args.name.toUpperCase(),
        parentName
      )
      // 请求：requestText 提供则自动创建传输请求并挂载；否则创建后由激活/后续写入自动建
      let transport: string | undefined
      if (args.requestText && String(args.requestText).trim()) {
        try {
          const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, "")
          const desc = String(args.requestText).trim() || `sapbuddy_创建${args.name.toUpperCase()}_${ymd}`
          transport = await client.createTransport(parentPath, desc, devClass)
        } catch (e) {
          return `⚠️ 自动创建传输请求失败：${e instanceof Error ? e.message.slice(0, 120) : e}。请确认对象放到哪个请求。`
        }
      }
      await client.createObject({
        objtype: args.objectType as never,
        name: args.name.toUpperCase(),
        parentName,
        description: args.description,
        parentPath,
        transport,
        // 语言跟随连接配置（abap-adt-api 默认 EN，在 ZH 主语言系统上创建描述会报
        // "Language EN for creation of description is not equal to original ZH"）
        language: client.language || undefined,
        masterLanguage: client.language || undefined,
      })
      return (
        `✅ 对象创建成功: ${args.objectType} ${args.name.toUpperCase()}\n` +
        `包: ${devClass}\n` +
        (transport ? `传输请求: ${transport}（自动新建）\n` : `传输请求: 未指定（后续写入/激活时自动建）\n`) +
        `状态: 未激活（请用 abap_activate 激活）\n` +
        `注意: 大型对象（类、函数组）创建后可能需补充 includes 内容。`
      )
    } catch (err) {
      return (
        `创建对象失败: ${err instanceof Error ? err.message : err}\n\n` +
        `可能的原因：\n- 对象已存在（先 search_abap_objects 确认）\n- 包不存在或无写入权限\n- 名称不符合命名规范`
      )
    }
  },
}

// ─── abap_activate ──────────────────────────────────────────────────────────
export const activateTool = {
  name: "abap_activate",
  title: "Activate ABAP Object",
  description:
    "激活 ABAP 对象（等价于 SE80 的激活按钮）。激活后返回语法/激活消息列表。写入类代码后必须先激活才能生效。\n" +
    "⚠️ 函数组(FUGR)激活不会自动连带激活其内部的函数模块——函数模块需单独激活：objectName=函数模块名，objectType=FUGR/FF。",
  write: true,
  inputSchema: z.object({
    objectName: z.string().describe("对象名称"),
    objectType: objectTypeSchema,
    connectionId: connectionIdSchema,
  }),
  async execute(args: { objectName: string; objectType?: string; connectionId?: string }): Promise<string> {
    try {
      const connId = await resolveConnectionId(args.connectionId)
      const obj = await requireObject(connId, args.objectName, args.objectType, { includeDirectRead: false })
      const client = await getClient(connId)
      const result = await client.activate(
        obj["adtcore:name"],
        obj["adtcore:uri"],
        undefined,
        true
      )
      const lines: string[] = []
      if (result.success) {
        lines.push(`✅ ${obj["adtcore:type"]} ${obj["adtcore:name"]} 激活成功`)
      } else {
        lines.push(`❌ 激活失败（${obj["adtcore:type"]} ${obj["adtcore:name"]}）:`)
      }
      for (const m of (result.messages ?? []).slice(0, 50)) {
        lines.push(`  [${m.type}] 行 ${m.line}: ${m.shortText}`)
      }
      if ((result.messages ?? []).length > 50) lines.push(`  ... 其余 ${result.messages.length - 50} 条省略`)
      return lines.join("\n")
    } catch (err) {
      return toToolError(err)
    }
  },
}

// ─── replace_string_in_abap_object（写，MCP 编辑主入口）────────────────────
export const replaceStringTool = {
  name: "replace_string_in_abap_object",
  title: "Replace String in ABAP Object",
  description:
    "编辑 ABAP 源码：查找并替换唯一匹配的文本（MCP 客户端的编辑工具，流程: get_abap_object_workspace_uri → 读源码 → 本工具 → get_abap_diagnostics 验证）。" +
    "oldString 必须唯一匹配（含空白，建议带 3-5 行上下文）；编辑后自动保存并释放锁。\n" +
    "自动处理：行尾符 CRLF/LF 差异；非 $TMP 对象自动使用 lock.CORRNR 作为传输请求。\n" +
    "⚠️ 函数模块(FUGR/FF)源码的特殊性：\n" +
    "  1. 新建函数模块空壳含特殊结构（FUNCTION 行 + 空语句 '.' 行 + 多个空行），oldString 匹配易失败——建议改用完整 FUNCTION...ENDFUNCTION 整体替换，或直接用 get_abap_diagnostics 验证；\n" +
    "  2. 参数必须声明在 FUNCTION 语句内（IMPORTING/EXPORTING/TABLES/EXCEPTIONS 关键字 + 最后一个参数后隐含句点结束），不能只写在注释里；\n" +
    "  3. 函数模块内不要定义 FORM（内联逻辑），否则报 DATA is unexpected。",
  write: true,
  inputSchema: z.object({
    fileUri: z
      .string()
      .describe("对象的 adt:// 工作区 URI（先用 get_abap_object_workspace_uri 获取）或 ADT 对象 URI"),
    oldString: z.string().describe("要替换的原文（必须恰好匹配一处，含缩进）"),
    newString: z.string().describe("替换后的文本"),
    requestText: z.string().optional().describe("对象无未释放传输请求时自动新建请求的描述（可选；推荐格式：sapbuddy_<修改内容摘要>_<YYYYMMDD>，如 sapbuddy_修改ZAIR004文本_20260802）"),
    connectionId: connectionIdSchema,
  }),
  async execute(args: { fileUri: string; oldString: string; newString: string; requestText?: string; connectionId?: string }): Promise<string> {
    try {
      // 解析 URI -> 连接与对象 URI
      let connId = args.connectionId
      let adtUri = args.fileUri
      if (args.fileUri.startsWith("adt://")) {
        const parsed = new URL(args.fileUri)
        connId = connId ?? parsed.hostname
        adtUri = parsed.pathname
      }
      const finalConnId = await resolveConnectionId(connId)
      const client = await getClient(finalConnId)

      // 解析真实源码 URI（对象主 URI 返回元数据 XML，源码在 /source/main）
      const sourceUri = await resolveSourceUri(client, adtUri)

      // 锁→改→存→解锁 必须在同一 stateful 会话中（切换会丢失 lock handle）
      const oldState = client.stateful
      client.stateful = session_types.stateful
      try {
        const lock = await client.lock(sourceUri)
        try {
          const content = await client.getObjectSource(sourceUri)
          const { findAndReplace } = await import("./replaceLogic.js")
          const updated = findAndReplace(content, args.oldString, args.newString)
          // 传输请求：优先沿用 lock 返回的 CORRNR；无未释放请求时自动创建新请求（ADT 不会自动创建）
          const lockInfo = lock as { CORRNR?: string; IS_LOCAL?: string }
          let transport = lockInfo.IS_LOCAL === "X" ? undefined : (lockInfo.CORRNR || undefined)
          let autoCreated = false
          if (!transport) {
            try {
              const { getClient: gc } = await import("../adtManager.js")
              const info = await gc(finalConnId).then((c) => c.transportInfo(sourceUri))
              const devclass = String(info?.DEVCLASS || info?.PDEVCLASS || "$TMP").trim()
              const desc = (args.requestText && String(args.requestText).trim()) || `sapbuddy_修改${String(args.fileUri || "").split("/").pop()}_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`
              const newReq = await client.createTransport(sourceUri, desc, devclass)
              if (newReq && newReq !== "") {
                transport = newReq
                autoCreated = true
              }
            } catch (e) {
              return `⚠️ 对象无未释放传输请求且自动创建失败（${e instanceof Error ? e.message.slice(0, 120) : e}）。请先创建传输请求或将对象加入现有请求。`
            }
          }
          await client.setObjectSource(sourceUri, updated, lock.LOCK_HANDLE, transport)
          await client.unLock(sourceUri, lock.LOCK_HANDLE)
          return (
            `✅ 替换成功并已保存到 SAP\n` +
            `URI: ${sourceUri}\n` +
            (transport ? `传输请求: ${transport}${autoCreated ? "（自动新建）" : "（沿用）"}\n` : `传输请求: (无，$TMP 对象)\n`) +
            `建议下一步: 调用 get_abap_diagnostics 检查语法，然后 abap_activate 激活。`
          )
        } catch (err) {
          await client.unLock(sourceUri, lock.LOCK_HANDLE).catch(() => undefined)
          throw err
        }
      } finally {
        client.stateful = oldState
      }
    } catch (err) {
      return `编辑失败: ${err instanceof Error ? err.message : err}\n\n可能的原因：\n- oldString 未唯一匹配（用 get_abap_object_lines 读当前内容核对）\n- 对象被其他用户锁定\n- SAP 账号无编辑权限`
    }
  },
}

// ─── get_abap_diagnostics ───────────────────────────────────────────────────
export const diagnosticsTool = {
  name: "get_abap_diagnostics",
  title: "Get ABAP Diagnostics",
  description:
    "对编辑后的 ABAP 源码执行语法检查，返回错误/警告列表（含行号和消息）。编辑流程的最后验证步骤。",
  inputSchema: z.object({
    fileUri: z
      .string()
      .describe("对象的 adt:// 工作区 URI 或 ADT 对象 URI（与 replace_string_in_abap_object 相同）"),
    connectionId: connectionIdSchema,
  }),
  async execute(args: { fileUri: string; connectionId?: string }): Promise<string> {
    try {
      let connId = args.connectionId
      let adtUri = args.fileUri
      if (args.fileUri.startsWith("adt://")) {
        const parsed = new URL(args.fileUri)
        connId = connId ?? parsed.hostname
        adtUri = parsed.pathname
      }
      const finalConnId = await resolveConnectionId(connId)
      const client = await getClient(finalConnId)

      const sourceUri = await resolveSourceUri(client, adtUri)
      const content = await client.getObjectSource(sourceUri)
      const checks = await client.syntaxCheck(sourceUri, sourceUri, content)

      if (!checks || checks.length === 0) {
        return `✅ 语法检查通过，无错误/警告（URI: ${sourceUri}）`
      }
      const errors = checks.filter((c) => c.severity === "E")
      const warnings = checks.filter((c) => c.severity !== "E")
      const lines = [
        `语法检查完成: ${errors.length} 个错误, ${warnings.length} 个警告（URI: ${sourceUri}）`,
      ]
      for (const c of checks.slice(0, 100)) {
        lines.push(`  [${c.severity}] 行 ${c.line}: ${c.text}`)
      }
      if (checks.length > 100) lines.push(`  ... 其余 ${checks.length - 100} 条省略`)
      lines.push(
        errors.length > 0
          ? "\n⚠️ 存在错误，建议用 replace_string_in_abap_object 修正后重新检查。"
          : "\n⚠️ 仅有警告，可激活但建议关注。"
      )
      return lines.join("\n")
    } catch (err) {
      return toToolError(err)
    }
  },
}

// ─── create_test_include ────────────────────────────────────────────────────
export const createTestIncludeTool = {
  name: "create_test_include",
  title: "Create Test Include",
  description: "为类创建测试 include（testclasses），用于添加 ABAP 单元测试代码。已存在时返回提示。",
  write: true,
  inputSchema: z.object({
    className: z.string().describe("类名，如 ZCL_MY_CLASS"),
    connectionId: connectionIdSchema,
  }),
  async execute(args: { className: string; connectionId?: string }): Promise<string> {
    try {
      const connId = await resolveConnectionId(args.connectionId)
      const obj = await requireObject(connId, args.className, "CLAS/OC", { includeDirectRead: false })
      const client = await getClient(connId)
      const oldState = client.stateful
      client.stateful = session_types.stateful
      try {
        const lock = await client.lock(obj["adtcore:uri"])
        try {
          await client.createTestInclude(obj["adtcore:name"], lock.LOCK_HANDLE)
        } finally {
          await client.unLock(obj["adtcore:uri"], lock.LOCK_HANDLE).catch(() => undefined)
        }
      } finally {
        client.stateful = oldState
      }
      return `✅ 已为 ${args.className} 创建测试 include。可用 get_abap_object_lines 读取并编辑测试代码。`
    } catch (err) {
      return `创建测试 include 失败: ${err instanceof Error ? err.message : err}`
    }
  },
}

// ─── update_object_description（修改对象描述/SE38标题）─────────────────────
export const updateDescriptionTool = {
  name: "update_object_description",
  title: "Update Object Description",
  description:
    "修改 ABAP 对象的描述/标题（SE38 属性页的标题字段，即 adtcore:description）。" +
    "通过 lock + PUT 对象 XML 实现，修改后自动激活。",
  write: true,
  inputSchema: z.object({
    objectName: z.string().describe("对象名称，如 ZAIR004"),
    objectType: objectTypeSchema,
    description: z.string().describe("新的描述/标题文本"),
    connectionId: connectionIdSchema,
  }),
  async execute(args: {
    objectName: string
    objectType?: string
    description: string
    connectionId?: string
  }): Promise<string> {
    try {
      const connId = await resolveConnectionId(args.connectionId)
      const obj = await requireObject(connId, args.objectName, args.objectType, { includeDirectRead: false })
      const client = await getClient(connId)
      const uri = obj["adtcore:uri"]

      const oldState = client.stateful
      client.stateful = session_types.stateful
      try {
        const lock = await client.lock(uri)
        try {
          const xml = await client.getObjectSource(uri)
          // 替换 adtcore:description 属性（XML 中可能带转义字符）
          const escaped = escapeXmlAttr(args.description)
          let newXml = xml.replace(
            /adtcore:description="[^"]*"/,
            `adtcore:description="${escaped}"`
          )
          // 容错：部分 ADT 版本用无前缀 description 属性
          if (newXml === xml) {
            newXml = xml.replace(/description="[^"]*"/, `description="${escaped}"`)
          }
          if (newXml === xml) {
            return `描述未变化（当前已是 \"${args.description}\"）`
          }
          await (client as unknown as {
            h: {
              request: (url: string, opts: Record<string, unknown>) => Promise<unknown>
            }
          }).h.request(uri, {
            method: "PUT",
            headers: { "Content-Type": "application/vnd.sap.adt.program.v1+xml" },
            qs: { lockHandle: lock.LOCK_HANDLE, corrNr: lock.CORRNR },
            body: newXml,
          })
        } finally {
          await client.unLock(uri, lock.LOCK_HANDLE).catch(() => undefined)
        }
      } finally {
        client.stateful = oldState
      }
      // PUT 后对象变为 inactive，需要激活
      await client.activate(obj["adtcore:name"], uri)
      return `✅ 对象描述已更新并激活: ${obj["adtcore:type"]} ${obj["adtcore:name"]} -> \"${args.description}\"`
    } catch (err) {
      return toToolError(err)
    }
  },
}

// ─── 占位注释（无未使用导入） ─────────────────────────────────────────────
