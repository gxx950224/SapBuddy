/** 生产环境的 ADT 端口。只读查询与一次 lock/写/unlock，不创建、不释放传输请求。
 * 连接只认调用方传入的会话 connectionId，不读、不改全局 active。 */
import { session_types, type ActivationResult } from "abap-adt-api"
import { getClient, getConnection } from "../adtManager.js"
import { requireSessionConnection } from "./connection.js"
import { assertBotWriteAllowed } from "./guard.js"
import { sidFromCookies, BotGateError, normalizeSource } from "./gates.js"
import { mergeActivationResults, verifyActivation } from "../tools/activationResult.js"
import { findObject, getOptimalObjectURI, sanitizeErrMsg } from "../tools/shared.js"
import type { AbapObjectRef, ActivateOutcome, BotRuntime, SyntaxMessage, TableResult, TransportAssignment, TransportRef, WriteOutcome } from "./types.js"

async function bind(connectionId?: string): Promise<{ id: string; client: Awaited<ReturnType<typeof getClient>> }> {
  const conf = requireSessionConnection(connectionId ?? "")
  return { id: conf.id, client: await getClient(conf.id) }
}

function rowsOf(result: { values?: Array<Record<string, unknown>>; columns?: Array<{ name: string }> } | undefined): TableResult {
  const columns = (result?.columns ?? []).map((column) => column.name)
  const rows = (result?.values ?? []) as Array<Record<string, unknown>>
  return { columns, rows }
}

async function readSid(client: Awaited<ReturnType<typeof getClient>>): Promise<string> {
  const http = client.httpClient
  const fromCookie = sidFromCookies(typeof http?.ascookies === "function" ? http.ascookies() : "")
  if (fromCookie) return fromCookie
  try {
    const result = await client.runQuery("SELECT SYSNAM FROM TMSCSYS WHERE SYSTYP = 'SAP'", 20, true)
    const ids = [...new Set((result?.values ?? [])
      .map((row) => String((row as Record<string, unknown>).SYSNAM ?? "").trim().toUpperCase())
      .filter((sid) => /^[A-Z0-9]{3}$/.test(sid)))]
    if (ids.length === 1) return ids[0]
  } catch {
    /* 传输域查询失败时继续 fail-closed */
  }
  throw new BotGateError(
    "identity_unconfirmed",
    "无法从登录 cookie SAP_SESSIONID_<SID>_<实例> 或唯一的传输域系统确认 SID，已拒绝打开会话。",
  )
}

async function sourceUriOf(client: Awaited<ReturnType<typeof getClient>>, objectType: string, uri: string): Promise<string> {
  const main = getOptimalObjectURI(objectType, uri)
  try {
    await client.getObjectSource(main)
    return main
  } catch (err) {
    if (main !== uri) {
      try {
        await client.getObjectSource(uri)
        return uri
      } catch { /* 下面统一报错 */ }
    }
    throw new BotGateError("source_unavailable", `无法读取对象源码：${sanitizeErrMsg(err)}`)
  }
}

/** ADT lock().CORRNR 是对象当前所在请求。lock 失败时才退到 transportInfo 的 LOCKS，不用 TRANSPORTS 候选列表。 */
async function lockRequestOf(client: Awaited<ReturnType<typeof getClient>>, uri: string): Promise<string> {
  const previous = client.stateful
  client.stateful = session_types.stateful
  try {
    let handle = ""
    try {
      const lock = await client.lock(uri)
      handle = String(lock.LOCK_HANDLE ?? "")
      return String(lock.CORRNR ?? "").trim().toUpperCase()
    } catch (lockErr) {
      try {
        const info = await client.transportInfo(uri)
        const fromLocks = String(info?.LOCKS?.HEADER?.TRKORR ?? "").trim().toUpperCase()
        if (fromLocks) return fromLocks
      } catch { /* 下面统一报 lock 失败 */ }
      throw new BotGateError("transport_unknown", `无法从 ADT lock 确认对象所在请求：${sanitizeErrMsg(lockErr)}`)
    } finally {
      if (handle) {
        try {
          await client.unLock(uri, handle)
        } catch (err) {
          throw new BotGateError(
            "lock_held",
            `读取 ADT lock 后解锁失败：${sanitizeErrMsg(err)}。对象可能仍被锁住，请在 SAP 中解锁后再打开会话。`,
          )
        }
      }
    }
  } finally {
    client.stateful = previous
  }
}

