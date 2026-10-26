/**
 * bot session 命令实现。
 * 规则在这里执行：单对象、包允许列表、身份、传输号、差异哈希、源码哈希、只读、开发客户端。
 * propose 不调用 writeSource。本模块没有创建或释放传输请求的入口。
 */
import { join } from "node:path"
import { appendAudit, type AuditEntry } from "../auditLog.js"
import { getConfig } from "../config.js"
import { scanCodeIssues } from "../code-policy.js"
import { sanitizeErrMsg } from "../tools/shared.js"
import { selectConnectionForOpen, requireSessionConnection } from "./connection.js"
import { assertBotWriteAllowed } from "./guard.js"
import {
  applyEdit,
  assertDiffHash,
  assertIdentity,
  assertObjectName,
  assertReadOnlySql,
  assertSameObject,
  assertTableRead,
  BotGateError,
  diffSha256,
  hashEquals,
  isSyntaxError,
  normalizeSource,
  packageMatches,
  parseExpect,
  parseTransport,
  resolvePackageAllow,
  sourceSha256,
  unifiedDiff,
} from "./gates.js"
import { createSessionStore, type SessionStore } from "./store.js"
import type {
  BotCommand,
  BotResult,
  BotRuntime,
  BotSession,
  ProposalRecord,
  SyntaxMessage,
  TransportSource,
} from "./types.js"

type AuditInput = Omit<AuditEntry, "ts">

export interface BotDeps {
  store: SessionStore
  runtime: BotRuntime
  guard: (connectionId: string) => Promise<void>
  audit: (entry: AuditInput) => void
  now: () => Date
  packageCeiling: () => string[] | undefined
}

export function bindDeps(partial: Partial<BotDeps> & Pick<BotDeps, "store" | "runtime">): BotDeps {
  return {
    store: partial.store,
    runtime: partial.runtime,
    guard: partial.guard ?? assertBotWriteAllowed,
    audit: partial.audit ?? appendAudit,
    now: partial.now ?? (() => new Date()),
    packageCeiling: partial.packageCeiling ?? (() => getConfig().security?.allowedPackages),
  }
}

export async function executeBotCommand(command: BotCommand, deps: BotDeps): Promise<BotResult> {
  try {
    switch (command.command) {
      case "help": return helpResult()
      case "open": return await openSession(command, deps)
      case "read": return await readSession(command, deps)
      case "where-used": return await whereUsed(command, deps)
      case "syntax": return await syntax(command, deps)
      case "atc": return await atc(command, deps)
      case "table": return await table(command, deps)
      case "propose": return await propose(command, deps)
      case "diff": return diff(command, deps)
      case "apply": return await apply(command, deps)
      case "activate": return await activate(command, deps)
      case "status": return status(command, deps)
      case "close": return await close(command, deps)
      default: return { ok: false, command: "unknown", code: "usage", message: "未知的 session 命令" }
    }
  } catch (err) {
    return errorResult(command.command, err)
  }
}

function helpResult(): BotResult {
  return {
    ok: true,
    command: "help",
    message: "bot session 是独立的 CLI 流程。打开会话后，规则由 CLI 强制执行。本流程不能创建或释放传输请求。对象已在唯一可修改请求中时省略 --transport，apply 会挂到 ADT lock 给出的那个请求。每个会话锁定自己的连接，不修改 connections.json 的 active。",
    workflow: ["open", "read", "propose", "human reviews diff", "apply --diff-hash", "activate --diff-hash", "human releases the transport"],
    connection: "open 用 --connection <id 或 name>，或环境变量 SAPBUDDY_CONNECTION。两者都省略时用 active:true 的连接，没有 active 则用第一个。之后的命令只使用会话文件里的 connectionId，不再读 active，也不再读该环境变量。不同的 connections.json 仍用已有的 ABAP_MCP_CONFIG 指向文件，session 不写该文件。",
    commands: [
      "session open <OBJECT> [--connection ID或名称] [--type CLAS/OC] [--transport DEVK900123] [--expect SID.CLIENT/USER] [--allow-package Z*]",
      "session read <SESSION>",
      "session where-used <SESSION>",
      "session syntax <SESSION>",
      "session atc <SESSION>",
      "session table <SESSION> --table NAME [--filter WHERE] | --sql SELECT",
      "session propose <SESSION> --old-file OLD --new-file NEW | --method NAME --source-file FILE | --include --source-file FILE",
      "session diff <SESSION>",
      "session apply <SESSION> --diff-hash SHA256",
      "session activate <SESSION> --diff-hash SHA256",
      "session status <SESSION>",
      "session close <SESSION>",
    ],
  }
}

