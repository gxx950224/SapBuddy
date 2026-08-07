/** 工具公共辅助：搜索结果格式化、错误处理 */
import { z } from "zod"
import { SearchResult } from "abap-adt-api"
import { getClient, isConnectionError, markConnectionUnhealthy } from "../adtManager.js"

/** 默认搜索类型（与 abap_fs 保持一致） */
export const DEFAULT_SEARCH_TYPES = [
  "FUNC", "CLAS", "TABL", "PROG", "INTF", "DTEL", "DDLS", "DOMA", "TTYP",
  "ENQU", "MSAG", "FUGR", "DEVC", "TRAN", "VIEW", "SICF", "WDYN", "SPRX",
  "XSLT", "TRANSFORMATIONS", "SUSH", "SUSC", "PINF", "ENHC", "ENHO", "ENHS",
  "BADI", "BADII", "SAMC", "SAPC", "SFSW", "SFBF", "SFBS", "JOBD", "NROB",
  "SUSO", "BDEF", "SRVB",
] as const

export const connectionIdSchema = z
  .string()
  .optional()
  .describe("SAP 连接 ID，省略时使用 get_connected_systems 返回的第一个连接")

export const objectTypeSchema = z
  .string()
  .optional()
  .describe("ABAP 对象类型代码，如 CLAS(类) PROG(报表) TABL(表) INTF(接口) FUNC(函数) DDLS(CDS) DTEL(数据元素)")

export function formatSearchResult(r: SearchResult): string {
  const type = r["adtcore:type"]
  const name = r["adtcore:name"]
  const desc = r["adtcore:description"] ? ` - ${r["adtcore:description"]}` : ""
  const pkg = r["adtcore:packageName"] ? ` [${r["adtcore:packageName"]}]` : ""
  return `${type.padEnd(6)} ${name}${pkg}${desc}`
}

/** XML 属性值转义（顺序：先 & 后其它，避免把已转义的 &quot; 二次转义） */
export function escapeXmlAttr(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

/** 格式化工具错误为 LLM 可读、可自愈的文本 */
export function toToolError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return `工具执行失败: ${message}\n\n可能的原因：\n- 连接 ID 错误（先用 get_connected_systems 查看可用连接）\n- SAP 账号无权限或密码过期\n- 对象不存在或名称拼写错误（可先用 search_abap_objects 确认）`
}

/** 校验 connectionId 或取默认（第一个连接） */
export async function resolveConnectionId(connectionId?: string): Promise<string> {
  if (connectionId) return connectionId.toLowerCase()
  const { getConfig } = await import("../config.js")
  const first = getConfig().connections[0]
  if (!first) throw new Error("没有配置任何 SAP 连接")
  return first.id
}

/** 按名称+类型搜索对象，返回第一条结果的完整信息（含 URI）
 * opts.includeDirectRead=false 时跳过 include 通用通道直读回退（写操作专用：保持原函数组解析行为） */
