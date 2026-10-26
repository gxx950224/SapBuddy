/** 纯门禁：不访问 SAP、不读配置。会话命令在写之前全部走这里。 */
import { createHash } from "node:crypto"
import { findAndReplace } from "../tools/replaceLogic.js"
import type { SourceEdit, SystemIdentity } from "./types.js"

export class BotGateError extends Error {
  readonly code: string
  readonly details?: Record<string, unknown>
  /** blocked = 写入尚未发生；failed = 写入已尝试，结果不能当成成功 */
  readonly auditEvent: "blocked" | "failed"

  constructor(code: string, message: string, details?: Record<string, unknown>, auditEvent: "blocked" | "failed" = "blocked") {
    super(message)
    this.name = "BotGateError"
    this.code = code
    this.details = details
    this.auditEvent = auditEvent
  }
}

export const DEFAULT_PACKAGE_ALLOW = ["Z*", "Y*"]
export const INCLUDE_TYPES = new Set(["PROG/I", "CLAS/I", "FUGR/I"])

const EXPECT_RE = /^([A-Z0-9]{3})\.(\d{3})\/([A-Z0-9_#]{1,12})$/i
const TRANSPORT_RE = /^[A-Z0-9]{3}K\d{6}$/
const OBJECT_NAME_RE = /^[A-Z0-9_/]{1,40}$/i
const TABLE_NAME_RE = /^[A-Z][A-Z0-9_/]{1,29}$/
const DML_RE = /\b(INSERT|UPDATE|DELETE|DROP|CREATE|TRUNCATE|ALTER|MERGE|GRANT|REVOKE|MODIFY)\b/i
const SESSION_ID_RE = /^bs[a-f0-9]{24}$/

export function assertSessionId(id: string): string {
  const value = String(id ?? "").trim()
  if (!SESSION_ID_RE.test(value)) throw new BotGateError("session_id", "会话 ID 无效")
  return value
}

export function assertObjectName(name: string): string {
  const value = String(name ?? "").trim().toUpperCase()
  if (!OBJECT_NAME_RE.test(value)) throw new BotGateError("object_name", "对象名无效。只接受字母、数字、下划线和命名空间斜杠。")
  return value
}

/** 只认登录 cookie 名 SAP_SESSIONID_<SID>_<实例号>。多个 SID 同时出现时不猜测。 */
export function sidFromCookies(cookies: string): string | undefined {
  const found = new Set<string>()
  for (const part of String(cookies ?? "").split(/;\s*/)) {
    const name = (part.split("=", 1)[0] ?? "").trim()
    const match = /^SAP_SESSIONID_([A-Z0-9]{3})(?:_\d{2,3})?$/i.exec(name)
    if (match) found.add(match[1].toUpperCase())
  }
  if (found.size !== 1) return undefined
  return [...found][0]
}

export function normalizeSource(source: string): string {
  return String(source ?? "").replace(/\r\n/g, "\n").replace(/\n+$/, "")
}

/** 与激活核对同一规则：只统一换行，不改动字面量内部空白。 */
export function sourceSha256(source: string): string {
  return createHash("sha256").update(normalizeSource(source)).digest("hex")
}

export function diffSha256(diff: string): string {
  const canonical = String(diff ?? "").replace(/\r\n/g, "\n").replace(/\n*$/, "\n")
  return createHash("sha256").update(canonical).digest("hex")
}

export function parseExpect(raw: string): SystemIdentity & { text: string } {
  const match = EXPECT_RE.exec(String(raw ?? "").trim())
  if (!match) {
    throw new BotGateError("expect_format", "expect 格式应为 SID.CLIENT/USER，例如 DEV.100/DEVELOPER")
  }
  const sid = match[1].toUpperCase()
  const client = match[2]
  const user = match[3].toUpperCase()
  return { sid, client, user, text: `${sid}.${client}/${user}` }
}

export function assertIdentity(actual: SystemIdentity, expected: SystemIdentity, code: "expect_mismatch" | "identity_mismatch"): void {
  const same = actual.sid.toUpperCase() === expected.sid.toUpperCase()
    && actual.client === expected.client
    && actual.user.toUpperCase() === expected.user.toUpperCase()
  if (same) return
  throw new BotGateError(
    code,
    `系统身份 ${actual.sid}.${actual.client}/${actual.user} 与 ${expected.sid}.${expected.client}/${expected.user} 不一致`,
  )
}

export function parseTransport(raw: string): string {
  const value = String(raw ?? "").trim().toUpperCase()
  if (!TRANSPORT_RE.test(value)) {
    throw new BotGateError("transport_format", "传输号格式无效。本流程只挂接已存在的请求（如 DEVK900123），不会创建或释放请求。")
  }
  return value
}

export function assertSameObject(lockedName: string, lockedType: string, requestedName?: string, requestedType?: string): void {
  if (requestedName && requestedName.trim().toUpperCase() !== lockedName.toUpperCase()) {
    throw new BotGateError("wrong_object", `会话锁定对象 ${lockedName}，拒绝操作 ${requestedName.trim().toUpperCase()}`)
  }
  if (requestedType && requestedType.trim().toUpperCase() !== lockedType.toUpperCase()) {
    throw new BotGateError("wrong_object", `会话锁定类型 ${lockedType}，拒绝类型 ${requestedType.trim().toUpperCase()}`)
  }
}

function validPackagePattern(pattern: string): boolean {
  return pattern === "*" || /^[A-Z0-9_$/]+$/.test(pattern) || /^[A-Z0-9_$/]+\*$/.test(pattern)
}

/** child 能匹配到的每个包名，parent 也必须能匹配到。用来防止命令行把允许范围放宽。 */
export function isSubsetPattern(child: string, parent: string): boolean {
  const c = child.toUpperCase()
  const p = parent.toUpperCase()
  if (!validPackagePattern(c) || !validPackagePattern(p)) return false
  if (p === "*") return true
  if (c === "*") return false
  const cWild = c.endsWith("*")
  const pWild = p.endsWith("*")
  const cBody = cWild ? c.slice(0, -1) : c
  const pBody = pWild ? p.slice(0, -1) : p
  if (!cWild && !pWild) return cBody === pBody
  if (!cWild && pWild) return cBody.startsWith(pBody)
  if (cWild && pWild) return cBody.startsWith(pBody)
  return false
}

export function packageMatches(packageName: string, patterns: string[]): boolean {
  const name = packageName.trim().toUpperCase()
  return patterns.some((pattern) => {
    const p = pattern.trim().toUpperCase()
    if (p === "*") return true
    if (p.endsWith("*")) return name.startsWith(p.slice(0, -1))
    return name === p
  })
}

/**
 * 配置是上限。命令行只能在上限之内收窄。
 * 未配置时上限是 Z* 与 Y*。显式传入空数组表示不允许任何包。
 */
export function resolvePackageAllow(configAllow: string[] | undefined, cliAllow: string[] | undefined): string[] {
  const ceiling = (configAllow === undefined ? DEFAULT_PACKAGE_ALLOW : configAllow).map((p) => p.trim().toUpperCase()).filter(Boolean)
  for (const pattern of ceiling) {
    if (!validPackagePattern(pattern)) throw new BotGateError("package_allowlist", `配置中的包模式无效: ${pattern}`)
  }
  const requested = (cliAllow === undefined ? ceiling : cliAllow.map((p) => p.trim().toUpperCase()).filter(Boolean))
  for (const pattern of requested) {
    if (!validPackagePattern(pattern)) throw new BotGateError("package_allowlist", `包模式无效: ${pattern}`)
    if (!ceiling.some((parent) => isSubsetPattern(pattern, parent))) {
      throw new BotGateError("package_allowlist", `包模式 ${pattern} 超出允许范围 ${ceiling.join(", ") || "(空)"}。命令行不能放宽配置。`)
    }
  }
  return requested
}

export function assertReadOnlySql(sql: string): string {
  const text = String(sql ?? "").trim()
  if (!text) throw new BotGateError("sql_rejected", "SQL 为空")
  if (text.includes(";")) throw new BotGateError("sql_rejected", "只允许单条 SELECT/WITH，已拒绝分号。")
  const cleaned = text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/'(?:[^']|'')*'/g, " ")
  if (!/^(SELECT|WITH)\b/i.test(cleaned)) throw new BotGateError("sql_rejected", "只允许 SELECT 或 WITH 开头的只读查询。")
  if (DML_RE.test(cleaned)) throw new BotGateError("sql_rejected", "查询中含写操作关键字，已拒绝。")
  return text
}