async function openSession(command: Extract<BotCommand, { command: "open" }>, deps: BotDeps): Promise<BotResult> {
  const objectName = assertObjectName(command.objectName)
  const allow = resolvePackageAllow(deps.packageCeiling(), command.allowPackages)
  const expected = command.expect ? parseExpect(command.expect) : undefined
  const selected = selectConnectionForOpen(command.connectionId)
  const live = await deps.runtime.identity(selected.id)
  if (live.connectionId.toLowerCase() !== selected.id.toLowerCase()) {
    throw new BotGateError("identity_mismatch", "运行时返回的连接与本次选择的连接不一致")
  }
  if (expected) assertIdentity(live, expected, "expect_mismatch")
  const resolved = await deps.runtime.resolveObject(selected.id, objectName, command.objectType)
  if (resolved.connectionId.toLowerCase() !== selected.id.toLowerCase()) {
    throw new BotGateError("identity_mismatch", "对象解析使用的连接与本次选择的连接不一致")
  }
  const object = resolved.object
  if (object.name.toUpperCase() !== objectName) {
    throw new BotGateError("wrong_object", `解析到的对象 ${object.name} 与请求的 ${objectName} 不一致`)
  }
  if (!object.packageName) throw new BotGateError("package_unknown", "无法确认对象所在的包，已拒绝打开会话")
  if (!packageMatches(object.packageName, allow)) {
    throw new BotGateError("package_denied", `包 ${object.packageName} 不在允许列表 ${allow.join(", ") || "(空)"} 中`)
  }
  let transport: string | undefined
  let transportSource: TransportSource | undefined
  if (object.packageName.toUpperCase() === "$TMP") {
    if (command.transport) throw new BotGateError("transport_not_allowed", "$TMP 对象不挂传输请求。本流程也不会为它创建请求。")
  } else {
    const assigned = await resolveSessionTransport(deps, selected.id, object.name, object.sourceUri, command.transport)
    transport = assigned.transport
    transportSource = assigned.source
  }
  const source = await deps.runtime.readSource(selected.id, object.sourceUri)
  const now = deps.now().toISOString()
  const session: BotSession = {
    version: 1,
    id: deps.store.createId(),
    createdAt: now,
    updatedAt: now,
    status: "open",
    connectionId: selected.id,
    connectionSelection: selected.selection,
    system: { sid: live.sid.toUpperCase(), client: live.client, user: live.user.toUpperCase() },
    object,
    transport,
    transportSource,
    packageAllow: allow,
    baselineSha256: sourceSha256(source),
  }
  deps.store.save(session)
  return {
    ok: true,
    command: "open",
    sessionId: session.id,
    sessionFile: join(deps.store.dir, `${session.id}.json`),
    connectionId: session.connectionId,
    connectionSelection: session.connectionSelection,
    system: session.system,
    object: session.object,
    transport: session.transport ?? null,
    transportSource: session.transportSource ?? null,
    packageAllow: session.packageAllow,
    baselineSha256: session.baselineSha256,
    message: selected.selection === "explicit"
      ? `会话已锁定连接 ${session.connectionId}、系统、客户端、用户和这一个对象。未修改 connections.json 的 active。尚未写入 SAP。`
      : `会话已锁定默认连接 ${session.connectionId}（未指定 --connection 或 SAPBUDDY_CONNECTION）、系统、客户端、用户和这一个对象。未修改 connections.json 的 active。尚未写入 SAP。`,
  }
}