/** E071 里真实出现过的请求。transportchecks 的 TRANSPORTS 是可选请求，不能当成对象已经在其中。 */
async function recordedTransports(client: Awaited<ReturnType<typeof getClient>>, objectName: string): Promise<TransportRef[]> {
  const name = objectName.replace(/'/g, "''")
  let listed: string[]
  try {
    const result = await client.runQuery(`SELECT DISTINCT TRKORR FROM E071 WHERE OBJ_NAME = '${name}'`, 50, true)
    listed = [...new Set((result?.values ?? [])
      .map((row) => String((row as Record<string, unknown>).TRKORR ?? "").trim().toUpperCase())
      .filter(Boolean))]
  } catch (err) {
    throw new BotGateError("transport_unknown", `无法读取对象 ${objectName} 的传输记录：${sanitizeErrMsg(err)}`)
  }
  if (!listed.length) return []
  try {
    const statusQuery = `SELECT TRKORR, TRSTATUS FROM E070 WHERE TRKORR IN (${listed.map((number) => `'${number.replace(/'/g, "''")}'`).join(",")})`
    const status = await client.runQuery(statusQuery, 50, true)
    return (status?.values ?? []).map((row) => {
      const record = row as Record<string, unknown>
      return { number: String(record.TRKORR ?? "").toUpperCase(), status: String(record.TRSTATUS ?? "").toUpperCase() }
    }).filter((item) => item.number)
  } catch (err) {
    throw new BotGateError("transport_unknown", `无法确认对象 ${objectName} 的请求状态：${sanitizeErrMsg(err)}`)
  }
}

