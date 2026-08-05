/** 工具组：对象管理/写操作（create_object_programmatically、abap_activate、replace_string_in_abap_object、get_abap_diagnostics、create_test_include） */
import { z } from "zod"
import { session_types, type ActivationResult } from "abap-adt-api"
import { getClient } from "../adtManager.js"
import { getActiveRequest, setActiveRequest } from "../taskTransport.js"
import {
  requireObject,
  resolveConnectionId,
  toToolError,
  escapeXmlAttr,
  connectionIdSchema,
  objectTypeSchema,
  readSourceSmart,
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
    requestText: z.string().optional().describe("传输请求描述（可选；未指定 requestNumber 且本需求还没有共享请求时，按此描述自动创建请求并挂载对象，推荐格式 sapbuddy_<摘要>_<YYYYMMDD>）"),
    requestNumber: z.string().optional().describe("指定传输请求号（可选；用户已给出请求号时用用户指定的，同一需求内后续对象复用该请求）"),
    parentName: z.string().optional().describe("父对象名（函数组/FUGR 需要）"),
    connectionId: connectionIdSchema,
  }),
  async execute(args: {
    objectType: string
    name: string
    description: string
    packageName: string
    requestText?: string
    requestNumber?: string
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
      // 请求：$TMP 不建请求；正式包用本需求共享请求（用户指定 requestNumber 或自动新建，同一需求复用）
      let transport: string | undefined
      const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, "")
      if (devClass.toUpperCase() !== "$TMP") {
        if (args.requestNumber && String(args.requestNumber).trim()) {
          transport = String(args.requestNumber).trim()
          setActiveRequest(connId, devClass, transport)
        } else {
          transport = getActiveRequest(connId, devClass)
        }
        if (!transport) {
          try {
            const desc =
              (args.requestText && String(args.requestText).trim()) ||
              `sapbuddy_创建${args.name.toUpperCase()}_${ymd}`
            transport = await client.createTransport(parentPath, desc, devClass)
            setActiveRequest(connId, devClass, transport)
          } catch (e) {
            return `⚠️ 自动创建传输请求失败：${e instanceof Error ? e.message.slice(0, 120) : e}。请确认对象放到哪个请求。`
          }
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
        (transport
          ? `传输请求: ${transport}${args.requestNumber ? "（用户指定）" : "（自动新建/本需求共享）"}\n`
          : `传输请求: (无，$TMP 对象)\n`) +
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
// 强制止损：同一对象连续激活失败达到阈值即拒绝执行，防止 AI 陷入无限重试死循环
const ACTIVATE_FAIL_LIMIT = 3
const activateFailCount = new Map<string, number>()

type ClientLike = Awaited<ReturnType<typeof getClient>>
type ActivateRef = {
  "adtcore:uri": string
  "adtcore:type": string
  "adtcore:name": string
  "adtcore:parentUri": string
}

/** 从主程序源码枚举 INCLUDE 语句名。行尾可带注释（"INCLUDE XXX.   "说明"），句点后即结束匹配 */
export function parseIncludeNames(source: string): string[] {
  const names: string[] = []
  for (const line of String(source ?? "").split("\n")) {
    const m = /^\s*INCLUDE\s+([A-Za-z][A-Za-z0-9_]*)\s*\./i.exec(line)
    if (m) names.push(m[1].toUpperCase())
  }
  return names
}

/**
 * 拆 INCLUDE 的可执行程序（PROG/P + 其 PROG/I）无法逐个编译：
 * 单独激活某个 INCLUDE 会对着兄弟 INCLUDE 的旧激活版本编译 → "Field/Type unknown" 死局。
 * 读主程序源码枚举 INCLUDE，分两步激活：① 批量激活全部 INCLUDE（一致编译）；② 字符串形式单独激活主程序。
 * 注意：绝不能把主程序放进批量数组并设 parentUri=自身——ADT 会把主程序当作父容器静默跳过
 * （返回 success=true 但主程序根本没激活，正是"激活成功却仍 inactive"的根因）。
 * 非 PROG/P/PROG/I 直接单对象激活。
 */
async function activateWithIncludes(
  client: ClientLike,
  obj: { "adtcore:uri": string; "adtcore:name": string; "adtcore:type"?: string }
): Promise<ActivationResult> {
  const type = obj["adtcore:type"] ?? ""
  if (type !== "PROG/P" && type !== "PROG/I") {
    return client.activate(obj["adtcore:name"], obj["adtcore:uri"], undefined, true)
  }
  // 找到主程序：直接激活主程序，或由 INCLUDE 反查主程序
  let mainUri = obj["adtcore:uri"]
  let mainName = obj["adtcore:name"]
  if (type === "PROG/I") {
    try {
      const mains = await client.mainPrograms(obj["adtcore:uri"])
      if (mains?.length) {
        mainUri = mains[0]["adtcore:uri"]
        mainName = mains[0]["adtcore:name"]
      }
    } catch { /* 反查主程序失败则按当前对象激活 */ }
  }
  // 枚举主程序源码中的 INCLUDE 语句
  const includes: ActivateRef[] = []
  try {
    const source = await readSourceSmart(client, "PROG/P", mainUri)
    for (const incName of parseIncludeNames(source)) {
      if (incName === mainName) continue
      includes.push({
        "adtcore:uri": `/sap/bc/adt/programs/includes/${incName.toLowerCase()}`,
        "adtcore:type": "PROG/I",
        "adtcore:name": incName,
        "adtcore:parentUri": mainUri,
      })
    }
  } catch { /* 读主程序源码失败：退化为仅激活主程序 */ }

  const results: ActivationResult[] = []
  // ① 先批量激活全部 INCLUDE，让 INCLUDE 之间在同一激活周期一致编译
  if (includes.length > 0) {
    try {
      results.push(await client.activate(includes, true))
    } catch (err) {
      results.push({
        success: false,
        messages: [{ objDescr: "", type: "E", line: 0, href: "", forceSupported: false, shortText: toToolError(err) }],
        inactive: [],
      })
    }
  }
  // ② 再以字符串形式单独激活主程序（无 parentUri，主程序才会真正被激活）
  try {
    results.push(await client.activate(mainName, mainUri, undefined, true))
  } catch (err) {
    results.push({
      success: false,
      messages: [{ objDescr: "", type: "E", line: 0, href: "", forceSupported: false, shortText: toToolError(err) }],
      inactive: [],
    })
  }
  return {
    success: results.every(r => r.success),
    messages: results.flatMap(r => r.messages ?? []),
    inactive: results.flatMap(r => r.inactive ?? []),
  }
}

export const activateTool = {
  name: "abap_activate",
  title: "Activate ABAP Object",
  description:
    "激活 ABAP 对象（等价于 SE80 的激活按钮）。激活后返回语法/激活消息列表。写入类代码后必须先激活才能生效。\n" +
    "⚠️ 函数组(FUGR)激活不会自动连带激活其内部的函数模块——函数模块需单独激活：objectName=函数模块名，objectType=FUGR/FF。\n" +
    "⚠️ 拆 INCLUDE 的可执行程序（主程序 PROG/P + 其 INCLUDE PROG/I）无法逐个编译——单独激活某个 INCLUDE 会对着兄弟 INCLUDE 的旧版本编译，必报 \"Field/Type unknown\"。激活时工具会自动先批量激活其全部 INCLUDE、再单独激活主程序（两步）；同一对象连续激活失败 3 次会被强制拦截，需停下向用户说明。",
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
      // ① 拆 INCLUDE 的可执行程序（PROG/P/PROG/I）无法逐个编译：单激活某个 INCLUDE 会对着兄弟
      //    INCLUDE 的旧版本编译，必报 "Field/Type unknown"。activateWithIncludes 分两步激活：
      //    先批量激活全部 INCLUDE，再单独激活主程序（批量数组带 parentUri=自身会被 ADT 静默跳过）。
      const result = await activateWithIncludes(client, obj)
      // ③ 强制止损：同一对象连续激活失败达阈值 → 拒绝执行，逼 AI 停下向用户求助
      // ③ 强制止损：同一对象连续激活失败达阈值 → 拒绝执行，逼 AI 停下向用户求助
      const failKey = `${obj["adtcore:type"]}|${obj["adtcore:name"]}`
      if (result.success) {
        activateFailCount.delete(failKey)
      } else {
        const n = (activateFailCount.get(failKey) ?? 0) + 1
        activateFailCount.set(failKey, n)
        if (n >= ACTIVATE_FAIL_LIMIT) {
          return (
            `❌ 对象 ${obj["adtcore:name"]} 连续激活失败已达 ${n} 次，已强制停止重试。\n` +
            `请先向用户说明现状（最近错误信息、对象当前激活状态），并请求下一步决策，禁止继续尝试激活同一对象。`
          )
        }
      }
      // ② 强制披露真实状态：未激活对象清单（未激活 = 未完成），防"全部验证通过"式虚假完成
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
      if ((result.inactive ?? []).length > 0) {
        lines.push(`⚠️ 以下对象仍未激活（未激活 = 未完成）：`)
        for (const rec of result.inactive) {
          const o = rec?.object
          if (o) lines.push(`  - ${o["adtcore:type"]} ${o["adtcore:name"]}`)
        }
      }
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
    requestText: z.string().optional().describe("对象无未释放请求且本需求无共享请求时，按此描述自动新建请求（可选；推荐格式：sapbuddy_<修改内容摘要>_<YYYYMMDD>，如 sapbuddy_修改ZAIR004文本_20260802）"),
    requestNumber: z.string().optional().describe("指定传输请求号（可选；用户已给出请求号时用用户指定的，本需求内复用）。不传时优先沿用对象自身未释放请求（lock.CORRNR），没有则复用本需求共享请求，都没有才自动新建"),
    connectionId: connectionIdSchema,
  }),
  async execute(args: { fileUri: string; oldString: string; newString: string; requestText?: string; requestNumber?: string; connectionId?: string }): Promise<string> {
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
          // 传输请求规则：
          // ① 对象自身未释放请求（lock.CORRNR）优先复用；$TMP（IS_LOCAL=X）不建请求；
          // ② 用户指定 requestNumber → 用用户指定的，并作为本需求共享请求；
          // ③ 否则复用本需求共享请求（同需求多对象放同一请求）；
          // ④ 都没有才自动新建一个，并记为共享请求。
          const lockInfo = lock as { CORRNR?: string; IS_LOCAL?: string }
          const isLocal = lockInfo.IS_LOCAL === "X"
          let transport = isLocal ? undefined : (lockInfo.CORRNR || undefined)
          let autoCreated = false
          if (!transport && !isLocal) {
            try {
              const { getClient: gc } = await import("../adtManager.js")
              const info = await gc(finalConnId).then((c) => c.transportInfo(sourceUri))
              const devclass = String(info?.DEVCLASS || info?.PDEVCLASS || "$TMP").trim()
              if (devclass.toUpperCase() === "$TMP") {
                transport = undefined // $TMP 对象不建请求
              } else if (args.requestNumber && String(args.requestNumber).trim()) {
                transport = String(args.requestNumber).trim()
                setActiveRequest(finalConnId, devclass, transport)
              } else {
                transport = getActiveRequest(finalConnId, devclass)
                if (!transport) {
                  const desc = (args.requestText && String(args.requestText).trim()) || `sapbuddy_修改${String(args.fileUri || "").split("/").pop()}_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`
                  const newReq = await client.createTransport(sourceUri, desc, devclass)
                  if (newReq && newReq !== "") {
                    transport = newReq
                    autoCreated = true
                    setActiveRequest(finalConnId, devclass, newReq)
                  }
                }
              }
            } catch (e) {
              return `⚠️ 对象无未释放传输请求且自动创建失败（${e instanceof Error ? e.message.slice(0, 120) : e}）。请先创建传输请求或将对象加入现有请求。`
            }
          }
          await client.setObjectSource(sourceUri, updated, lock.LOCK_HANDLE, transport)
          // 写入自检：保存后读回并核对新文本已写入（不能只报"成功"）
          const verifySource = await client.getObjectSource(sourceUri)
          const normVerify = String(verifySource).replace(/\r\n/g, "\n")
          const normNew = args.newString.replace(/\r\n/g, "\n")
          if (!normVerify.includes(normNew)) {
            throw new Error(
              `写入自检失败：保存后读回的对象源码中未找到新文本，对象可能未成功保存。` +
                `请用 get_abap_object_lines 核对当前状态后再试。`
            )
          }
          await client.unLock(sourceUri, lock.LOCK_HANDLE)
          return (
            `✅ 替换成功并已保存到 SAP（自检确认新内容已写入）\n` +
            `URI: ${sourceUri}\n` +
            (transport
              ? `传输请求: ${transport}${autoCreated ? "（自动新建）" : args.requestNumber ? "（用户指定）" : "（沿用）"}\n`
              : `传输请求: (无，$TMP 对象)\n`) +
            `建议下一步: 调用 get_abap_diagnostics 检查语法，然后 abap_activate 激活。`
          )
        } catch (err) {
          // 解锁失败必须报警：对象可能残留编辑锁（原来吞掉失败 → 残留锁让后续编辑全报"使用者当前编辑"）
          let unlockWarn = ""
          try {
            await client.unLock(sourceUri, lock.LOCK_HANDLE)
          } catch (unlockErr) {
            unlockWarn =
              `\n\n⚠️ 解锁失败：对象可能残留编辑锁（后续编辑会报"使用者当前编辑"）。` +
              `请稍后重试或手动释放锁。解锁错误: ${unlockErr instanceof Error ? unlockErr.message.slice(0, 200) : String(unlockErr)}`
          }
          throw new Error(`${err instanceof Error ? err.message : String(err)}${unlockWarn}`)
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
