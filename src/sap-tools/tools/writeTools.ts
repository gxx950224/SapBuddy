/** 工具组：对象管理/写操作（create_object_programmatically、abap_activate、replace_string_in_abap_object、get_abap_diagnostics、create_test_include） */
import { z } from "zod"
import { session_types, type ActivationResult } from "abap-adt-api"
import { getClient } from "../adtManager.js"
import { getActiveRequest, setActiveRequest } from "../taskTransport.js"
import { parseFunctionModuleParams, normalizeFunctionModuleParams, normalizeFormIncludeSource, isFmoduleSourceChannel, detectCommentParamBlock, escapeOpenSqlHostVars, FM_KINDS } from "./fmoduleInterface.js"
import {
  requireObject,
  resolveConnectionId,
  findObject,
  toToolError,
  sanitizeErrMsg,
  escapeXmlAttr,
  connectionIdSchema,
  objectTypeSchema,
  readSourceSmart,
  normalizeFunctionGroupIncludeUri,
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

/** 提取源码/文本里长度≥4 的标识符（去重、小写），用于自检的"关键内容核对"回退 */
function extractIdentifiers(s: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const re = /[A-Za-z_][A-Za-z0-9_]{3,}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    const w = m[0].toLowerCase()
    if (!seen.has(w)) {
      seen.add(w)
      out.push(w)
    }
  }
  return out
}

export type SaveVerifyResult = { ok: boolean; normalized?: boolean }

/**
 * 写入自检核对：保存后读回 vs 本次写入内容。
 * 服务器会把读回内容规范化（DDIC DSL 注解形式/字段大小写/空行，真机实测：结构 DSL 写入后读回被归一化），
 * 精确字符串比对会误报失败。三层核对：
 *   ① 精确包含；
 *   ② 空白归一化包含；
 *   ③ 关键内容回退：新内容里相对旧内容"新增"的标识符多数在读回里出现（写入成功即命中；失败读回仍是旧内容则缺失）。
 */
export function verifySavedContent(newContent: string, oldContent: string, readBack: string): SaveVerifyResult {
  const norm = (s: string) => String(s ?? "").replace(/\r\n/g, "\n")
  const collapseBlanks = (s: string) =>
    s.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "").join("\n")
  const normNew = norm(newContent)
  const normVerify = norm(readBack)
  if (normVerify.includes(normNew)) return { ok: true }
  if (collapseBlanks(normVerify).includes(collapseBlanks(normNew))) return { ok: true }
  const oldIdents = new Set(extractIdentifiers(norm(oldContent)))
  const newIdents = extractIdentifiers(normNew).filter((t) => !oldIdents.has(t))
  const verifyLower = normVerify.toLowerCase()
  const found = newIdents.filter((t) => new RegExp(`\\b${t}\\b`).test(verifyLower))
  if (newIdents.length > 0 && found.length > 0 && found.length / newIdents.length >= 0.6) {
    return { ok: true, normalized: true }
  }
  return { ok: false }
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

// ── DTEL 补域：创建出的数据元素壳缺域无法激活，把域（typeName）写进对象 ──
// 域信息（datatype/length/decimals）从绑定域的 getDomainProperties 读取，字段标签用域描述截断填充。
function cutLabel(s: string | undefined | null, n: number): string {
  return String(s ?? "").trim().slice(0, n)
}

/** 给刚创建的数据元素绑定域（ADT 走 setDataElementProperties，需 stateful 会话 lock）
 *  数据类型（datatype/length/decimals）从绑定域读取；元数据以已创建对象为准（getDataElementProperties），避免覆盖 createObject 已写入的描述/语言/包 */
