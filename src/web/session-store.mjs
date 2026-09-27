import fs from "node:fs"
import path from "node:path"
import { setImmediate } from "node:timers/promises"

// Cache contains summaries and turn byte offsets, never message bodies or credentials.
export class SessionStore {
  constructor(dir) {
    this.dir = dir
    this.cacheFile = path.join(dir, ".web-index-v1.json")
    this.entries = {}
    this.loaded = false
    this.pending = null
    this.scans = 0
  }

  async refresh() {
    if (this.pending) return this.pending
    this.pending = this.scan().finally(() => { this.pending = null })
    return this.pending
  }

  async scan() {
    if (!this.loaded) {
      try {
        const cached = JSON.parse(await fs.promises.readFile(this.cacheFile, "utf8"))
        if (cached.version === 1) this.entries = cached.entries || {}
      } catch { /* Rebuild absent or damaged cache. */ }
      this.loaded = true
    }
    let files
    try { files = (await fs.promises.readdir(this.dir)).filter(f => f.endsWith(".jsonl")) }
    catch (err) { if (err.code === "ENOENT") return []; throw err }
    let changed = false
    const next = {}
    // Bounded concurrency keeps cold indexing responsive without opening every file at once.
    let cursor = 0
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (cursor < files.length) {
        const name = files[cursor++]
        const file = path.join(this.dir, name)
        try {
          const stat = await fs.promises.stat(file)
          const signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
          let entry = this.entries[name]
          if (!entry || entry.signature !== signature || !Array.isArray(entry.turns)) {
            entry = await this.index(file, stat)
            entry.signature = signature
            changed = true
          }
          next[name] = entry
        } catch (err) { if (err.code !== "ENOENT") throw err }
      }
    }))
    if (Object.keys(next).length !== Object.keys(this.entries).length) changed = true
    this.entries = next
    if (changed) {
      const temp = this.cacheFile + `.${process.pid}.tmp`
      try {
        await fs.promises.writeFile(temp, JSON.stringify({ version: 1, entries: next }))
        await fs.promises.rename(temp, this.cacheFile)
      } catch { await fs.promises.unlink(temp).catch(() => {}) }
    }
    return Object.entries(next).map(([name, e]) => ({ path: path.join(this.dir, name),
      name: e.name, firstMessage: e.title, messageCount: e.count, modified: e.modified, time: e.modified }))
  }

  async index(file, stat) {
    this.scans++
    let title = "", customName = "", count = 0, previousAssistant = false
    const turns = []
    for await (const { entry, offset } of readEntries(file, 0, stat.size)) {
      if (entry.type === "session_info") customName = String(entry.name || "").trim()
      const m = entry.message
      if (m?.role === "user") {
        previousAssistant = false
        if (visibleUser(m)) {
          turns.push(offset)
          count++
          if (!title) title = messageText(m).slice(0, 40) || "图片消息"
        }
      } else if (m?.role === "assistant" && m.content?.length) {
        if (!previousAssistant) count++
        previousAssistant = true
      }
    }
    return { title: title || "新会话", name: customName || title || "新会话", count,
      modified: stat.mtimeMs, size: stat.size, turns }
  }

  async list({ limit = 50, offset = 0, query = "", pinned = [] } = {}) {
    let all = await this.refresh()
    const normalize = p => path.resolve(p).toLowerCase()
    const pins = new Set(pinned.map(normalize))
    if (query) all = all.filter(e => e.name.toLowerCase().includes(query.toLowerCase()))
    all.sort((a, b) => Number(pins.has(normalize(b.path))) - Number(pins.has(normalize(a.path))) || b.modified - a.modified || a.path.localeCompare(b.path))
    const sessions = all.slice(offset, offset + limit)
    return { sessions, total: all.length, nextOffset: offset + sessions.length < all.length ? offset + sessions.length : null }
  }

  async history(file, { before, limit = 20 } = {}) {
    await this.refresh()
    const e = this.entries[path.basename(file)]
    if (!e) return { path: file, messages: [], userOffset: 0, before: null }
    const endTurn = before == null ? e.turns.length : Math.max(0, Math.min(before, e.turns.length))
    const startTurn = Math.max(0, endTurn - limit)
    const start = startTurn === 0 ? 0 : e.turns[startTurn]
    const end = endTurn < e.turns.length ? e.turns[endTurn] : e.size
    const messages = []
    for await (const { entry } of readEntries(file, start, end)) {
      if (["user", "assistant", "toolResult"].includes(entry.message?.role)) messages.push(entry.message)
    }
    return { path: file, name: e.name, messages, userOffset: startTurn, before: startTurn > 0 ? startTurn : null }
  }
}

function messageText(m) {
  return typeof m.content === "string" ? m.content : (m.content || []).map(c => c.text || "").join("")
}
function visibleUser(m) {
  return !!messageText(m) || (Array.isArray(m.content) && m.content.some(c => c.type === "image" && c.data && c.mimeType))
}

async function* readEntries(file, start, end) {
  if (end <= start) return
  let pending = Buffer.alloc(0), offset = start, lines = 0
  for await (const chunk of fs.createReadStream(file, { start, end: end - 1 })) {
    pending = Buffer.concat([pending, chunk])
    let consumed = 0, newline
    while ((newline = pending.indexOf(10, consumed)) >= 0) {
      const bytes = pending.subarray(consumed, newline)
      let entry
      try { entry = JSON.parse(bytes.toString("utf8")) } catch { /* Ignore incomplete/bad records. */ }
      if (entry) yield { entry, offset }
      offset += newline - consumed + 1
      consumed = newline + 1
      if (++lines % 256 === 0) await setImmediate()
    }
    pending = pending.subarray(consumed)
  }
  if (pending.length) {
    let entry
    try { entry = JSON.parse(pending.toString("utf8")) } catch { /* Active partial record. */ }
    if (entry) yield { entry, offset }
  }
}