async function readSession(command: Extract<BotCommand, { command: "read" }>, deps: BotDeps): Promise<BotResult> {
  const session = await loadBound(command, deps)
  const source = await deps.runtime.readSource(session.connectionId, session.object.sourceUri)
  const normalized = normalizeSource(source)
  const lines = normalized.length ? normalized.split("\n") : []
  const start = Math.max(1, command.startLine ?? 1)
  if (lines.length && start > lines.length) throw new BotGateError("range", `起始行 ${start} 超过总行数 ${lines.length}`)
  const count = command.lineCount && command.lineCount > 0 ? command.lineCount : lines.length
  const slice = lines.slice(start - 1, start - 1 + count)
  const sha256 = sourceSha256(source)
  return {
    ok: true,
    command: "read",
    sessionId: session.id,
    object: publicObject(session),
    sha256,
    baselineSha256: session.baselineSha256,
    stale: sha256 !== session.baselineSha256,
    startLine: start,
    endLine: slice.length ? start + slice.length - 1 : start - 1,
    totalLines: lines.length,
    complete: start === 1 && slice.length === lines.length,
    source: slice.join("\n"),
  }
}

async function whereUsed(command: Extract<BotCommand, { command: "where-used" }>, deps: BotDeps): Promise<BotResult> {
  const session = await loadBound(command, deps)
  const max = Math.min(200, Math.max(1, command.max ?? 50))
  const references = await deps.runtime.whereUsed(session.connectionId, session.object.uri, max)
  return { ok: true, command: "where-used", sessionId: session.id, object: publicObject(session), references }
}

async function syntax(command: Extract<BotCommand, { command: "syntax" }>, deps: BotDeps): Promise<BotResult> {
  const session = await loadBound(command, deps)
  const source = await deps.runtime.readSource(session.connectionId, session.object.sourceUri)
  const messages = await deps.runtime.syntaxCheck(session.connectionId, session.object.sourceUri, source)
  const errors = messages.filter((item) => isSyntaxError(item.severity))
  return {
    ok: errors.length === 0,
    command: "syntax",
    code: errors.length ? "syntax_error" : undefined,
    sessionId: session.id,
    object: publicObject(session),
    errors,
    warnings: messages.filter((item) => !isSyntaxError(item.severity)),
  }
}

async function atc(command: Extract<BotCommand, { command: "atc" }>, deps: BotDeps): Promise<BotResult> {
  const session = await loadBound(command, deps)
  const report = await deps.runtime.atc(session.connectionId, session.object.uri)
  return { ok: true, command: "atc", sessionId: session.id, object: publicObject(session), ...report }
}

async function table(command: Extract<BotCommand, { command: "table" }>, deps: BotDeps): Promise<BotResult> {
  const session = await loadBound(command, deps)
  const limit = Math.min(500, Math.max(1, command.limit ?? 50))
  if (command.sql) {
    const sql = assertReadOnlySql(command.sql)
    const result = await deps.runtime.readSql(session.connectionId, sql, limit)
    return { ok: true, command: "table", sessionId: session.id, object: publicObject(session), mode: "sql", limit, ...result }
  }
  if (!command.table) throw new BotGateError("usage", "table 需要 --table 或 --sql")
  const query = assertTableRead(command.table, command.filter)
  const result = await deps.runtime.readTable(session.connectionId, query.table, query.filter, limit)
  return { ok: true, command: "table", sessionId: session.id, object: publicObject(session), mode: "table", limit, table: query.table, ...result }
}

