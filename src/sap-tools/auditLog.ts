/** 写操作审计日志：每次 SAP 写工具调用（拦截/放行/执行/失败）追加到 ~/.SapBuddy/logs/audit-YYYY-MM-DD.jsonl
 * 审计是治理底线（谁/何时/改了什么/结果如何），但不允许拖垮主流程——任何失败静默忽略。 */
import { mkdirSync, appendFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const LOG_DIR = join(homedir(), ".SapBuddy", "logs")
try { mkdirSync(LOG_DIR, { recursive: true }) } catch { /* 忽略 */ }

export interface AuditEntry {
  ts: string
  event: "write_request" | "blocked" | "approved" | "executed" | "failed"
  tool: string
  objects: string[]
  connectionId?: string
  reason?: string
}

type AuditInput = Omit<AuditEntry, "ts">

/** 追加一条审计记录（ts 由内部补当前时间戳；best-effort：写失败不抛、不阻塞调用方） */
export function appendAudit(entry: AuditInput): void {
  try {
    const now = new Date()
    const today = now.toISOString().slice(0, 10)
    appendFileSync(join(LOG_DIR, `audit-${today}.jsonl`), JSON.stringify({ ...entry, ts: now.toISOString() }) + "\n")
  } catch { /* 审计失败不影响主流程 */ }
}