export const productionRuntime: BotRuntime = {
  async identity(connectionId) {
    const { id, client } = await bind(connectionId)
    const conf = getConnection(id)
    const sid = await readSid(client)
    const user = String(client.username || conf.username).toUpperCase()
    const mandt = String(conf.client)
    if (client.client && String(client.client) !== mandt) {
      throw new BotGateError("identity_unconfirmed", `登录客户端 ${client.client} 与连接配置 ${mandt} 不一致`)
    }
    return { connectionId: id, sid, client: mandt, user }
  },

  async resolveObject(connectionId, name, type) {
    const { id, client } = await bind(connectionId)
    const found = await findObject(id, name, type, undefined, { includeDirectRead: false })
    if (!found?.["adtcore:uri"]) {
      throw new BotGateError("not_found", `未找到对象 ${name}${type ? `（${type}）` : ""}。会话不会改去搜索其他系统。`)
    }
    let packageName = String(found["adtcore:packageName"] ?? "").toUpperCase()
    if (!packageName) {
      const structure = await client.objectStructure(found["adtcore:uri"])
      const meta = structure.metaData as unknown as Record<string, unknown>
      packageName = String(meta["adtcore:packageName"] ?? "").toUpperCase()
    }
    const objectType = String(found["adtcore:type"] ?? type ?? "")
    const object: AbapObjectRef = {
      name: String(found["adtcore:name"]).toUpperCase(),
      type: objectType,
      uri: found["adtcore:uri"],
      sourceUri: await sourceUriOf(client, objectType, found["adtcore:uri"]),
      packageName,
    }
    return { connectionId: id, object }
  },

  async readSource(connectionId, sourceUri, version) {
    const { client } = await bind(connectionId)
    return client.getObjectSource(sourceUri, version ? { version } : undefined)
  },

  async whereUsed(connectionId, uri, max) {
    const { client } = await bind(connectionId)
    const refs = await client.usageReferences(uri)
    return (refs ?? []).slice(0, max).map((ref) => ({
      name: String(ref["adtcore:name"] ?? ref.objectIdentifier ?? ""),
      type: String(ref["adtcore:type"] ?? ""),
      packageName: ref.packageRef?.["adtcore:name"],
      usage: ref.usageInformation || undefined,
    }))
  },

  async syntaxCheck(connectionId, sourceUri, source) {
    const { client } = await bind(connectionId)
    const checks = await client.syntaxCheck(sourceUri, sourceUri, source)
    return (checks ?? []).map((item): SyntaxMessage => ({ severity: item.severity, line: item.line, text: item.text }))
  },

  async atc(connectionId, uri) {
    try {
      const { client } = await bind(connectionId)
      const customizing = await client.atcCustomizing()
      const variantProp = customizing.properties?.find((property: { name: string }) => property.name === "systemCheckVariant")
      let variant = "DEFAULT"
      if (variantProp?.value) variant = await client.atcCheckVariant(String(variantProp.value))
      const run = await client.createAtcRun(variant, uri, 100)
      if (!run?.id) return { available: true, variant, findings: [] }
      const worklist = await client.atcWorklists(run.id) as unknown as {
        objectSets?: Array<{ findings?: Array<{ priority?: number; messageTitle?: string; checkTitle?: string; location?: { range?: { start?: { line?: number } } } }> }>
      }
      const findings = (worklist?.objectSets ?? []).flatMap((set) => set.findings ?? []).map((finding) => ({
        priority: finding.priority,
        line: finding.location?.range?.start?.line,
        message: finding.messageTitle ?? finding.checkTitle ?? "",
      }))
      return { available: true, variant, findings }
    } catch (err) {
      return { available: false, reason: sanitizeErrMsg(err) }
    }
  },

  async readTable(connectionId, table, filter, limit) {
    const { client } = await bind(connectionId)
    const sql = filter ? `SELECT * FROM ${table} WHERE ${filter}` : ""
    return rowsOf(await client.tableContents(table, limit, true, sql))
  },

  async readSql(connectionId, sql, limit) {
    const { client } = await bind(connectionId)
    return rowsOf(await client.runQuery(sql, limit, true))
  },

  async transportStatus(connectionId, transport) {
    const { client } = await bind(connectionId)
    try {
      const result = await client.runQuery(`SELECT TRKORR, TRSTATUS FROM E070 WHERE TRKORR = '${transport}'`, 5, true)
      const row = (result?.values?.[0] ?? {}) as Record<string, unknown>
      const number = String(row.TRKORR ?? "").trim()
      if (!number) return { found: false, status: "" }
      return { found: true, status: String(row.TRSTATUS ?? "").trim().toUpperCase() }
    } catch (err) {
      throw new BotGateError("transport_unknown", `无法确认传输请求 ${transport}：${sanitizeErrMsg(err)}`)
    }
  },

  async assignedTransport(connectionId, objectName, sourceUri): Promise<TransportAssignment> {
    const { client } = await bind(connectionId)
    const lockRequest = await lockRequestOf(client, sourceUri)
    try {
      return { lockRequest, recorded: await recordedTransports(client, objectName) }
    } catch (err) {
      if (lockRequest) return { lockRequest, recorded: [] }
      throw err instanceof BotGateError
        ? err
        : new BotGateError("transport_unknown", `无法确认对象 ${objectName} 所在的传输请求：${sanitizeErrMsg(err)}`)
    }
  },

  async writeSource(connectionId, sourceUri, source, transport): Promise<WriteOutcome> {
    await assertBotWriteAllowed(connectionId)
    const { client } = await bind(connectionId)
    const previous = client.stateful
    client.stateful = session_types.stateful
    let written = false
    let unlockError: string | undefined
    let writeError: unknown
    try {
      const lock = await client.lock(sourceUri)
      try {
        await client.setObjectSource(sourceUri, source.endsWith("\n") ? source : `${normalizeSource(source)}\n`, lock.LOCK_HANDLE, transport)
        written = true
      } catch (err) {
        writeError = err
      } finally {
        try {
          await client.unLock(sourceUri, lock.LOCK_HANDLE)
        } catch (err) {
          unlockError = sanitizeErrMsg(err)
        }
      }
    } finally {
      client.stateful = previous
    }
    if (writeError) {
      const detail = sanitizeErrMsg(writeError)
      throw new BotGateError("write_failed", unlockError ? `${detail}；解锁也失败：${unlockError}` : detail, undefined, "failed")
    }
    return { written, unlockError }
  },

  async activate(connectionId, object): Promise<ActivateOutcome> {
    await assertBotWriteAllowed(connectionId)
    const { client } = await bind(connectionId)
    const report = await verifyActivation(client, { "adtcore:uri": object.uri, "adtcore:type": object.type }, async () => {
      try {
        const raw = await client.activate(object.name, object.uri, undefined, true)
        return mergeActivationResults([raw], [object.name])
      } catch (err) {
        const failed: ActivationResult = {
          success: false,
          inactive: [],
          messages: [{ objDescr: "", type: "E", line: 0, href: "", forceSupported: false, shortText: sanitizeErrMsg(err) }],
        }
        return mergeActivationResults([failed], [object.name])
      }
    })
    const verified = report.verification === "matched" || report.verification === "not_applicable"
    return {
      success: report.success === true && verified,
      verification: report.verification,
      messages: (report.messages ?? []).map((message) => `[${message.type}] ${message.shortText}`),
    }
  },

  async inactiveObjects(connectionId) {
    const { client } = await bind(connectionId)
    const records = await client.inactiveObjects()
    return (records ?? []).map((record) => ({
      type: String(record.object?.["adtcore:type"] ?? ""),
      name: String(record.object?.["adtcore:name"] ?? ""),
    })).filter((item) => item.name)
  },
}