export function assertTableRead(table: string, filter?: string): { table: string; filter?: string } {
  const name = String(table ?? "").trim().toUpperCase()
  if (!TABLE_NAME_RE.test(name)) throw new BotGateError("table_name", "表名无效")
  const where = filter?.trim()
  if (where) {
    if (where.includes(";")) throw new BotGateError("sql_rejected", "筛选条件含分号，已拒绝。")
    if (DML_RE.test(where) || /^\s*(SELECT|WITH)\b/i.test(where)) {
      throw new BotGateError("sql_rejected", "筛选条件只写 WHERE 内容，不能带 SELECT 或写操作关键字。")
    }
  }
  return { table: name, filter: where || undefined }
}

export function assertDiffHash(raw: string): string {
  const value = String(raw ?? "").trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(value)) throw new BotGateError("hash_format", "diff-hash 必须是 64 位十六进制 SHA-256")
  return value
}

function escapeReg(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function applyEdit(source: string, edit: SourceEdit, objectType: string): string {
  const base = normalizeSource(source)
  if (edit.mode === "replace") {
    const oldString = edit.oldString.replace(/\r\n/g, "\n")
    const newString = edit.newString.replace(/\r\n/g, "\n")
    try {
      return normalizeSource(findAndReplace(base, oldString, newString))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes("匹配到")) throw new BotGateError("snippet_not_unique", message)
      if (message.includes("未找到") || message.includes("不能为空")) throw new BotGateError("snippet_not_found", message)
      if (message.includes("相同")) throw new BotGateError("no_change", message)
      throw new BotGateError("snippet_rejected", message)
    }
  }
  if (edit.mode === "method") return replaceMethod(base, edit.method, edit.source)
  if (!INCLUDE_TYPES.has(objectType.toUpperCase())) {
    throw new BotGateError(
      "include_not_allowed",
      `对象类型 ${objectType} 不能整段替换。请使用 old/new 片段或 --method。本流程默认不做整文件覆盖。`,
    )
  }
  const next = normalizeSource(edit.source)
  if (!next.trim()) throw new BotGateError("empty_source", "include 源码不能为空")
  if (next === base) throw new BotGateError("no_change", "源码没有变化")
  return next
}