async function propose(command: Extract<BotCommand, { command: "propose" }>, deps: BotDeps): Promise<BotResult> {
  return deps.store.withLock(command.sessionId, async () => {
    let session: BotSession | undefined
    try {
      session = await loadBound(command, deps, { reload: true })
      assertWritableStatus(session, ["open", "proposed"])
      const source = await deps.runtime.readSource(session.connectionId, session.object.sourceUri)
      const current = sourceSha256(source)
      if (current !== session.baselineSha256) {
        throw new BotGateError("stale_source", "服务器源码已相对会话基线发生变化。请重新 open，不要在旧基线上提议修改。", { sessionId: session.id, baselineSha256: session.baselineSha256, currentSha256: current })
      }
      const updated = applyEdit(source, command.edit, session.object.type)
      const policy = scanCodeIssues(updated)
      if (policy.violations.length) {
        throw new BotGateError("code_policy", "代码规则拦截，提案未保存，SAP 未写入。", { sessionId: session.id, violations: policy.violations })
      }
      const diff = unifiedDiff(source, updated, `${session.object.name} (${session.object.type})`)
      const proposal: ProposalRecord = {
        edit: command.edit,
        diff,
        diffHash: diffSha256(diff),
        expectedSha256: sourceSha256(updated),
        createdAt: deps.now().toISOString(),
        warnings: policy.warnings,
      }
      session.proposal = proposal
      session.status = "proposed"
      session.updatedAt = deps.now().toISOString()
      deps.store.save(session)
      audit(deps, session, "proposed", "bot_session_propose", proposal.diffHash)
      return {
        ok: true,
        command: "propose",
        sessionId: session.id,
        object: publicObject(session),
        diffHash: proposal.diffHash,
        expectedSha256: proposal.expectedSha256,
        baselineSha256: session.baselineSha256,
        warnings: proposal.warnings,
        diff: proposal.diff,
        message: "提案已保存。SAP 未写入。请人工审阅完整 diff 后，用相同的 diff-hash 执行 apply。",
      }
    } catch (err) {
      auditFailure(deps, session, command.sessionId, "bot_session_propose", err)
      throw err
    }
  })
}

function diff(command: Extract<BotCommand, { command: "diff" }>, deps: BotDeps): BotResult {
  const session = loadLocal(command.sessionId, deps)
  if (session.status === "closed") throw new BotGateError("session_closed", "会话已关闭", { sessionId: session.id })
  if (!session.proposal) throw new BotGateError("no_proposal", "会话还没有提案", { sessionId: session.id })
  return {
    ok: true,
    command: "diff",
    sessionId: session.id,
    object: publicObject(session),
    diffHash: session.proposal.diffHash,
    diff: session.proposal.diff,
  }
}

async function apply(command: Extract<BotCommand, { command: "apply" }>, deps: BotDeps): Promise<BotResult> {
  const provided = assertDiffHash(command.diffHash)
  return deps.store.withLock(command.sessionId, async () => {
    let session: BotSession | undefined
    try {
      session = await loadBound(command, deps, { reload: true })
      const proposal = requireProposal(session, provided)
      assertWritableStatus(session, ["proposed"])
      await deps.guard(session.connectionId)
      const source = await deps.runtime.readSource(session.connectionId, session.object.sourceUri)
      const current = sourceSha256(source)
      if (current !== session.baselineSha256) {
        throw new BotGateError("stale_source", "服务器源码已相对打开会话时的基线发生变化，已拒绝写入。", {
          sessionId: session.id,
          diffHash: proposal.diffHash,
          baselineSha256: session.baselineSha256,
          currentSha256: current,
        })
      }
      const transport = await ensureSessionTransport(deps, session)
      const updated = applyEdit(source, proposal.edit, session.object.type)
      const diff = unifiedDiff(source, updated, `${session.object.name} (${session.object.type})`)
      const replayHash = diffSha256(diff)
      if (sourceSha256(updated) !== proposal.expectedSha256 || !hashEquals(replayHash, proposal.diffHash)) {
        throw new BotGateError("session_corrupt", "按已保存的编辑重放后，差异与提案不一致，已拒绝写入。", { sessionId: session.id, diffHash: proposal.diffHash })
      }
      const policy = scanCodeIssues(updated)
      if (policy.violations.length) {
        throw new BotGateError("code_policy", "代码规则拦截，已拒绝写入。", { sessionId: session.id, diffHash: proposal.diffHash, violations: policy.violations })
      }
      let outcome
      try {
        outcome = await deps.runtime.writeSource(session.connectionId, session.object.sourceUri, normalizeSource(updated) + "\n", transport)
      } catch (err) {
        if (err instanceof BotGateError) {
          throw new BotGateError(err.code, err.message, { sessionId: session.id, diffHash: proposal.diffHash, ...(err.details ?? {}) }, err.auditEvent)
        }
        throw new BotGateError("write_failed", `写入失败，不能视为成功：${sanitizeErrMsg(err)}`, { sessionId: session.id, diffHash: proposal.diffHash }, "failed")
      }
      if (!outcome.written) {
        throw new BotGateError("write_failed", "服务器未确认写入。", { sessionId: session.id, diffHash: proposal.diffHash }, "failed")
      }
      const verified = await verifyWritten(deps, session, proposal.expectedSha256, outcome.unlockError)
      session.updatedAt = deps.now().toISOString()
      session.status = verified.ok ? "applied" : "apply_unverified"
      if (verified.ok) session.appliedAt = session.updatedAt
      deps.store.save(session)
      audit(deps, session, verified.ok ? "applied" : "failed", "bot_session_apply", proposal.diffHash, verified.ok ? undefined : verified.code)
      return {
        ok: verified.ok,
        command: "apply",
        code: verified.ok ? undefined : verified.code,
        message: verified.ok ? "写入已核对。对象仍需 activate 才会生效。传输请求需由人工释放。" : verified.message,
        sessionId: session.id,
        object: publicObject(session),
        diffHash: proposal.diffHash,
        transport: transport ?? null,
        ...verified.body,
      }
    } catch (err) {
      auditFailure(deps, session, command.sessionId, "bot_session_apply", err, provided)
      throw err
    }
  })
}

