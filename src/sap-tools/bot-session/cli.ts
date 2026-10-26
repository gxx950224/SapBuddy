/** `sapbuddy session` 参数解析。帮助命令不连接 SAP。 */
import { readFileSync } from "node:fs"
import { sanitizeErrMsg } from "../tools/shared.js"
import { executeBotCommand, bindDeps } from "./service.js"
import { productionRuntime } from "./runtime.js"
import { createSessionStore, defaultSessionDir } from "./store.js"
import { BotGateError } from "./gates.js"
import type { AuditEntry } from "../auditLog.js"
import type { BotCommand, BotResult, BotRuntime, SourceEdit } from "./types.js"

type AuditInput = Omit<AuditEntry, "ts">

export interface SessionCliOptions {
  dir?: string
  runtime?: BotRuntime
  guard?: (connectionId: string) => Promise<void>
  audit?: (entry: AuditInput) => void
  packageCeiling?: () => string[] | undefined
  readFile?: (path: string) => string
  stdin?: string
  /** 测试可注入。缺省用 process.env。只在 open 时读取 SAPBUDDY_CONNECTION。 */
  env?: NodeJS.ProcessEnv
}

interface ParsedArgs {
  positionals: string[]
  options: Map<string, string[]>
  flags: Set<string>
}

const BOOLEANS = new Set(["include", "stdin"])

function parseArgv(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const options = new Map<string, string[]>()
  const flags = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === "--") {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (!token.startsWith("--")) {
      positionals.push(token)
      continue
    }
    const body = token.slice(2)
    const eq = body.indexOf("=")
    const name = (eq >= 0 ? body.slice(0, eq) : body).toLowerCase()
    if (!/^[a-z0-9-]+$/.test(name)) throw new BotGateError("usage", `无法识别参数 ${token}`)
    if (BOOLEANS.has(name) && eq < 0) {
      flags.add(name)
      continue
    }
    const value = eq >= 0 ? body.slice(eq + 1) : argv[++i]
    if (value === undefined || value.startsWith("--")) throw new BotGateError("usage", `--${name} 缺少取值`)
    const list = options.get(name) ?? []
    list.push(value)
    options.set(name, list)
  }
  return { positionals, options, flags }
}

function accept(parsed: ParsedArgs, names: string[], bools: string[] = []): void {
  for (const name of parsed.options.keys()) {
    if (!names.includes(name)) throw new BotGateError("usage", `此命令不支持 --${name}`)
  }
  for (const name of parsed.flags) {
    if (!bools.includes(name)) throw new BotGateError("usage", `此命令不支持 --${name}`)
  }
}

function one(parsed: ParsedArgs, name: string): string | undefined {
  const values = parsed.options.get(name)
  if (!values?.length) return undefined
  if (values.length > 1) throw new BotGateError("usage", `--${name} 只能出现一次`)
  return values[0]
}

function integer(parsed: ParsedArgs, name: string): number | undefined {
  const value = one(parsed, name)
  if (value === undefined) return undefined
  if (!/^[1-9]\d{0,6}$/.test(value)) throw new BotGateError("usage", `--${name} 必须是正整数`)
  return Number(value)
}

function packagesOf(parsed: ParsedArgs): string[] | undefined {
  const values = parsed.options.get("allow-package")
  if (!values) return undefined
  return values.flatMap((value) => value.split(",")).map((item) => item.trim()).filter(Boolean)
}

function objectFlags(parsed: ParsedArgs): { objectName?: string; objectType?: string } {
  return { objectName: one(parsed, "object"), objectType: one(parsed, "type") }
}

export function parseSessionArgs(argv: string[], readFile: (path: string) => string, stdin?: string, env: NodeJS.ProcessEnv = process.env): BotCommand {
  const parsed = parseArgv(argv)
  const command = (parsed.positionals[0] ?? "help").toLowerCase()
  const target = parsed.positionals[1]
  if (parsed.positionals.length > 2) throw new BotGateError("usage", "多余的位置参数")
  if (command === "create-transport" || command === "release" || command === "transport" || command === "create") {
    throw new BotGateError("transport_command", "bot session 不能创建或释放传输请求。打开会话时用 --transport 挂接已有可修改请求，释放由人工完成。")
  }
  if (command === "help") {
    accept(parsed, [])
    if (target) throw new BotGateError("usage", "help 不接受其他参数")
    return { command: "help" }
  }
  if (command === "open") {
    accept(parsed, ["type", "transport", "expect", "allow-package", "connection"])
    if (!target) throw new BotGateError("usage", "open 需要对象名")
    return {
      command: "open",
      objectName: target,
      objectType: one(parsed, "type"),
      transport: one(parsed, "transport"),
      expect: one(parsed, "expect"),
      allowPackages: packagesOf(parsed),
      connectionId: one(parsed, "connection") ?? envConnection(env),
    }
  }
  if (!target) throw new BotGateError("usage", `${command} 需要会话 ID`)
  const bound = { sessionId: target, ...objectFlags(parsed) }
  if (command === "read") {
    accept(parsed, ["object", "type", "start", "lines"])
    return { command: "read", ...bound, startLine: integer(parsed, "start"), lineCount: integer(parsed, "lines") }
  }
  if (command === "where-used") {
    accept(parsed, ["object", "type", "max"])
    return { command: "where-used", ...bound, max: integer(parsed, "max") }
  }
  if (command === "syntax" || command === "atc" || command === "diff" || command === "status" || command === "close") {
    accept(parsed, command === "diff" || command === "status" || command === "close" ? [] : ["object", "type"])
    return { command, ...bound }
  }
  if (command === "table") {
    accept(parsed, ["object", "type", "table", "filter", "sql", "limit"])
    return { command: "table", ...bound, table: one(parsed, "table"), filter: one(parsed, "filter"), sql: one(parsed, "sql"), limit: integer(parsed, "limit") }
  }
  if (command === "propose") {
    accept(parsed, ["object", "type", "old", "new", "old-file", "new-file", "method", "source-file", "source", "input"], ["include", "stdin"])
    return { command: "propose", ...bound, edit: editFrom(parsed, readFile, stdin) }
  }
  if (command === "apply" || command === "activate") {
    accept(parsed, ["object", "type", "diff-hash"])
    const diffHash = one(parsed, "diff-hash")
    if (!diffHash) throw new BotGateError("usage", `${command} 必须带 --diff-hash`)
    return { command, ...bound, diffHash }
  }
  throw new BotGateError("usage", `未知命令 ${command}。可用 open / read / where-used / syntax / atc / table / propose / diff / apply / activate / status / close。`)
}