function replaceMethod(source: string, method: string, replacement: string): string {
  const name = method.trim()
  if (!/^[A-Za-z_/][A-Za-z0-9_/]*$/.test(name)) throw new BotGateError("method_name", "方法名无效")
  const next = normalizeSource(replacement)
  const head = new RegExp(`^\\s*METHOD\\s+${escapeReg(name)}\\b`, "i")
  if (!head.test(next) || !/ENDMETHOD\s*\.\s*$/i.test(next)) {
    throw new BotGateError("method_mismatch", "替换内容必须是该方法完整的 METHOD ... ENDMETHOD 块")
  }
  const blocks = next.match(/^\s*METHOD\b/gim) ?? []
  if (blocks.length !== 1) throw new BotGateError("method_mismatch", "替换内容只能包含一个 METHOD 块")
  const re = new RegExp(`^[ \\t]*METHOD[ \\t]+${escapeReg(name)}\\b[\\s\\S]*?^[ \\t]*ENDMETHOD[ \\t]*\\.`, "gim")
  const found = source.match(re) ?? []
  if (found.length === 0) throw new BotGateError("method_not_found", `未找到方法 ${name}`)
  if (found.length > 1) throw new BotGateError("method_not_unique", `方法 ${name} 匹配到 ${found.length} 处，请改用更精确的 old/new 片段`)
  const updated = source.replace(re, next)
  if (normalizeSource(updated) === source) throw new BotGateError("no_change", "替换后源码没有变化")
  return normalizeSource(updated)
}