async function activate(command: Extract<BotCommand, { command: "activate" }>, deps: BotDeps): Promise<BotResult> {
  const provided = assertDiffHash(command.diffHash)
  return deps.store.withLock(command.sessionId, async () => {
    let session: BotSession | undefined
    try {
      session = await loadBound(command, deps, { reload: true })
      const proposal = requireProposal(session, provided)
      if (session.status !== "applied" && session.status !== "activate_unverified") {
        throw new BotGateError("not_applied", "只有已经核对写入成功的会话才能激活。", { sessionId: session.id, status: session.status })
      }
      await deps.guard(session.connectionId)
      const before = await readInactiveOrActive(deps, session)
      if (sourceSha256(before) !== proposal.expectedSha256) {
        throw new BotGateError("stale_source", "激活前源码与提案结果不一致，已拒绝激活。", { sessionId: session.id, diffHash: proposal.diffHash })
      }
      await ensureSessionTransport(deps, session)
      const beforeSyntax = await deps.runtime.syntaxCheck(session.connectionId, session.object.sourceUri, before)
      const beforeErrors = beforeSyntax.filter((item) => isSyntaxError(item.severity))
      if (beforeErrors.length) {
        throw new BotGateError("syntax_error", "激活前语法检查未通过，未执行激活。", { sessionId: session.id, diffHash: proposal.diffHash, errors: beforeErrors })
      }
      const outcome = await deps.runtime.activate(session.connectionId, session.object)
      let active = ""
      let activeError = ""
      try {
        active = await deps.runtime.readSource(session.connectionId, session.object.sourceUri, "active")
      } catch (err) {
        activeError = sanitizeErrMsg(err)
      }
      let inactive: Array<{ type: string; name: string }> = []
      let inactiveError = ""
      try {
        inactive = await deps.runtime.inactiveObjects(session.connectionId)
      } catch (err) {
        inactiveError = sanitizeErrMsg(err)
      }
      const activeMatch = !activeError && sourceSha256(active) === proposal.expectedSha256
      const stillInactive = inactive.some((item) => item.name.toUpperCase() === session!.object.name.toUpperCase())
      const problems: string[] = []
      if (!outcome.success) problems.push("activate")
      if (!activeMatch) problems.push("active_source")
      if (stillInactive) problems.push("inactive")
      if (inactiveError) problems.push("inactive_unknown")
      const ok = problems.length === 0
      session.updatedAt = deps.now().toISOString()
      session.status = ok ? "activated" : "activate_unverified"
      if (ok) session.activatedAt = session.updatedAt
      deps.store.save(session)
      audit(deps, session, ok ? "activated" : "failed", "bot_session_activate", proposal.diffHash, ok ? undefined : problems.join(","))
      return {
        ok,
        command: "activate",
        code: ok ? undefined : (problems.length > 1 ? "partial" : problems[0]),
        message: ok ? "激活已核对。释放传输请求不在本流程中，请人工处理。" : "激活未完全核对，不能视为成功。",
        sessionId: session.id,
        object: publicObject(session),
        diffHash: proposal.diffHash,
        verification: outcome.verification ?? null,
        messages: outcome.messages,
        activeSourceMatch: activeMatch,
        activeSourceError: activeError || undefined,
        inactive,
        inactiveError: inactiveError || undefined,
        stillInactive,
      }
    } catch (err) {
      auditFailure(deps, session, command.sessionId, "bot_session_activate", err, provided)
      throw err
    }
  })
}