export async function findObject(
  connId: string,
  objectName: string,
  objectType?: string,
  searchTypes?: string[],
  opts?: { includeDirectRead?: boolean }
): Promise<SearchResult | undefined> {
  const useDirectRead = opts?.includeDirectRead !== false
  const client = await getClient(connId)
  const typesArr: string[] = objectType ? [objectType] : searchTypes ?? ([...DEFAULT_SEARCH_TYPES] as unknown as string[])
  const pattern = objectName.toUpperCase()
  // 性能：常用类型优先并行查（与 search_abap_objects 一致），命中即返回；未命中再查剩余
  const COMMON = ["PROG", "CLAS", "INTF", "FUGR", "TABL", "DTEL", "DDLS", "DOMA", "TTYP", "MSAG", "DEVC", "FUNC"]
  const ordered = COMMON.filter((t) => typesArr.includes(t)).concat(typesArr.filter((t) => !COMMON.includes(t)))

  async function batch(ts: string[]): Promise<SearchResult | undefined> {
    const settled = await Promise.allSettled(
      ts.map(async (type) => ({ type, results: await client.searchObject(pattern, type as never, 10) })),
    )
    // 报错说真话：全部搜索都失败 → 是连接/会话异常，不是"对象不存在"
    // （此前这里把所有错误吞掉返回空 → 会话被搞坏时连标准表 SCARR 都报"未找到"，误导定位）
    if (settled.length > 0 && settled.every((r) => r.status === "rejected")) {
      const reasons = settled.map((r) => (r.status === "rejected" && r.reason instanceof Error ? r.reason : undefined))
      const hasConnErr = reasons.some((e) => e !== undefined && isConnectionError(e))
      if (hasConnErr) markConnectionUnhealthy(connId)
      const sample = reasons[0]?.message ?? "未知错误"
      throw new Error(
        `ADT 搜索服务异常（连接 ${connId}）：全部 ${settled.length} 项对象搜索均失败，` +
          `对象可能存在但搜索通道不可用（不是"对象不存在"）。已重置连接，请重试。` +
          `详情: ${sample.slice(0, 200)}`
      )
    }
    for (const r of settled) {
      if (r.status !== "fulfilled") continue
      const results = (r.value.results as never[]) ?? []
      const exact = results.find((x) => (x as SearchResult)["adtcore:name"].toUpperCase() === pattern)
      if (exact) return exact as SearchResult
      if (results.length > 0 && !objectType) return results[0] as SearchResult
    }
    return undefined
  }

  let found = await batch(ordered.slice(0, 12))
  if (!found && ordered.length > 12) found = await batch(ordered.slice(12))
  // 函数组内部程序（SAPL<FG>/L<FG>*）在 ADT 中不是独立 PROGRAM 资源，按名称直接搜永远找不到。
  // 优先走 ADT 的 include 通用通道按名直读（源码内容含 INCLUDE 声明即确认），命名再怪也能读；
  // 读不通再退回按函数组规则解析（SAPL<FG> → 主程序；L<FG><后缀> → include）。
  // include 直读是"读"路径（返回 /programs/includes 通用 URI）；写操作传 includeDirectRead=false 跳过它，
  // 保持原函数组解析行为，避免影响写/激活/改描述。
  if (!found && useDirectRead) found = await findIncludeByDirectRead(connId, objectName)
  if (!found) found = await findFunctionGroupProgram(connId, objectName)
  // 函数模块（FUGR/FF）不是顶层 ADT 对象，按名搜索/函数组规则都找不到，走 TFDIR 反查
  if (!found && objectType?.toUpperCase() === "FUGR/FF") found = await findFunctionModule(connId, objectName)
  return found
}

/** 函数组内部程序名识别：SAPL<FG> 主程序 → { fgName, isMain:true }；L<FG><后缀> include → { fgName, isMain:false } */
export function matchFunctionGroupProgram(name: string): { fgName: string; isMain: boolean } | undefined {
  const upper = (name || "").toUpperCase()
  if (upper.startsWith("SAPL") && upper.length > 4) return { fgName: upper.slice(4), isMain: true }
  if (upper.startsWith("L") && upper.length > 4) {
    const rest = upper.slice(1)
    // 经典函数组 include 后缀：TOP / UXX / <字母><2 位数字或 X>（F01、U04、I01、UXX ...）
    if (/^(TOP|[A-Z][0-9X]{2})$/i.test(rest.slice(-3))) {
      return { fgName: rest.slice(0, -3), isMain: false }
    }
  }
  return undefined
}

/** ADT 的 include 通用通道：/programs/includes/<name>/source/main。
 * 函数组 include（L<FG><后缀>）与独立 INCLUDE 程序都能经它按名直读，无需知道归属函数组。
 * 读到源码且内容含 "INCLUDE xxx ." 声明即确认是 include 程序。 */
async function findIncludeByDirectRead(connId: string, objectName: string): Promise<SearchResult | undefined> {
  const upper = (objectName || "").toUpperCase()
  if (!/^[A-Z][A-Z0-9_]{2,}$/.test(upper)) return undefined
  const client = await getClient(connId)
  const base = `/sap/bc/adt/programs/includes/${upper.toLowerCase()}`
  try {
    const src = await client.getObjectSource(`${base}/source/main`)
    if (/INCLUDE\s+[A-Z0-9_]+\s*\./i.test(String(src).slice(0, 5000))) {
      return { "adtcore:name": upper, "adtcore:type": "FUGR/I", "adtcore:uri": base } as unknown as SearchResult
    }
    return undefined
  } catch {
    return undefined
  }
}

/** 函数组内部程序解析（ADT 架构：SAPL<FG>/L<FG>* 不是独立 PROGRAM 资源）：
 *  SAPL<FG> → FUGR/F（读 /source/main 得 include 骨架，即 SE38 中 SAPL<FG> 的内容）
 *  L<FG><后缀> → FUGR/I（读 /functions/groups/<fg>/includes/<include>/source/main 得完整源码）
 *  后缀不限于标准 3 字符：如 LCORU_SFD1（函数组 CORU）也能识别——从名字里试探候选函数组名，
 *  用 FUGR 搜索验证真实存在后命中，避免误判为独立程序（搜索找不到）。
 *  找不到对应函数组返回 undefined */