interface LineEdit { op: "eq" | "del" | "ins"; text: string }

function sourceLines(source: string): string[] {
  const text = normalizeSource(source)
  return text.length ? text.split("\n") : []
}

/** 行数乘积可接受时用 LCS；更大的替换仍给出完整的逐行差异，供人工审阅。 */
export function lineDiff(before: string, after: string): LineEdit[] {
  const a = sourceLines(before)
  const b = sourceLines(after)
  if (a.length * b.length > 8_000_000) {
    return [...a.map((text) => ({ op: "del" as const, text })), ...b.map((text) => ({ op: "ins" as const, text }))]
  }
  const n = a.length
  const m = b.length
  const dp = new Uint32Array((n + 1) * (m + 1))
  const at = (i: number, j: number) => i * (m + 1) + j
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[at(i, j)] = a[i] === b[j] ? dp[at(i + 1, j + 1)] + 1 : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)])
    }
  }
  const edits: LineEdit[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      edits.push({ op: "eq", text: a[i] })
      i++
      j++
    } else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) {
      edits.push({ op: "del", text: a[i] })
      i++
    } else {
      edits.push({ op: "ins", text: b[j] })
      j++
    }
  }
  while (i < n) edits.push({ op: "del", text: a[i++] })
  while (j < m) edits.push({ op: "ins", text: b[j++] })
  return edits
}

export function replayLineDiff(before: string, after: string): string {
  const src = sourceLines(before)
  const out: string[] = []
  let index = 0
  for (const edit of lineDiff(before, after)) {
    if (edit.op === "ins") {
      out.push(edit.text)
      continue
    }
    if (src[index] !== edit.text) throw new BotGateError("diff_failed", "差异回放与原文不一致")
    if (edit.op === "eq") out.push(edit.text)
    index++
  }
  if (index !== src.length) throw new BotGateError("diff_failed", "差异回放未消耗完原文")
  return out.join("\n")
}

export function unifiedDiff(before: string, after: string, label: string): string {
  const edits = lineDiff(before, after)
  const changed = edits.map((edit) => edit.op !== "eq")
  const keep = changed.slice()
  for (let i = 0; i < edits.length; i++) {
    if (!changed[i]) continue
    const from = Math.max(0, i - 3)
    const to = Math.min(edits.length - 1, i + 3)
    for (let j = from; j <= to; j++) keep[j] = true
  }
  const header = [`--- a/${label}`, `+++ b/${label}`]
  const body: string[] = []
  let oldNum = 1
  let newNum = 1
  let index = 0
  while (index < edits.length) {
    if (!keep[index]) {
      if (edits[index].op !== "ins") oldNum++
      if (edits[index].op !== "del") newNum++
      index++
      continue
    }
    const oldStart = oldNum
    const newStart = newNum
    const hunk: string[] = []
    while (index < edits.length && keep[index]) {
      const edit = edits[index]
      if (edit.op === "eq") {
        hunk.push(` ${edit.text}`)
        oldNum++
        newNum++
      } else if (edit.op === "del") {
        hunk.push(`-${edit.text}`)
        oldNum++
      } else {
        hunk.push(`+${edit.text}`)
        newNum++
      }
      index++
    }
    body.push(`@@ -${oldStart},${oldNum - oldStart} +${newStart},${newNum - newStart} @@`)
    body.push(...hunk)
  }
  return [...header, ...body].join("\n") + "\n"
}

export function isSyntaxError(severity: string): boolean {
  return /^(E|A|X)$/i.test(severity)
}

export function hashEquals(left: string, right: string): boolean {
  const a = Buffer.from(left.toLowerCase())
  const b = Buffer.from(right.toLowerCase())
  if (a.length !== b.length) return false
  return a.equals(b)
}
