/** 会话只落在本机磁盘。文件里有对象名、源码差异和传输号，没有口令。 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { homedir } from "node:os"
import { assertSessionId, BotGateError } from "./gates.js"
import type { BotSession } from "./types.js"

export function defaultSessionDir(): string {
  if (process.env.SAPBUDDY_BOT_SESSION_DIR) return process.env.SAPBUDDY_BOT_SESSION_DIR
  return join(homedir(), ".SapBuddy", "bot-sessions")
}

export interface SessionStore {
  dir: string
  createId(): string
  save(session: BotSession): void
  load(id: string): BotSession
  withLock<T>(id: string, fn: () => Promise<T>): Promise<T>
}

export function createSessionStore(dir: string): SessionStore {
  mkdirSync(dir, { recursive: true })
  return {
    dir,
    createId() {
      return "bs" + randomBytes(12).toString("hex")
    },
    save(session) {
      assertSessionId(session.id)
      const dest = join(dir, `${session.id}.json`)
      const tmp = join(dir, `.${session.id}.${process.pid}.tmp`)
      writeFileSync(tmp, JSON.stringify(session, null, 2) + "\n", { mode: 0o600 })
      renameSync(tmp, dest)
    },
    load(id) {
      const sessionId = assertSessionId(id)
      const dest = join(dir, `${sessionId}.json`)
      if (!existsSync(dest)) throw new BotGateError("session_not_found", `未找到会话 ${sessionId}`)
      let parsed: BotSession
      try {
        parsed = JSON.parse(readFileSync(dest, "utf8")) as BotSession
      } catch {
        throw new BotGateError("session_corrupt", `会话文件无法解析: ${sessionId}`)
      }
      if (!parsed || parsed.version !== 1 || parsed.id !== sessionId) {
        throw new BotGateError("session_corrupt", "会话内容与文件名不一致")
      }
      if (!parsed.system?.sid || !parsed.object?.name || !parsed.baselineSha256 || !parsed.connectionId) {
        throw new BotGateError("session_corrupt", "会话缺少系统、对象或基线哈希")
      }
      return parsed
    },
    async withLock(id, fn) {
      const sessionId = assertSessionId(id)
      const lock = join(dir, `${sessionId}.lock`)
      let fd: number
      try {
        fd = openSync(lock, "wx")
      } catch {
        throw new BotGateError("busy", `会话 ${sessionId} 正在执行另一个命令`)
      }
      try {
        return await fn()
      } finally {
        closeSync(fd)
        try { unlinkSync(lock) } catch { /* 锁文件已消失时不影响结果 */ }
      }
    },
  }
}