export async function findFunctionGroupProgram(connId: string, objectName: string): Promise<SearchResult | undefined> {
  const upper = (objectName || "").toUpperCase()
  const candidates: { fgName: string; isMain: boolean }[] = []
  if (upper.startsWith("SAPL") && upper.length > 4) {
    candidates.push({ fgName: upper.slice(4), isMain: true })
  } else if (upper.startsWith("L") && upper.length > 4) {
    // std 启发式（后缀固定 3 字符）可能误判（如 LZAVERIFYFG01 后缀 "01"，fg 被吞成 ZAVERIFYF），
    // 因此 std 候选只作第一候选，失败后仍落入逐步缩短兜底（如 ZAVERIFYFG01 → … → ZAVERIFYFG 命中）。
    const std = matchFunctionGroupProgram(upper)
    if (std) candidates.push(std)
    const rest = upper.slice(1)
    // 优先：第一个下划线前的部分作函数组名（如 LCORU_SFD1 → CORU）
    const under = rest.indexOf("_")
    if (under > 0 && !candidates.some((c) => c.fgName === rest.slice(0, under))) {
      candidates.push({ fgName: rest.slice(0, under), isMain: false })
    }
    // 逐步缩短后缀试探（fg 从短到长），由 FUGR 搜索验证存在
    for (let cut = rest.length - 2; cut >= 1; cut--) {
      const fg = rest.slice(0, -cut)
      if (fg.length >= 3 && !candidates.some((c) => c.fgName === fg)) {
        candidates.push({ fgName: fg, isMain: false })
      }
    }
  } else {
    return undefined
  }
  const client = await getClient(connId)
  for (const c of candidates) {
    if (!c.fgName) continue
    try {
      const hits = await client.searchObject(c.fgName, "FUGR", 5)
      const fg = hits.find((h) => (h["adtcore:name"] ?? "").toUpperCase() === c.fgName)
      if (!fg) continue
      if (c.isMain) return { ...fg, "adtcore:name": upper, "adtcore:type": "FUGR/F" }
      const base = (fg["adtcore:uri"] ?? `/sap/bc/adt/functions/groups/${c.fgName.toLowerCase()}`).replace(/\/source\/main$/i, "")
      return {
        ...fg,
        "adtcore:name": upper,
        "adtcore:type": "FUGR/I",
        "adtcore:uri": `${base}/includes/${upper.toLowerCase()}`,
      }
    } catch {
      /* 继续下一个候选函数组 */
    }
  }
  return undefined
}

/** 函数模块（FUGR/FF）不是顶层 ADT 对象，按名搜索/函数组规则都找不到。
 * 用 TFDIR 反查：FUNCNAME → PNAME（函数组主程序）+ INCLUDE（函数模块所在 include 程序 L<FG>UXX），
 * 解析到函数模块自身通道（/fmodules/<name>）的 ADT URI。
 * 必须走 fmodule 通道而非函数组 include：fmodule 的 /source/main 是合成视图，
 * 服务器从这里提取接口参数（IMPORTING 等）；include 是普通 ABAP 程序，写 IMPORTING 会语法报错。 */
async function findFunctionModule(connId: string, funcName: string): Promise<SearchResult | undefined> {
  const upper = (funcName || "").toUpperCase()
  if (!/^[A-Z][A-Z0-9_]{2,}$/.test(upper)) return undefined
  const client = await getClient(connId)
  let fg = ""
  try {
    const res = await client.runQuery(
      `SELECT PNAME FROM TFDIR WHERE FUNCNAME = '${upper}'`,
      1,
      true
    )
    const row = (res?.values?.[0] ?? {}) as Record<string, string>
    fg = String(row.PNAME ?? "").trim()
  } catch {
    return undefined
  }
  if (!fg) return undefined
  // TFDIR.PNAME 返回主程序名 SAPL<FG>（如 SAPLZAIGTEST01），还原成函数组名去搜函数组基址；
  // 基址再做防御性去 /source/main（主程序源码 URI 形态），确保拼出的是 /fmodules/<fm> 通道
  fg = fg.replace(/^SAPL/i, "")
  // 验证函数组真实存在后拼 fmodule 通道 URI
  try {
    const hits = await client.searchObject(fg, "FUGR", 5)
    const fgHit = hits.find((h) => (h["adtcore:name"] ?? "").toUpperCase() === fg)
    if (!fgHit) return undefined
    const base = (fgHit["adtcore:uri"] ?? `/sap/bc/adt/functions/groups/${fg.toLowerCase()}`).replace(/\/source\/main$/i, "")
    return {
      ...fgHit,
      "adtcore:name": upper,
      "adtcore:type": "FUGR/FF",
      "adtcore:uri": `${base}/fmodules/${upper.toLowerCase()}`,
    } as unknown as SearchResult
  } catch {
    return undefined
  }
}

