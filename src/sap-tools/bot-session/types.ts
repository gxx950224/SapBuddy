/** bot session 在 CLI 进程内执行，不经过对话提示。类型只描述会话与命令，不包含凭据。 */

export interface SystemIdentity {
  sid: string
  client: string
  user: string
}

export interface AbapObjectRef {
  name: string
  type: string
  uri: string
  sourceUri: string
  packageName: string
}

export type SourceEdit =
  | { mode: "replace"; oldString: string; newString: string }
  | { mode: "method"; method: string; source: string }
  | { mode: "include"; source: string }

export interface ProposalRecord {
  edit: SourceEdit
  diff: string
  diffHash: string
  expectedSha256: string
  createdAt: string
  warnings: string[]
}

export type SessionStatus =
  | "open"
  | "proposed"
  | "applied"
  | "activated"
  | "closed"
  | "apply_unverified"
  | "activate_unverified"

export interface BotSession {
  version: 1
  id: string
  createdAt: string
  updatedAt: string
  status: SessionStatus
  connectionId: string
  /** explicit = open 时写了 --connection 或 SAPBUDDY_CONNECTION；default = 当时的 active（或第一个） */
  connectionSelection?: "explicit" | "default"
  system: SystemIdentity
  object: AbapObjectRef
  transport?: string
  /** lock = ADT lock 的 CORRNR；recorded = 唯一的 E071 可修改请求；explicit = 打开时传入的 --transport */
  transportSource?: TransportSource
  packageAllow: string[]
  baselineSha256: string
  proposal?: ProposalRecord
  appliedAt?: string
  activatedAt?: string
}

export interface SyntaxMessage {
  severity: string
  line: number
  text: string
}

export interface TransportRef {
  number: string
  status: string
}

/** 对象当前挂在哪个请求上。lockRequest 来自 ADT lock，优先于 E071。recorded 只含对象真实出现过的请求，不是候选列表。 */
export interface TransportAssignment {
  lockRequest: string
  recorded: TransportRef[]
}

export type TransportSource = "lock" | "recorded" | "explicit"

export interface WriteOutcome {
  written: boolean
  unlockError?: string
}

export interface ActivateOutcome {
  success: boolean
  verification?: string
  messages: string[]
}

export interface TableResult {
  columns: string[]
  rows: Array<Record<string, unknown>>
}

/**
 * SAP 访问端口。生产实现走 ADT；测试注入假实现。
 * 这里故意没有创建或释放传输请求的方法。
 */
export interface BotRuntime {
  identity(connectionId?: string): Promise<SystemIdentity & { connectionId: string }>
  resolveObject(connectionId: string | undefined, name: string, type?: string): Promise<{ connectionId: string; object: AbapObjectRef }>
  readSource(connectionId: string, sourceUri: string, version?: "active" | "inactive"): Promise<string>
  whereUsed(connectionId: string, uri: string, max: number): Promise<Array<{ name: string; type: string; packageName?: string; usage?: string }>>
  syntaxCheck(connectionId: string, sourceUri: string, source: string): Promise<SyntaxMessage[]>
  atc(connectionId: string, uri: string): Promise<{ available: boolean; reason?: string; variant?: string; findings?: Array<{ priority?: number; line?: number; message: string }> }>
  readTable(connectionId: string, table: string, filter: string | undefined, limit: number): Promise<TableResult>
  readSql(connectionId: string, sql: string, limit: number): Promise<TableResult>
  transportStatus(connectionId: string, transport: string): Promise<{ found: boolean; status: string }>
  assignedTransport(connectionId: string, objectName: string, sourceUri: string): Promise<TransportAssignment>
  writeSource(connectionId: string, sourceUri: string, source: string, transport?: string): Promise<WriteOutcome>
  activate(connectionId: string, object: AbapObjectRef): Promise<ActivateOutcome>
  inactiveObjects(connectionId: string): Promise<Array<{ type: string; name: string }>>
}

export type BotCommand =
  | { command: "help" }
  | { command: "open"; objectName: string; objectType?: string; transport?: string; expect?: string; allowPackages?: string[]; connectionId?: string }
  | { command: "read"; sessionId: string; objectName?: string; objectType?: string; startLine?: number; lineCount?: number }
  | { command: "where-used"; sessionId: string; objectName?: string; objectType?: string; max?: number }
  | { command: "syntax"; sessionId: string; objectName?: string; objectType?: string }
  | { command: "atc"; sessionId: string; objectName?: string; objectType?: string }
  | { command: "table"; sessionId: string; objectName?: string; objectType?: string; table?: string; filter?: string; sql?: string; limit?: number }
  | { command: "propose"; sessionId: string; objectName?: string; objectType?: string; edit: SourceEdit }
  | { command: "diff"; sessionId: string }
  | { command: "apply"; sessionId: string; objectName?: string; objectType?: string; diffHash: string }
  | { command: "activate"; sessionId: string; objectName?: string; objectType?: string; diffHash: string }
  | { command: "status"; sessionId: string }
  | { command: "close"; sessionId: string }

export interface BotResult {
  ok: boolean
  command: string
  code?: string
  message?: string
  sessionId?: string
  [key: string]: unknown
}