function status(command: Extract<BotCommand, { command: "status" }>, deps: BotDeps): BotResult {
  const session = loadLocal(command.sessionId, deps)
  return {
    ok: true,
    command: "status",
    sessionId: session.id,
    status: session.status,
    connectionId: session.connectionId,
    connectionSelection: session.connectionSelection ?? null,
    system: session.system,
    object: publicObject(session),
    transport: session.transport ?? null,
    transportSource: session.transportSource ?? null,
    packageAllow: session.packageAllow,
    baselineSha256: session.baselineSha256,
    diffHash: session.proposal?.diffHash ?? null,
    expectedSha256: session.proposal?.expectedSha256 ?? null,
    updatedAt: session.updatedAt,
  }
}

async function close(command: Extract<BotCommand, { command: "close" }>, deps: BotDeps): Promise<BotResult> {
  return deps.store.withLock(command.sessionId, async () => {
    const session = loadLocal(command.sessionId, deps)
    session.status = "closed"
    session.updatedAt = deps.now().toISOString()
    deps.store.save(session)
    return { ok: true, command: "close", sessionId: session.id, status: "closed" }
  })
}

async function loadBound(
  command: { sessionId: string; objectName?: string; objectType?: string },
  deps: BotDeps,
  opts?: { reload?: boolean },
): Promise<BotSession> {
  const session = loadLocal(command.sessionId, deps)
  if (session.status === "closed") throw new BotGateError("session_closed", "会话已关闭", { sessionId: session.id })
  assertSameObject(session.object.name, session.object.type, command.objectName, command.objectType)
  if (!packageMatches(session.object.packageName, session.packageAllow)) {
    throw new BotGateError("package_denied", `对象包 ${session.object.packageName} 不在会话允许列表中`, { sessionId: session.id })
  }
  const live = await deps.runtime.identity(session.connectionId)
  if (live.connectionId.toLowerCase() !== session.connectionId.toLowerCase()) {
    throw new BotGateError("identity_mismatch", "运行时使用的连接与会话锁定的连接不一致", { sessionId: session.id })
  }
  assertIdentity(live, session.system, "identity_mismatch")
  return opts?.reload ? deps.store.load(session.id) : session
}

function loadLocal(sessionId: string, deps: BotDeps): BotSession {
  const session = deps.store.load(sessionId)
  requireSessionConnection(session.connectionId)
  return session
}

function assertWritableStatus(session: BotSession, allowed: BotSession["status"][]): void {
  if (!allowed.includes(session.status)) {
    throw new BotGateError("status", `会话状态 ${session.status} 不能执行此命令`, { sessionId: session.id, status: session.status })
  }
}

function requireProposal(session: BotSession, provided: string): ProposalRecord {
  const proposal = session.proposal
  if (!proposal?.diff || !proposal.diffHash || !proposal.edit) {
    throw new BotGateError("no_proposal", "会话没有可应用的提案", { sessionId: session.id })
  }
  if (!hashEquals(diffSha256(proposal.diff), proposal.diffHash)) {
    throw new BotGateError("session_corrupt", "会话中的 diff 与其哈希不一致", { sessionId: session.id })
  }
  if (!hashEquals(provided, proposal.diffHash)) {
    throw new BotGateError("hash_mismatch", "传入的 diff-hash 与已保存提案不一致，已拒绝写入。", { sessionId: session.id, expectedDiffHash: proposal.diffHash })
  }
  return proposal
}

