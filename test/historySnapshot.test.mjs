import test from "node:test"
import assert from "node:assert/strict"
import { historySnapshot } from "../src/web/history-snapshot.mjs"

test("live history keeps whole turns and replaces a persisted partial answer", () => {
  const entries = Array.from({ length: 25 }, (_, i) => [
    { message: { role: "user", content: `question ${i}`, timestamp: i * 2 } },
    { message: { role: "assistant", content: `answer ${i}`, timestamp: i * 2 + 1 } },
  ]).flat()
  const live = { role: "assistant", content: "newest partial", timestamp: 49 }
  const snapshot = historySnapshot(entries, live, 3)
  assert.equal(snapshot.userOffset, 22)
  assert.equal(snapshot.before, 22)
  assert.equal(snapshot.messages.length, 6)
  assert.equal(snapshot.messages.at(-1), live)
  assert.equal(entries.at(-1).message.content, "answer 24")
  // Regeneration truncates the old answer; the new answer must appear only once.
  const regenerated = historySnapshot(entries.slice(0, -1), { ...live, timestamp: 100 }, 3)
  assert.equal(regenerated.messages.length, 6)
  assert.equal(regenerated.messages.at(-1).timestamp, 100)
  const waiting = historySnapshot(entries.slice(0, -1), null, 3)
  assert.equal(waiting.messages.at(-1).role, "user")
  assert.equal(historySnapshot(entries, null, 3, 0).messages.length, 50)
  assert.equal(historySnapshot(entries, null, 3, 10).userOffset, 10)
})
