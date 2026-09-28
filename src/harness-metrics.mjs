import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
  return value
}
export class RunMetrics {
  constructor(now = () => performance.now()) { this.now = now; this.calls = new Map(); this.seen = new Set(); this.row = null }
  start(model, profile = "all", priced = false) {
    this.priced = priced
    this.stopReason = null
    this.calls.clear(); this.seen.clear(); this.started = this.now()
    this.row = { id: randomUUID(), timestamp: new Date().toISOString(), model, profile, costSource: priced ? "configured-model-rates" : "unknown",
      modelCalls: 0, toolCalls: 0, repeatedTools: 0, failedTools: 0, resultCharacters: 0,
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null, firstTokenMs: null, tools: [], taskSuccess: null }
  }
  event(event) {
    const r = this.row
    if (!r) return
    if (event.type === "tool_execution_start") {
      const key = createHash("sha256").update(JSON.stringify([event.toolName, stable(event.args)])).digest("hex")
      if (this.seen.has(key)) r.repeatedTools++
      this.seen.add(key)
      this.calls.set(event.toolCallId, { name: event.toolName, started: this.now() })
      r.toolCalls++
    }
    if (event.type === "tool_execution_end") {
      const call = this.calls.get(event.toolCallId)
      if (call) r.tools.push({ name: call.name, elapsedMs: Math.round(this.now() - call.started), failed: !!(event.isError || event.result?.isError) })
      this.calls.delete(event.toolCallId)
      if (event.isError || event.result?.isError) r.failedTools++
      r.resultCharacters += JSON.stringify(event.result?.content || []).length
    }
    if (event.type === "message_update" && r.firstTokenMs === null) r.firstTokenMs = Math.round(this.now() - this.started)
    if (event.type === "message_end" && event.message?.role === "assistant") {
      r.modelCalls++
      const m = event.message
      this.stopReason = m.stopReason
      if (m.usage) {
        for (const key of ["input", "output", "cacheRead", "cacheWrite"]) r[key] += Number(m.usage[key]) || 0
        if (this.priced && typeof m.usage.cost?.total === "number") r.cost = (r.cost ?? 0) + m.usage.cost.total
      }
    }
  }
  finish() {
    if (!this.row) return null
    const result = { ...this.row, elapsedMs: Math.round(this.now() - this.started),
      status: this.stopReason === "aborted" ? "aborted" : this.stopReason === "error" ? "failed" : "completed" }
    this.row = null; this.stopReason = null
    return result
  }
}

let writes = Promise.resolve()
export function writeRunMetric(file, row) {
  writes = writes.catch(() => {}).then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const stat = await fs.stat(file).catch(() => null)
    if (stat?.size > 10 * 1024 * 1024) {
      await fs.rm(file + ".1", { force: true })
      await fs.rename(file, file + ".1")
    }
    await fs.appendFile(file, JSON.stringify(row) + "\n")
  })
  return writes
}

export function installHarnessMetrics(pi, { file, profile = "all" }) {
  const metrics = new RunMetrics()
  pi.on("before_agent_start", (_event, ctx) => metrics.start(`${ctx.model?.provider}/${ctx.model?.id}`, profile, Object.values(ctx.model?.cost || {}).some(value => Number(value) > 0)))
  for (const type of ["tool_execution_start", "tool_execution_end", "message_update", "message_end"]) pi.on(type, event => metrics.event(event))
  const flush = async () => {
    const row = metrics.finish()
    if (row) await writeRunMetric(file, row).catch(error => console.warn(`[metrics] ${error.code || "write failed"}`))
  }
  pi.on("agent_settled", flush)
  pi.on("session_shutdown", flush)
}

export function summarizeRuns(rows) {
  const judged = rows.filter(r => typeof r.taskSuccess === "boolean")
  const successes = judged.filter(r => r.taskSuccess)
  const times = rows.map(r => r.elapsedMs).filter(Number.isFinite).sort((a, b) => a - b)
  const sum = key => rows.reduce((n, r) => n + (Number(r[key]) || 0), 0)
  return { runs: rows.length, judged: judged.length, successRate: judged.length ? successes.length / judged.length : null,
    p50Ms: times.length ? times[Math.ceil(times.length * .5) - 1] : null, p95Ms: times.length ? times[Math.ceil(times.length * .95) - 1] : null,
    modelCalls: sum("modelCalls"), toolCalls: sum("toolCalls"), repeatedTools: sum("repeatedTools"), failedTools: sum("failedTools"),
    input: sum("input"), output: sum("output"), cacheRead: sum("cacheRead"), cacheWrite: sum("cacheWrite"),
    costPerSuccess: successes.length && judged.every(r => r.cost != null) ? judged.reduce((n, r) => n + r.cost, 0) / successes.length : null }
}
