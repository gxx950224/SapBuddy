import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { SessionStore } from "../src/web/session-store.mjs"

const sessionCount = 1000
const historyTurns = 2500
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sapbuddy-web-bench-"))
const elapsed = async action => {
  const start = performance.now()
  const value = await action()
  return { value, milliseconds: Number((performance.now() - start).toFixed(2)) }
}

try {
  const longHistoryPath = path.join(directory, "long-history.jsonl")
  const shortCount = sessionCount - 1
  await Promise.all(Array.from({ length: shortCount }, (_, index) => {
    const name = `session-${String(index).padStart(4, "0")}.jsonl`
    const entry = { message: { role: "user", content: [{ type: "text", text: `合成会话 ${index}` }] } }
    return fs.writeFile(path.join(directory, name), JSON.stringify(entry) + "\n")
  }))
  const records = []
  for (let index = 0; index < historyTurns; index++) {
    records.push(JSON.stringify({ message: { role: "user", content: [{ type: "text", text: `合成需求 ${index}😀` }] } }))
    records.push(JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: `合成答复 ${index} ${"内容".repeat(120)}` }] } }))
  }
  const historyText = records.join("\n") + "\n"
  await fs.writeFile(longHistoryPath, historyText)

  const store = new SessionStore(directory)
  const cold = await elapsed(() => store.list())
  assert.equal(cold.value.total, sessionCount)
  assert.equal(store.scans, sessionCount)

  const scansAfterCold = store.scans
  const hot = await elapsed(() => store.list())
  assert.equal(hot.value.total, sessionCount)
  assert.equal(store.scans, scansAfterCold)

  const restored = new SessionStore(directory)
  const restart = await elapsed(() => restored.list())
  assert.equal(restart.value.total, sessionCount)
  assert.equal(restored.scans, 0)

  const history = await elapsed(() => store.history(longHistoryPath))
  assert.equal(history.value.messages.length, 40)
  assert.equal(history.value.userOffset, historyTurns - 20)

  console.log(JSON.stringify({
    environment: {
      node: process.version,
      platform: `${os.platform()} ${os.release()}`,
      cpu: os.cpus()[0]?.model || "unknown",
    },
    dataset: {
      sessions: sessionCount,
      historyTurns,
      historyBytes: Buffer.byteLength(historyText),
      defaultHistoryPageMessages: history.value.messages.length,
    },
    measurementsMs: {
      coldSessionIndex: cold.milliseconds,
      hotRefresh: hot.milliseconds,
      restartFromSummaryCache: restart.milliseconds,
      recentHistoryPage: history.milliseconds,
    },
    indexScans: {
      cold: scansAfterCold,
      hotRefresh: store.scans - scansAfterCold,
      restart: restored.scans,
    },
  }, null, 2))
} finally {
  await fs.rm(directory, { recursive: true, force: true })
}
