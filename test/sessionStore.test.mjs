import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SessionStore } from "../src/web/session-store.mjs"

const user = text => ({ message: { role: "user", content: [{ type: "text", text }] } })
const assistant = text => ({ message: { role: "assistant", content: [{ type: "text", text }] } })
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sapbuddy-index-"))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return { dir, store: new SessionStore(dir), file: path.join(dir, "chat.jsonl") }
}

test("summary cache survives restart; only changed files are rescanned", async t => {
  const { dir, store, file } = await fixture(t)
  await fs.writeFile(file, [user("第一条需求"), assistant("答复"), assistant("补充")].map(JSON.stringify).join("\n") + "\n")
  let data = await store.list()
  assert.equal(data.sessions[0].messageCount, 2)
  assert.equal(store.scans, 1)
  await Promise.all([store.list(), store.list()])
  assert.equal(store.scans, 1)
  const restored = new SessionStore(dir)
  await restored.list()
  assert.equal(restored.scans, 0)
  await fs.appendFile(file, JSON.stringify({ type: "session_info", name: "新标题" }) + "\n")
  data = await restored.list({ query: "新标题" })
  assert.equal(data.total, 1)
  assert.equal(restored.scans, 1)
  await fs.unlink(file)
  assert.equal((await restored.list()).total, 0)
})

test("history pages use UTF-8 byte offsets, whole turns and original user indices", async t => {
  const { store, file } = await fixture(t)
  const records = []
  for (let i = 0; i < 45; i++) records.push(user(`需求${i}😀`), assistant(`回复${i}`), { message: { role: "toolResult", toolCallId: String(i), content: [] } })
  await fs.writeFile(file, records.map(JSON.stringify).join("\r\n"))
  const latest = await store.history(file)
  assert.equal(latest.userOffset, 25)
  assert.equal(latest.before, 25)
  assert.equal(latest.messages.length, 60)
  assert.equal(latest.messages[0].content[0].text, "需求25😀")
  const earlier = await store.history(file, { before: latest.before })
  assert.equal(earlier.userOffset, 5)
  assert.equal(earlier.messages.at(-1).toolCallId, "24")
  const oldest = await store.history(file, { before: earlier.before })
  assert.equal(oldest.before, null)
  assert.equal(oldest.messages.length, 15)
})

test("list pagination, global search and pinned ordering", async t => {
  const { dir, store } = await fixture(t)
  const total = 1000
  await Promise.all(Array.from({ length: total }, (_, i) => fs.writeFile(path.join(dir, `${i}.jsonl`), JSON.stringify(user(`会话 ${i}`)))))
  const pinned = path.join(dir, "0.jsonl")
  const first = await store.list({ pinned: [pinned] })
  assert.equal(first.sessions.length, 50)
  assert.equal(first.sessions[0].path, pinned)
  assert.equal(first.total, total)
  assert.equal(store.scans, total)
  const second = await store.list({ pinned: [pinned], offset: first.nextOffset })
  assert.equal(second.sessions.length, 50)
  assert.equal(second.nextOffset, 100)
  assert.equal(new Set([...first.sessions, ...second.sessions].map(s => s.path)).size, 100)
  assert.equal(store.scans, total)
  assert.equal((await store.list({ query: "会话 999" })).total, 1)
  const restored = new SessionStore(dir)
  assert.equal((await restored.list()).total, total)
  assert.equal(restored.scans, 0)
})

test("damaged cache and partial records recover on next append", async t => {
  const { dir, store, file } = await fixture(t)
  await fs.writeFile(path.join(dir, ".web-index-v1.json"), "broken")
  await fs.writeFile(file, JSON.stringify(user("保留")) + '\n{"message":')
  assert.equal((await store.list()).sessions[0].messageCount, 1)
  await fs.appendFile(file, JSON.stringify(assistant("恢复").message) + "}\n")
  assert.equal((await store.list()).sessions[0].messageCount, 2)
})

test("session date filters use inclusive start and exclusive end before pagination", async t => {
  const { dir, store } = await fixture(t)
  for (const [name, day] of [["early", 1], ["middle", 2], ["late", 3]]) {
    const file = path.join(dir, name + ".jsonl")
    await fs.writeFile(file, JSON.stringify(user(name)))
    const date = new Date(`2026-09-0${day}T12:00:00Z`)
    await fs.utimes(file, date, date)
  }
  const data = await store.list({ from: Date.parse("2026-09-02T00:00:00Z"), to: Date.parse("2026-09-03T00:00:00Z"), limit: 1 })
  assert.equal(data.total, 1)
  assert.equal(data.sessions[0].name, "middle")
  assert.equal(data.nextOffset, null)
})
