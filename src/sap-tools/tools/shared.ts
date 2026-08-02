/** 工具公共辅助：搜索结果格式化、错误处理 */
import { z } from "zod"
import { SearchResult } from "abap-adt-api"
import { getClient } from "../adtManager.js"

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

/** 按名称+类型搜索对象，返回第一条结果的完整信息（含 URI） */
export async function findObject(
  connId: string,
  objectName: string,
  objectType?: string,
  searchTypes?: string[]
): Promise<SearchResult | undefined> {
  const client = await getClient(connId)
  const types = objectType ? [objectType] : searchTypes ?? DEFAULT_SEARCH_TYPES
  const pattern = objectName.toUpperCase()
  // 性能：常用类型优先并行查（与 search_abap_objects 一致），命中即返回；未命中再查剩余
  const COMMON = ["PROG", "CLAS", "INTF", "FUGR", "TABL", "DTEL", "DDLS", "DOMA", "TTYP", "MSAG", "DEVC", "FUNC"]
  const ordered = COMMON.filter((t) => types.includes(t)).concat(types.filter((t) => !COMMON.includes(t)))

  async function batch(ts: string[]): Promise<SearchResult | undefined> {
    const settled = await Promise.allSettled(
      ts.map(async (type) => {
        try {
          return { type, results: await client.searchObject(pattern, type as never, 10) }
        } catch {
          return { type, results: [] as never[] }
        }
      }),
    )
    for (const r of settled) {
      const results = r.status === "fulfilled" ? (r.value.results as never[]) : []
      const exact = results.find((x) => (x as SearchResult)["adtcore:name"].toUpperCase() === pattern)
      if (exact) return exact as SearchResult
      if (results.length > 0 && !objectType) return results[0] as SearchResult
    }
    return undefined
  }

  let found = await batch(ordered.slice(0, 12))
  if (!found && ordered.length > 12) found = await batch(ordered.slice(12))
  return found
}

/** 按名称+类型搜索对象（找不到抛错，附带搜索建议） */
export async function requireObject(
  connId: string,
  objectName: string,
  objectType?: string
): Promise<SearchResult> {
  const obj = await findObject(connId, objectName, objectType)
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