async function fillDataElementDomain(
  client: Awaited<ReturnType<typeof getClient>>,
  name: string,
  domainName: string,
  packageName: string,
  description: string,
  transport?: string
): Promise<void> {
  const dtelUrl = `/sap/bc/adt/ddic/dataelements/${name.toLowerCase()}`
  const domUrl = `/sap/bc/adt/ddic/domains/${domainName.toLowerCase()}`
  const [dom, cur] = await Promise.all([
    client.getDomainProperties(domUrl),
    client.getDataElementProperties(dtelUrl).catch(() => undefined),
  ])
  const type = dom.properties.typeInformation
  const desc = cur?.metaData.description || description || name
  const props = {
    typeName: domainName,
    dataType: type.datatype,
    dataTypeLength: type.length,
    dataTypeDecimals: type.decimals,
    fieldLabels: {
      shortFieldLabel: cutLabel(desc, 10),
      mediumFieldLabel: cutLabel(desc, 20),
      longFieldLabel: cutLabel(desc, 40),
      headingFieldLabel: cutLabel(desc, 55),
    },
  }
  const meta = {
    name: cur?.metaData.name ?? name,
    description: desc,
    language: cur?.metaData.language ?? client.language ?? "ZH",
    masterLanguage: cur?.metaData.masterLanguage ?? client.language ?? "ZH",
    masterSystem: cur?.metaData.masterSystem ?? "",
    responsible: cur?.metaData.responsible ?? "",
    packageName: cur?.metaData.packageName ?? packageName,
  }
  const oldState = client.stateful
  client.stateful = session_types.stateful
  try {
    const lock = await client.lock(dtelUrl)
    try {
      const lockInfo = lock as { CORRNR?: string; IS_LOCAL?: string }
      const t = lockInfo.IS_LOCAL === "X" ? undefined : (lockInfo.CORRNR || transport)
      await client.setDataElementProperties(dtelUrl, props, meta, lock.LOCK_HANDLE, t)
    } finally {
      await client.unLock(dtelUrl, lock.LOCK_HANDLE).catch(() => undefined)
    }
  } finally {
    client.stateful = oldState
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
    "函数组用 FUGR/F 创建（parentName 不用填，用开发包）；函数模块用 FUGR/FF 创建（parentName 必须填函数组名，没填会拦截并提示向用户确认）。\n" +
    "函数组 include（L 开头子程序块，如 L<FG>F01，放 FORM）用 FUGR/I 创建（parentName 必须填函数组名，没填会拦截）。\n" +
    "requestText 提供时自动创建传输请求并挂载对象。创建后对象未激活，用 abap_activate 激活。",
  write: true,
  inputSchema: z.object({
    objectType: z
      .enum([
        "CLAS/OC", "INTF/OI", "PROG/I", "PROG/P", "FUGR/F", "FUGR/FF", "FUGR/I",
        "TABL/DT", "TABL/DS", "DTEL/DE", "DOMA/DD", "MSAG/N", "DEVC/K",
        "DDLS/DF", "DDLX/EX", "DDLA/ADF", "SRVD/SRV", "AUTH", "SUSO/B", "SRVB/SVB",
      ])
      .describe("对象类型 ID：CLAS/OC(类) INTF/OI(接口) PROG/P(可执行报表/主程序) PROG/I(Include 程序段，模板拆 TOP/CLS/IMP 用) FUGR/F(函数组) FUGR/FF(函数模块,需 parentName=函数组名) FUGR/I(函数组 include 子程序块 L<FG>xx,需 parentName=函数组名) TABL/DT(表) DEVC/K(包)"),
    name: z.string().describe("对象名称（大写，如 ZCL_MY_CLASS）"),
    description: z.string().describe("对象描述"),
    packageName: z.string().describe("所属开发包：正式开发包名，或 $TMP（临时测试包，不进传输）；先向用户确认"),
    requestText: z.string().optional().describe("传输请求描述（可选；未指定 requestNumber 且本需求还没有共享请求时，按此描述自动创建请求并挂载对象，推荐格式 sapbuddy_<摘要>_<YYYYMMDD>）"),
    requestNumber: z.string().optional().describe("指定传输请求号（可选；用户已给出请求号时用用户指定的，同一需求内后续对象复用该请求）"),
    parentName: z.string().optional().describe("父对象名：函数模块(FUGR/FF)与函数组 include(FUGR/I)需要，填函数组名（没填会被拦截并提示向用户确认）；创建函数组(FUGR/F)不用填"),
    domainName: z
      .string()
      .optional()
      .describe("数据元素(DTEL)绑定的域：仅 DTEL/DE 需要。缺省会被拦截——请先向用户确认域（标准域如 CHAR100/NUMC10，或先创建的 DOMA 自定义域）。数据元素缺域无法激活"),
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
    domainName?: string
    connectionId?: string
  }): Promise<string> {
    try {
      const connId = await resolveConnectionId(args.connectionId)
      // ── 强制规则：对象类型（写死，不允许自由发挥）──
      // FUGR/F = 创建函数组（parentName 不用填，用开发包）；FUGR/FF = 创建函数模块（parentName 必须=函数组名）
      const objType = (args.objectType || "").toUpperCase()
      if ((objType === "FUGR/FF" || objType === "FUGR/I") && !String(args.parentName ?? "").trim()) {
        return `⛔ 强制规则拦截：创建函数模块（FUGR/FF）或函数组 include（FUGR/I）必须提供 parentName（函数组名）。请先向用户收集函数组名称。`
      }
      // ── 强制规则：DTEL 必须带域，否则激活必报"未定义域或数据类型"（不能创建无法激活的壳）──
      const domainName = args.domainName ? String(args.domainName).trim().toUpperCase() : ""
      if (objType === "DTEL/DE" && !domainName) {
        return (
          "⛔ 强制规则拦截：创建数据元素(DTEL/DE)必须提供 domainName（绑定的域）。\n" +
          "数据元素缺域无法激活（激活报\"未定义域或数据类型\"）。请先向用户确认域：\n" +
          "· 标准域：如 CHAR100、NUMC10、STRING；\n" +
          "· 自定义域：先创建 DOMA（create_object_programmatically DOMA/DD）。"
        )
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
      // FUGR/F 创建函数组：parentName 语义是"所属开发包"（objectcreator 里映射为 packageRef），强制用 devClass
      const parentName = objType === "FUGR/F" ? devClass : (args.parentName ?? devClass)
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
      // DTEL 补域：创建出的壳缺域无法激活，写入域（typeName）使对象可直接激活
      let dtelNote = ""
      if (objType === "DTEL/DE" && domainName) {
        try {
          await fillDataElementDomain(client, args.name.toUpperCase(), domainName, devClass, args.description, transport)
          dtelNote = `域: ${domainName}（已写入 typeName，可直接激活）\n`
        } catch (e) {
          return (
            `⚠️ 数据元素 ${args.name.toUpperCase()} 已创建，但绑定域 ${domainName} 失败（对象未激活）。\n` +
            `错误: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}\n` +
            `请确认域 ${domainName} 存在（get_sap_system_info 或 search_abap_objects 查 DOMA），` +
            `或用 replace_string_in_abap_object 手工补 <dtel:typeName>。`
          )
        }
      }
      return (
        `✅ 对象创建成功: ${args.objectType} ${args.name.toUpperCase()}\n` +
        dtelNote +
        `包: ${devClass}\n` +
        (transport
          ? `传输请求: ${transport}${args.requestNumber ? "（用户指定）" : "（自动新建/本需求共享）"}\n`
          : `传输请求: (无，$TMP 对象)\n`) +
        `状态: 未激活（请用 abap_activate 激活）\n` +
        `注意: 大型对象（类、函数组）创建后可能需补充 includes 内容。`
      )
    } catch (err) {
      return (
        `创建对象失败: ${sanitizeErrMsg(err)}\n\n` +
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
 * 激活函数组里的 FORM include（UXX/U01/主程序除外）。关键事实（真机验证）：
 * 函数模块引用 FORM 时，写源码与激活都按函数组的"激活态"编译——FORM include 的改动不激活，
 * 只激活主程序 SAPL<fg> 也不会把它固化（"FORM ... does not exist" / "Parameter PERFORM declares no type"）。
 * 必须逐个激活 include 对象本体（UXX 是函数库生成文件、服务器报"变更到 L<FG>UXX 被禁止"，跳过；
 * U01 是函数模块持有者，交给函数模块自身激活，跳过）。
 */
async function activateFunctionGroupFormIncludes(client: ClientLike, fgName: string): Promise<ActivationResult> {
  const fg = fgName.toUpperCase()
  const mainUri = `/sap/bc/adt/functions/groups/${fg.toLowerCase()}/includes/sapl${fg.toLowerCase()}`
  const results: ActivationResult[] = []
  try {
    const source = await readSourceSmart(client, "PROG/P", mainUri)
    for (const incName of parseIncludeNames(source)) {
      const upper = incName.toUpperCase()
      if (upper === `SAPL${fg}` || upper === `L${fg}UXX` || upper === `L${fg}U01`) continue
      const incUri = `/sap/bc/adt/functions/groups/${fg.toLowerCase()}/includes/${upper.toLowerCase()}`
      try {
        results.push(await client.activate(upper, incUri, undefined, true))
      } catch (err) {
        results.push({
          success: false,
          messages: [{ objDescr: "", type: "E", line: 0, href: "", forceSupported: false, shortText: toToolError(err) }],
          inactive: [],
        })
      }
    }
  } catch {
    // 读主程序源码失败：跳过（主程序激活仍会进行）
  }
  return {
    success: results.every((r) => r.success),
    messages: results.flatMap((r) => r.messages ?? []),
    inactive: results.flatMap((r) => r.inactive ?? []),
  }
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
  // 函数模块（FUGR/FF）：激活顺序必须——① 先激活函数组 FORM include（把 include 里未激活的 FORM 改动固化，
  // 否则函数模块按"激活态"编译找不到 FORM，报 "FORM ... does not exist"）；② 再激活主程序 SAPL<fg>
  // （新增 INCLUDE 的行是对主程序的改动，函数模块激活时服务器会连带编译整个主程序，新 INCLUDE 语句没激活
  // 固化会报"主程序语法错误"）；③ 最后激活函数模块。
  if (type === "FUGR/FF") {
    const fgMatch = /\/functions\/groups\/([^/]+)\/fmodules\//i.exec(obj["adtcore:uri"])
    const fg = fgMatch ? decodeURIComponent(fgMatch[1]) : ""
    if (!fg) return client.activate(obj["adtcore:name"], obj["adtcore:uri"], undefined, true)
    const results: ActivationResult[] = []
    try {
      results.push(await activateFunctionGroupFormIncludes(client, fg))
    } catch (err) {
      results.push({
        success: false,
        messages: [{ objDescr: "", type: "E", line: 0, href: "", forceSupported: false, shortText: toToolError(err) }],
        inactive: [],
      })
    }
    try {
      results.push(
        await client.activate(`SAPL${fg}`.toUpperCase(), `/sap/bc/adt/functions/groups/${fg.toLowerCase()}/includes/sapl${fg.toLowerCase()}`, undefined, true)
      )
    } catch (err) {
      results.push({
        success: false,
        messages: [{ objDescr: "", type: "E", line: 0, href: "", forceSupported: false, shortText: toToolError(err) }],
        inactive: [],
      })
    }
    try {
      results.push(await client.activate(obj["adtcore:name"], obj["adtcore:uri"], undefined, true))
    } catch (err) {
      results.push({
        success: false,
        messages: [{ objDescr: "", type: "E", line: 0, href: "", forceSupported: false, shortText: toToolError(err) }],
        inactive: [],
      })
    }
    return {
      success: results.every((r) => r.success),
      messages: results.flatMap((r) => r.messages ?? []),
      inactive: results.flatMap((r) => r.inactive ?? []),
    }
  }
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
  // 反查到函数组（mainPrograms 对函数组 include 返回 FUGR/F 基址：name=函数组名如 ZAVERIFYFG、uri=/functions/groups/<fg>）：
  // 主程序名必须规范为 SAPL<fg>，主程序 URI 是 /functions/groups/<fg>/includes/sapl<fg>，
  // 否则按函数组名激活会连带用错通道（真机报"变更到 L<FG>UXX 被禁止"）。
  if (mainUri.match(/\/functions\/groups\/[^/]+$/) && !mainUri.includes("/includes/")) {
    const fg = mainUri.split("/").pop()!
    mainName = `SAPL${fg}`.toUpperCase()
    mainUri = `/sap/bc/adt/functions/groups/${fg.toLowerCase()}/includes/sapl${fg.toLowerCase()}`
  }
  // 枚举主程序源码中的 INCLUDE 语句
  const includes: ActivateRef[] = []
  try {
    const source = await readSourceSmart(client, "PROG/P", mainUri)
    const fgMatch = mainUri.match(/\/functions\/groups\/([^/]+)/)
    const fgName = fgMatch ? decodeURIComponent(fgMatch[1]) : /^SAPL/i.test(mainName) ? mainName.replace(/^SAPL/i, "") : ""
    for (const incName of parseIncludeNames(source)) {
      if (incName === mainName) continue
      // 函数组蕴含程序（L<FG>*，FUGR/I）不放进批量激活数组：真机实测服务器对批量数组里的函数组 include
      // 一律报"变更到 L<FG>UXX 被禁止"（与 /programs/includes/ 还是函数组通道无关）——它们由第②步
      // 单独激活主程序（SAPL<fg>）时连带激活。普通 INCLUDE 走 /programs/includes/ 通用通道批量激活。
      if (fgName !== "" && /^L/i.test(incName)) continue
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
    "⚠️ 函数组(FUGR)激活不会自动连带激活其内部的函数模块——函数模块需单独激活：objectName=函数模块名，objectType=FUGR/FF。激活函数模块时工具会自动先激活函数组的 FORM include（把未激活的 FORM 改动固化，否则报 FORM ... does not exist）、再激活主程序(SAPL<fg>，让主程序里新增的 INCLUDE 语句先固化生效)、最后激活函数模块本身，AI 无需手动排顺序。\n" +
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
    "编辑 ABAP 源码（MCP 客户端的编辑工具）。两种模式：\n" +
    "  ① 局部替换：oldString + newString，oldString 必须唯一匹配（含空白，建议带 3-5 行上下文）；\n" +
    "  ② 整段覆盖：只传 fullSource=完整新源码，直接覆盖整个对象源码（推荐用于新建/整体重写函数模块——不需要先读模板、不需要构造 oldString 去匹配模板空行）。\n" +
    "编辑后自动保存并释放锁；自动处理 CRLF/LF 差异；非 $TMP 对象自动使用 lock.CORRNR 作为传输请求。\n" +
    "⚠️ 函数模块(FUGR/FF)源码的特殊性：\n" +
    "  0. 新建函数模块最省 token 的写法：get_abap_object_workspace_uri 拿到 URI 后，直接传 fullSource=完整源码（FUNCTION 行 + 参数段 + 独立 . + 函数体 + ENDFUNCTION.）一步写入。不要先 get_abap_object_lines 读模板，不要数模板空行，服务器会自动提取参数进接口。⚠️ FUNCTION 行不要带句点（写 FUNCTION ZFM_X 后直接换行写参数段；写成 FUNCTION ZFM_X. 会导致服务器残留模板头、参数区提前结束报 IMPORTING is not expected，本工具会自动移除句点但请勿再写）。\n" +
    "  1. 参数（IMPORTING/EXPORTING/CHANGING/TABLES/EXCEPTIONS）写在 FUNCTION 行后、参数区结束句点 . 之前，保存时服务器自动提取进接口元数据（SE37 接口页）。函数体语句（如 SELECT）必须写在参数区结束句点 . 之后。模板里的独立 . 行是参数区结束符，不要删掉；如果漏写了，本工具会自动补。\n" +
    "  2. 参数不能内联声明表类型：TYPE STANDARD TABLE OF <表> / TYPE TABLE OF <表> 都会报错（SAP 报 Parameter OF declares no type）。要返回一张表，用 TABLES 段最稳（如 TABLES ET_MARC LIKE MARC，函数体用 INTO TABLE @ET_MARC）；本工具检测到内联表类型会自动中止并提示正确写法。\n" +
    "  3. TYPE 后的类型名必须是系统中真实存在的对象（本工具会校验存在性）：数据元素（如 WERKS_D、MATNR）、表类型，或表/结构（TYPE MARC、TYPE ZAIG_TEST02_S 引用该结构/表本身，合法，不拦截）。若本意是传单个字段值（如工厂代码）要用数据元素名：工厂字段是 WERKS_D 而非 WERKS（WERKS 是 INTTAB 结构）。拿不准时先 search_abap_objects 确认，或用 LIKE <表> 引用表。\n" +
    "  3b. ⚠️ Open SQL（SELECT/INSERT/UPDATE/MODIFY/DELETE/WITH）里引用接口参数/变量必须带 @ 前缀（WHERE matnr = @iv_matnr、INTO TABLE @et_mard），否则报 The variable X must be escaped using @ / X is invalid here (due to grammar)。本工具会自动补 @ 转义，但请规范书写避免多轮往返。\n" +
    "  4. 其它自动检查：EXPORTING 参数不能带 DEFAULT、同一参数不能同时带 DEFAULT 与 OPTIONAL（自动修正）；参数区漏写结束句点 . 会自动补；用 *\" 注释写参数会被拦截并引导改用真实声明。\n" +
    "  5. 函数模块源码请用 get_abap_object_workspace_uri 获取其自身的 /functions/groups/<函数组>/fmodules/<函数模块>/source/main 通道再编辑（函数模块可按模块名直接定位）；不要写进函数组代码文件（include/SAPL<FG>）。\n" +
    "  6. 函数模块内不要定义 FORM（内联逻辑），否则报 DATA is unexpected。函数模块直接写 PERFORM <form> ... 调用函数组 include 里的 FORM 即可（同一函数组内 FORM 与函数模块编译进同一主程序，不需要 IN PROGRAM）。\n" +
    "  6b. ⚠️ FORM 参数（写进函数组 include 的 FORM ... ENDFORM 段）不能内联声明表类型：`CHANGING CT_MARD TYPE STANDARD TABLE OF MARD` 会被 SAP 解析成 6 个形式参数（按结构字段展开），PERFORM 侧报 Different number of parameters（formal: 6, actual: 4）。正确写法：先在 include 顶部定义表类型 `TYPES: tt_mard TYPE STANDARD TABLE OF MARD.`，FORM 参数引用 `TYPE tt_mard`。本工具会自动改写并补类型定义，但请规范书写。\n" +
    "  6c. ⚠️ 函数模块 TABLES 段参数（如 TABLES ET_MARD LIKE MARD）是带表头行的表：PERFORM 传整表给 FORM 的表参数必须写 `ET_MARD[]`（整表）；写 `ET_MARD` 传的是表头行，报 ET_MARD is the header line of table ET_MARD[]。函数模块内 OPEN SQL 用 INTO TABLE @et_mard 写整表。\n" +
    "  7. ⚠️ 不要反复试错：每次写入前想清楚结构；若同一编辑连续 2 次失败，停下向用户说明现状与下一步，等待用户决定，禁止继续换写法盲试（浪费 token）。",
  write: true,
  inputSchema: z.object({
    fileUri: z
      .string()
      .describe("ADT 对象 URI（如 /sap/bc/adt/programs/programs/zairtest04，来自 get_abap_object_workspace_uri 返回的「ADT 对象 URI」行）。工作区 URI（adt://...）也可传，工具会自动转换为 ADT 对象 URI"),
    oldString: z.string().optional().describe("要替换的原文（必须恰好匹配一处，含缩进；局部替换模式用，与 fullSource 二选一）"),
    newString: z.string().optional().describe("替换后的文本（局部替换模式用）"),
    fullSource: z.string().optional().describe("完整新源码，整段覆盖整个对象（推荐新建/整体重写函数模块时用：FUNCTION + 参数段 + . + 函数体 + ENDFUNCTION.；与 oldString/newString 二选一）"),
    requestText: z.string().optional().describe("对象无未释放请求且本需求无共享请求时，按此描述自动新建请求（可选；推荐格式：sapbuddy_<修改内容摘要>_<YYYYMMDD>，如 sapbuddy_修改ZAIR004文本_20260802）"),
    requestNumber: z.string().optional().describe("指定传输请求号（可选；用户已给出请求号时用用户指定的，本需求内复用）。不传时优先沿用对象自身未释放请求（lock.CORRNR），没有则复用本需求共享请求，都没有才自动新建"),
    connectionId: connectionIdSchema,
  }),
  async execute(args: { fileUri: string; oldString?: string; newString?: string; fullSource?: string; requestText?: string; requestNumber?: string; connectionId?: string }): Promise<string> {
    let fgIncludeHint = ""
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

      // 工作区 URI（adt://dev/$TMP/ZAIRTEST04）的 pathname 是 ADT 树定位路径（开发包/对象名），不是 REST 资源 URI。
      // 自动解析为 ADT 对象 URI（/sap/bc/adt/programs/programs/zairtest04），避免 "Invalid Object URL" 式重试。
      if (!adtUri.startsWith("/sap/bc/adt/")) {
        const name = (adtUri.split("/").filter(Boolean).pop() || "").toUpperCase()
        if (name) {
          const resolved = await findObject(finalConnId, name, undefined, undefined, { includeDirectRead: false })
          if (resolved?.["adtcore:uri"]) adtUri = resolved["adtcore:uri"]
        }
      }

      // 函数组 include 写路径不认 /programs/includes/ 通用通道，改写为 /functions/groups/<fg>/includes/<inc>
      const fgUri = await normalizeFunctionGroupIncludeUri(finalConnId, adtUri)
      if (fgUri) {
        adtUri = fgUri
      } else if (
        adtUri.includes("/sap/bc/adt/programs/includes/") &&
        /^[LS]/.test((adtUri.split("/").pop() ?? "").toUpperCase())
      ) {
        fgIncludeHint = `\n- 函数组 include 写路径需用 /sap/bc/adt/functions/groups/<函数组>/includes/<include> 格式（自动转换失败，请核对函数组名）`
      }

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
          const newContent = args.fullSource ?? args.newString
          if (!newContent || (!args.fullSource && (!args.oldString || !args.newString))) {
            throw new Error("参数缺失：整段覆盖请传 fullSource（完整新源码）；局部替换请同时传 oldString 与 newString。")
          }
          let updated = args.fullSource ?? findAndReplace(content, args.oldString!, args.newString!)
          // ── 函数模块参数段强控：检测到往源码里写 IMPORTING/TABLES 等参数段 → 规范化为服务器接受格式后放行 ──
          // 关键事实：ADT 服务器会从 /source/main 的源码 PUT 里自动提取函数模块接口参数进元数据（FUPARAREF），
          // 不需要写对象 XML。但服务器有硬约束（真机实测）：DEFAULT 仅 IMPORTING/CHANGING（EXPORTING 会报错）、
          // DEFAULT 与 OPTIONAL 不能并存、TABLES 不能内联 "TYPE ... TABLE OF ..."。
          // 拦截流程：规范化参数块（无法修正的报错中止，对象保持原状）→ 放行源码写入 → 服务器自动提取。
          let fmNote = ""
          // 用 *" 注释行写接口参数是错误写法（注释不会被服务器提取进接口）；函数模块自身通道合法内容不会出现 *"，
          // 一旦 newString 里出现 *" + 参数段关键字 → 立即拦截并引导用真实声明。
          if (isFmoduleSourceChannel(sourceUri) && detectCommentParamBlock(newContent)) {
            throw new Error(
              `检测到用 *" 注释行写函数模块接口参数，这是错误写法——注释不会被服务器提取进接口（SE37 接口页不会出现这些参数）。\n` +
              `正确做法: 在函数模块自身的通道里写真实参数声明（不要带 *"）：\n` +
              `  FUNCTION <模块名>\n    IMPORTING\n      VALUE(IV_X) TYPE <数据元素>\n    TABLES\n      ET_ROWS LIKE <表>\n  .\n  <函数体>\nENDFUNCTION.\n` +
              `保存时服务器自动把真实声明提取进接口。请删掉 *" 前缀、改用真实声明重写。`
            )
          }
          const fmNorm = normalizeFunctionModuleParams(updated)
          if (fmNorm.matched) {
            // 通道强控：函数模块接口参数（IMPORTING/TABLES 等）只能写进函数模块自身的 /fmodules/<fm>/source/main 合成视图，
            // 服务器从这里提取进接口（SE37）。写进函数组代码文件（include / SAPL<FG>）SAP 会报 "IMPORTING is not expected"，
            // 且接口参数根本不会被提取。检测到参数段但编辑通道不对 → 中止并指路。
            const isFmoduleChannel = isFmoduleSourceChannel(sourceUri)
            if (!isFmoduleChannel) {
              throw new Error(
                `检测到函数模块源码中写了接口参数段（${fmNorm.presentKinds.join("/")}），但当前编辑的不是函数模块自身的源码通道。\n` +
                `当前通道: ${sourceUri}\n` +
                `正确做法: 接口参数必须写在函数模块自身的通道 /functions/groups/<函数组>/fmodules/<函数模块>/source/main（服务器从那里自动提取进 SE37 接口）。\n` +
                `完整流程: ① get_abap_object_workspace_uri(objectName, "FUGR/FF") 获取函数模块工作区 URI → ② get_object_by_uri 读当前模板 → ③ 用该 URI 调 replace_string_in_abap_object 写入。\n` +
                `不要写进函数组代码文件（include/SAPL<FG>），那里 SAP 会报 "IMPORTING is not expected" 语法错误，接口参数也不会被提取。`
              )
            }
            if (fmNorm.errors.length > 0) {
              throw new Error(
                `检测到函数模块源码中写了接口参数段（${fmNorm.presentKinds.join("/")}），` +
                `但存在服务器无法接受的参数写法，已中止本次编辑（对象未改动）。\n` +
                fmNorm.errors.map((e) => `- ${e}`).join("\n") +
                `\n说明: 参数会由服务器自动提取进函数模块接口（SE37）。返回"表"时最推荐用 TABLES 段（TABLES ET_MARC LIKE MARC），` +
                `或引用已定义的表类型（如 TYPE STRING_TABLE），不能写 TYPE STANDARD TABLE OF ...（SAP 会报 Parameter OF declares no type）。请按提示修正后重试。`
              )
            }
            // 参数类型校验：TYPE <名字> 必须是系统中真实存在的名称（DD04L 数据元素 / DD40L 表类型 / DD02L 表与结构）。
            // 表/结构名（DD02L，如 WERKS 是 INTTAB 结构、MARC 是 TRANSP 表）可以直接当 TYPE 用（引用结构/表本身，合法）。
            // 最常见错误：把表字段名当类型名，如 MARC 表的工厂字段 WERKS 的数据元素是 WERKS_D 而非 WERKS——这种情况放行但给提示。
            // 只对"名字完全不存在"写入前拦截，避免激活失败后反复试错烧 token。
            let typeNotes: string[] = []
            {
              const isBuiltinType = (t: string) =>
                /^[CNDTIFPX]$/.test(t) ||
                /^(STRING|XSTRING|RAW|CHAR|NUMC|DEC|QUAN|CURR)$/i.test(t) ||
                /^(CHAR|NUMC|X)\d*$/i.test(t)
              const toCheck: { param: string; type: string }[] = []
              for (const kind of FM_KINDS) {
                for (const p of fmNorm.groups[kind] ?? []) {
                  if (p.typeKind !== "TYPE" || !p.type) continue
                  if (/[^A-Z0-9_]/.test(p.type)) continue // 复杂类型（含 => 等）跳过校验
                  if (!isBuiltinType(p.type)) toCheck.push({ param: p.name, type: p.type })
                }
              }
              const issues: { param: string; type: string; reason: string }[] = []
              if (toCheck.length > 0) {
                for (const c of toCheck) {
                  try {
                    const [de, tt, st] = await Promise.all([
                      client.runQuery(`SELECT ROLLNAME FROM DD04L WHERE ROLLNAME = '${c.type}'`, 1, true),
                      client.runQuery(`SELECT TYPENAME FROM DD40L WHERE TYPENAME = '${c.type}'`, 1, true),
                      client.runQuery(`SELECT TABNAME FROM DD02L WHERE TABNAME = '${c.type}'`, 1, true),
                    ])
                    const inDE = (de?.values ?? []).length > 0
                    const inTT = (tt?.values ?? []).length > 0
                    const inTab = (st?.values ?? []).length > 0
                    if (inDE || inTT) continue // 数据元素/表类型 → 合法类型名
                    if (inTab) {
                      // 表/结构名（DD02L）：TYPE 引用结构/表本身是合法 ABAP（如 TYPE MARC、TYPE ZAIG_TEST02_S）。
                      // 不拦截，仅提醒：若本意是单个字段值（如工厂代码），应改用数据元素 WERKS_D。
                      typeNotes.push(
                        `${c.param} 的类型 ${c.type} 是表/结构名（非数据元素）——TYPE 引用的是该结构/表本身（合法）；若本意是传单个字段值（如工厂代码），请改用数据元素 WERKS_D`
                      )
                    } else {
                      issues.push({
                        param: c.param,
                        type: c.type,
                        reason: `"${c.type}" 不是系统中存在的名称（数据元素/表类型/表均无此名）`,
                      })
                    }
                  } catch {
                    /* 查询失败跳过该校验，避免误拦 */
                  }
                }
              }
              if (issues.length > 0) {
                throw new Error(
                  `检测到函数模块参数类型有问题，已中止本次编辑（对象未改动）。\n` +
                  issues.map((i) => `- 参数 ${i.param} 的类型 ${i.type}: ${i.reason}`).join("\n") +
                  `\n说明: 参数类型名必须写系统中真实存在的数据元素或表类型。最常见错误是把表字段名当类型名——` +
                  `MARC 表的工厂字段是 WERKS，但正确的数据元素是 WERKS_D（不是 WERKS）；物料字段 MATNR 恰好就是数据元素。` +
                  `拿不准请先用 search_abap_objects 确认，或改用 LIKE <表> 引用表。`
                )
              }
            }
            if (fmNorm.normalized !== updated) {
              fmNote = `\n⚙️ 接口参数写法已自动修正后写入: ${fmNorm.notes.join("；")}\n`
              updated = fmNorm.normalized
            } else {
              fmNote = `\n⚙️ 检测到函数模块接口参数段，已随源码写入，服务器自动提取进接口（SE37）\n`
            }
            if (typeNotes.length > 0) {
              fmNote += `\nℹ️ 类型说明: ${typeNotes.join("；")}\n`
            }
            // Open SQL 内引用接口参数必须加 @（ABAP 主机变量转义）：自动给 SQL 语句窗口内的接口参数补 @，
            // 避免 `INTO TABLE et_mard` / `WHERE matnr = iv_matnr` 报语法错误（真机实测两个都会报错）。
            const sqlEsc = escapeOpenSqlHostVars(updated, fmNorm.groups)
            if (sqlEsc.changed) {
              updated = sqlEsc.source
              fmNote += `\n⚙️ Open SQL 内接口参数已自动加 @ 转义（ABAP 要求 SQL 中主机变量带 @ 前缀）: ${sqlEsc.names.join(", ")}\n`
            }
          }
          // ── 函数组 FORM include 参数强控：FORM 参数段内联表类型 → 自动改写为引用 tt_<表> 并补类型定义 ──
          // 真机实测：FORM 参数写 `TYPE STANDARD TABLE OF MARD` 会被 SAP 解析成 6 个形式参数（按结构字段展开），
          // PERFORM 侧报 "Different number of parameters in FORM and PERFORM"。正确写法是先定义表类型
          // `TYPES: tt_mard TYPE STANDARD TABLE OF MARD.`，FORM 参数引用 `TYPE tt_mard`。本工具自动改写。
          // 只对函数组 include（非主程序/UXX/U01）自动处理；UXX 是生成文件、U01 是函数模块持有者。
          let incNormNote = ""
          const fgIncNorm = /\/functions\/groups\/([^/]+)\/includes\/([^/]+)\/source\/main/i.exec(sourceUri)
          if (fgIncNorm) {
            const fgName = decodeURIComponent(fgIncNorm[1])
            const incUpper = decodeURIComponent(fgIncNorm[2]).toUpperCase()
            const mainName = `SAPL${fgName}`.toUpperCase()
            if (incUpper !== mainName && incUpper !== `L${fgName}UXX`.toUpperCase() && incUpper !== `L${fgName}U01`.toUpperCase()) {
              const incRes = normalizeFormIncludeSource(updated)
              if (incRes.changed) {
                updated = incRes.source
                incNormNote = `\n⚙️ FORM 参数内联表类型已自动修正（内联表类型 SAP 会解析成多个形式参数导致 PERFORM 对不上）: ${incRes.notes.join("；")}\n`
              }
            }
          }
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
          // 空白归一化：服务器保存时会把连续空行合并、行尾空格去掉，字符串精确比对会误报失败
          // （函数模块通道最常见的假警报：写成功却报"未找到新文本"）。
          const collapseBlanks = (s: string) =>
            s.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "").join("\n")
          // 服务器会规范化读回（DDIC DSL 注解形式/字段大小写/空行），精确比对会误报失败 → 用关键内容回退核对
          let savedByNorm = false
          if (fmNorm.matched) {
            // 有参数段：读回源码会被服务器提取进接口并以规范化形式显示（参数名大小写归一、段尾句点合并），
            // 改为核对接口参数名都被服务器提取保留（这正是强控的目的）。
            const back = parseFunctionModuleParams(normVerify)
            const expectNames = new Set(Object.values(fmNorm.groups).flat().map((p) => p.name.toUpperCase()).filter(Boolean))
            const gotNames = new Set(Object.values(back.groups ?? {}).flat().map((p) => p.name.toUpperCase()).filter(Boolean))
            const missing = [...expectNames].filter((n) => !gotNames.has(n))
            if (!back.matched || missing.length > 0) {
              throw new Error(
                `写入自检失败：保存后读回的对象源码中未确认接口参数 ${missing.join(", ") || "（参数段丢失）"}，` +
                  `服务器可能未成功提取。\n` +
                  `常见原因：FUNCTION 行带了句点或模板注释行/多余独立 . 残留，导致参数区提前结束（读回源码里 IMPORTING 前出现独立 . 就说明这一点，语法会报 IMPORTING is not expected）。` +
                  `请用 fullSource 整体重写为规范格式：FUNCTION <名>（不带句点）→ 参数段 → 独立 . → 函数体 → ENDFUNCTION.。`
              )
            }
          } else if (isFmoduleSourceChannel(sourceUri)) {
            // 函数模块通道写函数体（无参数段）时，服务器同样会归一化格式 → 用空白归一化比对避免误报
            if (!collapseBlanks(normVerify).includes(collapseBlanks(newContent))) {
              throw new Error(
                `写入自检失败：保存后读回的对象源码中未找到新文本，对象可能未成功保存。` +
                  `请用 get_abap_object_lines 核对当前状态后再试。`
              )
            }
          } else {
            // include 归一化改写后读回的是规范化源码（内联表类型已被替换），须按规范化结果核对而非原始输入
            const v = verifySavedContent(incNormNote ? updated : newContent, content, verifySource)
            if (!v.ok) {
              throw new Error(
                `写入自检失败：保存后读回的对象源码中未找到新文本，对象可能未成功保存。` +
                  `请用 get_abap_object_lines 核对当前状态后再试。`
              )
            }
            if (v.normalized) savedByNorm = true
          }
          await client.unLock(sourceUri, lock.LOCK_HANDLE)
          // 函数组 FORM include 写后自动激活：函数模块引用 FORM 时按"激活态"编译（真机验证），
          // include 改动不激活 → 后续写/激活函数模块报 "FORM ... does not exist" / "Parameter PERFORM declares no type"。
          // 只对函数组 include（非主程序/UXX/U01）自动激活；UXX 是生成文件被服务器禁止、U01 是函数模块持有者。
          let incActNote = ""
          const fgIncMatch = /\/functions\/groups\/([^/]+)\/includes\/([^/]+)\/source\/main/i.exec(sourceUri)
          if (fgIncMatch) {
            const fgName = decodeURIComponent(fgIncMatch[1])
            const incUpper = decodeURIComponent(fgIncMatch[2]).toUpperCase()
            const mainName = `SAPL${fgName}`.toUpperCase()
            if (incUpper !== mainName && incUpper !== `L${fgName}UXX`.toUpperCase() && incUpper !== `L${fgName}U01`.toUpperCase()) {
              const incObjUri = `/sap/bc/adt/functions/groups/${fgName.toLowerCase()}/includes/${incUpper.toLowerCase()}`
              try {
                const r = await client.activate(incUpper, incObjUri, undefined, true)
                if (r.success) {
                  incActNote = `\n⚙️ 已自动激活函数组 include ${incUpper}（FORM 需处于激活态才能被函数模块引用）\n`
                } else {
                  const errs = (r.messages ?? []).filter((m) => m.type === "E").map((m) => `行 ${m.line}: ${m.shortText}`)
                  incActNote = `\n⚠️ include ${incUpper} 已保存但自动激活失败：${errs.slice(0, 5).join("；") || "服务器无错误消息"}。请用 abap_activate 单独激活并查看错误。\n`
                }
              } catch (err) {
                incActNote = `\n⚠️ include ${incUpper} 已保存但自动激活失败：${err instanceof Error ? err.message.slice(0, 200) : String(err)}。请用 abap_activate 单独激活。\n`
              }
            }
          }
          return (
            `✅ 替换成功并已保存到 SAP（自检确认新内容已写入）\n` +
            fmNote +
            incNormNote +
            incActNote +
            (savedByNorm
              ? `\n⚙️ 读回为服务器规范化格式，已按关键内容核对确认写入（DDIC 结构等对象的源码会被归一化显示）\n`
              : "") +
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
      return (
        `编辑失败: ${sanitizeErrMsg(err)}\n\n可能的原因：\n- oldString 未唯一匹配（局部替换时，用 get_abap_object_lines 读当前内容核对）\n- fullSource 内容与对象类型不匹配（整段覆盖时）\n- 对象被其他用户锁定\n- SAP 账号无编辑权限` +
        fgIncludeHint
      )
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
      .describe("ADT 对象 URI（与 replace_string_in_abap_object 相同）；工作区 URI（adt://...）会自动转换"),
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

      // 工作区 URI（adt://dev/$TMP/ZAIRTEST04）的 pathname 是 ADT 树定位路径（开发包/对象名），不是 REST 资源 URI。
      // 自动解析为 ADT 对象 URI（/sap/bc/adt/programs/programs/zairtest04），避免 "Invalid Object URL" 式重试。
      if (!adtUri.startsWith("/sap/bc/adt/")) {
        const name = (adtUri.split("/").filter(Boolean).pop() || "").toUpperCase()
        if (name) {
          const resolved = await findObject(finalConnId, name, undefined, undefined, { includeDirectRead: false })
          if (resolved?.["adtcore:uri"]) adtUri = resolved["adtcore:uri"]
        }
      }

      // 函数组 include 写路径不认 /programs/includes/ 通用通道，改写为 /functions/groups/<fg>/includes/<inc>
      const fgUri = await normalizeFunctionGroupIncludeUri(finalConnId, adtUri)
      if (fgUri) adtUri = fgUri

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
      return `创建测试 include 失败: ${sanitizeErrMsg(err)}`
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