async function ensureSessionTransport(deps: BotDeps, session: BotSession): Promise<string | undefined> {
  if (session.object.packageName.toUpperCase() === "$TMP") return undefined
  const assigned = await resolveSessionTransport(
    deps,
    session.connectionId,
    session.object.name,
    session.object.sourceUri,
    session.transport,
  )
  if (session.transport && assigned.transport !== session.transport) {
    throw new BotGateError(
      "transport_conflict",
      `对象当前应挂接 ${assigned.transport}，与会话记录的 ${session.transport} 不一致，已拒绝。`,
      { sessionId: session.id, transports: [assigned.transport, session.transport] },
    )
  }
  return assigned.transport
}

/**
 * 对象已在一个可修改请求中时直接用它，不要求 --transport。
 * ADT lock 的 CORRNR 优先于 E071。E071 出现多个状态 D 且 lock 没有唯一结果时拒绝，并列出全部请求。
 * 只有对象不在任何可修改请求中时，才要求调用方传入一个已存在的 D 请求。不创建、不释放。
 */
async function resolveSessionTransport(
  deps: BotDeps,
  connectionId: string,
  objectName: string,
  sourceUri: string,
  requested: string | undefined,
): Promise<{ transport: string; source: TransportSource }> {
  const requestedNorm = requested ? parseTransport(requested) : undefined
  const assignment = await deps.runtime.assignedTransport(connectionId, objectName, sourceUri)
  const lockRaw = assignment.lockRequest.trim()
  const lock = lockRaw ? parseTransport(lockRaw) : ""
  if (lock) {
    const status = await deps.runtime.transportStatus(connectionId, lock)
    if (!status.found) {
      throw new BotGateError("transport_unknown", `ADT lock 返回的请求 ${lock} 在 E070 中不存在。本流程不会创建请求。`)
    }
    if (status.status === "D") {
      if (requestedNorm && requestedNorm !== lock) {
        throw new BotGateError(
          "transport_conflict",
          `对象当前在可修改请求 ${lock}（ADT lock）。传入的 ${requestedNorm} 与之不同，已拒绝。`,
          { transports: [lock, requestedNorm] },
        )
      }
      return { transport: lock, source: "lock" }
    }
  }
  const recorded = [...new Set(assignment.recorded
    .map((item) => ({ number: item.number.trim().toUpperCase(), status: item.status.trim().toUpperCase() }))
    .filter((item) => item.status === "D" && item.number)
    .map((item) => parseTransport(item.number)))]
  if (recorded.length > 1) {
    throw new BotGateError(
      "transport_ambiguous",
      `对象同时出现在多个可修改请求中：${recorded.join(", ")}。ADT lock 没有给出唯一请求，已拒绝。请先在 SAP 中整理这些请求。本流程不会从中挑选，也不会创建新请求。`,
      { transports: recorded },
    )
  }
  if (recorded.length === 1) {
    const only = recorded[0]
    if (requestedNorm && requestedNorm !== only) {
      throw new BotGateError(
        "transport_conflict",
        `对象已在可修改请求 ${only}。传入的 ${requestedNorm} 与之不同，已拒绝。`,
        { transports: [only, requestedNorm] },
      )
    }
    return { transport: only, source: "recorded" }
  }
  if (!requestedNorm) {
    throw new BotGateError(
      "transport_required",
      "对象不在任何可修改请求中。打开会话时请用 --transport 指定一个已存在且状态为 D 的请求。本流程不会创建或释放请求。",
    )
  }
  await assertModifiable(deps, connectionId, requestedNorm)
  return { transport: requestedNorm, source: "explicit" }
}

async function assertModifiable(deps: BotDeps, connectionId: string, transport: string): Promise<void> {
  const status = await deps.runtime.transportStatus(connectionId, transport)
  if (!status.found) throw new BotGateError("transport_not_found", `传输请求 ${transport} 不存在。本流程不会创建请求。`)
  if (status.status !== "D") {
    throw new BotGateError("transport_not_modifiable", `传输请求 ${transport} 的状态是 ${status.status || "未知"}，只有 D（可修改）可以挂接。`)
  }
}