/**
 * 函数组 include（L<FG><后缀>）写路径（lock+PUT）不认 /programs/includes/ 通用通道——只有读路径可用，
 * 写必须用 /functions/groups/<fg>/includes/<name>。把 /programs/includes/<name> 形式的 URI 改写为函数组通道。
 * 一律走 findFunctionGroupProgram（经 FUGR 搜索验证函数组真实存在），不用未验证的同步后缀猜测——
 * 否则 LCORU_SFD1（函数组 CORU）会被猜成 coru_sf，写错地址。非函数组 include（普通 INCLUDE 程序）返回 undefined。
 */
export async function normalizeFunctionGroupIncludeUri(
  connId: string,
  adtUri: string
): Promise<string | undefined> {
  const m = /^\/sap\/bc\/adt\/programs\/includes\/([^/]+)(?:\/source\/main)?$/i.exec(adtUri)
  if (!m) return undefined
  const name = m[1].toUpperCase()
  // 仅处理函数组内部程序形态（SAPL<FG> / L<FG><后缀>），其余普通 INCLUDE 原样
  if (!name.startsWith("SAPL") && !name.startsWith("L")) return undefined
  const found = await findFunctionGroupProgram(connId, name)
  if (found && found["adtcore:type"] === "FUGR/I" && found["adtcore:uri"]) {
    return found["adtcore:uri"]
  }
  return undefined
}

/** 按名称+类型搜索对象（找不到抛错，附带搜索建议） */
export async function requireObject(
  connId: string,
  objectName: string,
  objectType?: string,
  opts?: { includeDirectRead?: boolean }
): Promise<SearchResult> {
  const obj = await findObject(connId, objectName, objectType, undefined, opts)
  if (!obj) {
    throw new Error(
      `未找到 ABAP 对象 "${objectName}"${objectType ? `（类型 ${objectType}）` : ""}。` +
        `请先用 search_abap_objects 确认对象名称和类型是否正确。`
    )
  }
  return obj
}

/** 需要读 /source/main 源码的对象类型（其余为 XML 元数据对象） */
const SOURCE_REQUIRED_TYPES = new Set([
  "CLAS/OC", "CLAS/I", "CLAS/OM", "INTF/OI", "PROG/P", "PROG/I",
  "FUGR/F", "FUGR/FF", "FUGR/I", "DDLS/DF", "DDLX/EX", "DDLA/ADF",
  "DCLS/DL", "SRVD/SRV", "SRVB/SVB", "XSLT", "TRANSFORMATIONS",
  "ENHS", "ENHC", "BADI", "BDEF", "SAMC", "SAPC",
])

/** 根据对象类型返回最佳源码 URI（移植自 abap_fs getOptimalObjectURI） */
export function getOptimalObjectURI(objectType: string | undefined, baseUri: string): string {
  if (objectType && !SOURCE_REQUIRED_TYPES.has(objectType)) {
    // XML 元数据类型（DTEL/DOMA/MSAG/TTYP/VIEW/SHLP 等）直接读对象 URI
    return baseUri
  }
  return baseUri.endsWith("/source/main") ? baseUri : `${baseUri}/source/main`
}

/** 智能读源码：优先 optimal URI，失败回退对象 URI */
export async function readSourceSmart(
  client: Awaited<ReturnType<typeof getClient>>,
  objectType: string | undefined,
  baseUri: string
): Promise<string> {
  const main = getOptimalObjectURI(objectType, baseUri)
  try {
    return await client.getObjectSource(main)
  } catch {
    if (main !== baseUri) return client.getObjectSource(baseUri)
    throw new Error(`无法读取对象源码（URI: ${baseUri}）`)
  }
}

/** 按 URI 读源码（对象主 URI 优化：class 的 source/main） */
export async function readSourceByUri(
  client: Awaited<ReturnType<typeof getClient>>,
  uri: string,
  objectType?: string
): Promise<string> {
  const main = uri.endsWith("/source/main") ? uri : `${uri}/source/main`
  try {
    return await client.getObjectSource(main)
  } catch {
    if (main !== uri) return client.getObjectSource(uri)
    throw new Error(`无法读取对象源码（URI: ${uri}）`)
  }
}

/** 按行切片 */
export function sliceLines(
  source: string,
  startLine?: number,
  lineCount?: number
): { header: string; content: string } {
  const lines = source.split("\n")
  if (startLine === undefined) {
    return { header: `完整源码，共 ${lines.length} 行`, content: source }
  }
  const start = Math.max(1, startLine)
  const count = lineCount ?? lines.length - start + 1
  const slice = lines.slice(start - 1, start - 1 + count)
  return {
    header: `第 ${start}-${start + slice.length - 1} 行（共 ${lines.length} 行）`,
    content: slice.join("\n"),
  }
}