function envConnection(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.SAPBUDDY_CONNECTION?.trim()
  return value || undefined
}

function editFrom(parsed: ParsedArgs, readFile: (path: string) => string, stdin?: string): SourceEdit {
  const file = (name: string) => {
    const path = one(parsed, name)
    if (!path) return undefined
    try {
      return readFile(path)
    } catch (err) {
      throw new BotGateError("file", `无法读取 ${path}：${sanitizeErrMsg(err)}`)
    }
  }
  const modes = [
    parsed.flags.has("include"),
    parsed.options.has("method"),
    parsed.options.has("old") || parsed.options.has("old-file"),
    parsed.options.has("input") || parsed.flags.has("stdin"),
  ].filter(Boolean).length
  if (modes !== 1) {
    throw new BotGateError("usage", "propose 需要且只能选择一种修改：old/new 片段、--method，或对 include 使用 --include。默认不做整文件覆盖。")
  }
  if (parsed.flags.has("stdin") || parsed.options.has("input")) {
    const text = parsed.flags.has("stdin") ? stdin : file("input")
    if (text === undefined) throw new BotGateError("usage", "--stdin 需要提供标准输入")
    return editFromJson(text)
  }
  if (parsed.options.has("method")) {
    const method = one(parsed, "method")
    const source = parsed.options.has("source") ? one(parsed, "source") : file("source-file")
    if (!method || source === undefined) throw new BotGateError("usage", "--method 需要方法名和 --source-file 或 --source")
    return { mode: "method", method, source }
  }
  if (parsed.flags.has("include")) {
    const source = parsed.options.has("source") ? one(parsed, "source") : file("source-file")
    if (source === undefined) throw new BotGateError("usage", "--include 需要 --source-file 或 --source，并且会话对象本身必须是 include")
    return { mode: "include", source }
  }
  const oldString = parsed.options.has("old") ? one(parsed, "old") : file("old-file")
  const newString = parsed.options.has("new") ? one(parsed, "new") ?? "" : file("new-file")
  if (oldString === undefined || newString === undefined) throw new BotGateError("usage", "片段替换需要 --old/--old-file 和 --new/--new-file")
  return { mode: "replace", oldString, newString }
}

function editFromJson(text: string): SourceEdit {
  let body: Record<string, unknown>
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new BotGateError("usage", "提案 JSON 无法解析")
  }
  if (body.mode === "replace" && typeof body.oldString === "string" && typeof body.newString === "string") {
    return { mode: "replace", oldString: body.oldString, newString: body.newString }
  }
  if (body.mode === "method" && typeof body.method === "string" && typeof body.source === "string") {
    return { mode: "method", method: body.method, source: body.source }
  }
  if (body.mode === "include" && typeof body.source === "string") return { mode: "include", source: body.source }
  throw new BotGateError("usage", "提案 JSON 只接受 replace、method 或 include。不接受整文件覆盖。")
}

export async function runSessionCli(argv: string[], options: SessionCliOptions = {}): Promise<{ code: number; result: BotResult }> {
  try {
    const command = parseSessionArgs(argv, options.readFile ?? ((path) => readFileSync(path, "utf8")), options.stdin, options.env ?? process.env)
    const store = createSessionStore(options.dir ?? defaultSessionDir())
    const result = await executeBotCommand(command, bindDeps({
      store,
      runtime: options.runtime ?? productionRuntime,
      guard: options.guard,
      audit: options.audit,
      packageCeiling: options.packageCeiling,
    }))
    return { code: result.ok ? 0 : 1, result }
  } catch (err) {
    if (err instanceof BotGateError) {
      return { code: 1, result: { ok: false, command: argv[0] ?? "session", code: err.code, message: err.message, ...(err.details ?? {}) } }
    }
    return { code: 1, result: { ok: false, command: argv[0] ?? "session", code: "error", message: sanitizeErrMsg(err, 500) } }
  }
}