async function verifyWritten(
  deps: BotDeps,
  session: BotSession,
  expectedSha256: string,
  unlockError?: string,
): Promise<{ ok: boolean; code?: string; message?: string; body: Record<string, unknown> }> {
  const problems: string[] = []
  let readbackSha = ""
  let readbackError = ""
  try {
    const readback = await deps.runtime.readSource(session.connectionId, session.object.sourceUri)
    readbackSha = sourceSha256(readback)
  } catch (err) {
    readbackError = sanitizeErrMsg(err)
    problems.push("readback_unknown")
  }
  if (!readbackError && readbackSha !== expectedSha256) problems.push("readback_mismatch")
  let messages: SyntaxMessage[] = []
  let syntaxError = ""
  try {
    const source = await deps.runtime.readSource(session.connectionId, session.object.sourceUri)
    messages = await deps.runtime.syntaxCheck(session.connectionId, session.object.sourceUri, source)
  } catch (err) {
    syntaxError = sanitizeErrMsg(err)
    problems.push("syntax_unknown")
  }
  const errors = messages.filter((item) => isSyntaxError(item.severity))
  if (errors.length) problems.push("syntax_error")
  let inactive: Array<{ type: string; name: string }> = []
  let inactiveError = ""
  try {
    inactive = await deps.runtime.inactiveObjects(session.connectionId)
  } catch (err) {
    inactiveError = sanitizeErrMsg(err)
    problems.push("inactive_unknown")
  }
  if (unlockError) problems.push("unlock_failed")
  const ok = problems.length === 0
  return {
    ok,
    code: ok ? undefined : (problems.length > 1 ? "partial" : problems[0]),
    message: ok ? undefined : `写入后的核对未全部通过：${problems.join(", ")}`,
    body: {
      readback: readbackError ? "unknown" : (readbackSha === expectedSha256 ? "match" : "mismatch"),
      readbackSha256: readbackSha || undefined,
      expectedSha256,
      readbackError: readbackError || undefined,
      syntax: { errors, warnings: messages.filter((item) => !isSyntaxError(item.severity)), error: syntaxError || undefined },
      inactive,
      inactiveError: inactiveError || undefined,
      unlockError: unlockError || undefined,
    },
  }
}

async function readInactiveOrActive(deps: BotDeps, session: BotSession): Promise<string> {
  try {
    return await deps.runtime.readSource(session.connectionId, session.object.sourceUri, "inactive")
  } catch {
    return deps.runtime.readSource(session.connectionId, session.object.sourceUri, "active")
  }
}

function publicObject(session: BotSession): { name: string; type: string; package: string } {
  return { name: session.object.name, type: session.object.type, package: session.object.packageName }
}

function audit(deps: BotDeps, session: BotSession, event: AuditInput["event"], tool: string, diffHash?: string, reason?: string): void {
  deps.audit({
    event,
    tool,
    objects: [session.object.name],
    connectionId: session.connectionId,
    sessionId: session.id,
    user: session.system.user,
    diffHash,
    sid: session.system.sid,
    client: session.system.client,
    reason,
  })
}

function auditFailure(deps: BotDeps, session: BotSession | undefined, sessionId: string, tool: string, err: unknown, diffHash?: string): void {
  const gate = err instanceof BotGateError ? err : undefined
  const hash = typeof gate?.details?.diffHash === "string" ? gate.details.diffHash : diffHash
  deps.audit({
    event: gate?.auditEvent ?? "blocked",
    tool,
    objects: session ? [session.object.name] : [],
    connectionId: session?.connectionId,
    sessionId: session?.id ?? sessionId,
    user: session?.system.user,
    diffHash: hash,
    sid: session?.system.sid,
    client: session?.system.client,
    reason: `${gate?.code ?? "error"}:${sanitizeErrMsg(err, 180)}`,
  })
}

function errorResult(command: string, err: unknown): BotResult {
  if (err instanceof BotGateError) {
    return { ok: false, command, code: err.code, message: err.message, ...(err.details ?? {}) }
  }
  return { ok: false, command, code: "error", message: sanitizeErrMsg(err, 500) }
}
