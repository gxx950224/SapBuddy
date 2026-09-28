import { run } from "node:test"
import fs from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { summarizeRuns } from "../src/harness-metrics.mjs"

const runsIndex = process.argv.indexOf("--runs")
async function report(file) {
  const rows = (await fs.readFile(file, "utf8")).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  const groups = Map.groupBy(rows, row => `${row.model || "unknown"}/${row.profile || "all"}`)
  return Object.fromEntries([...groups].map(([name, runs]) => [name, summarizeRuns(runs)]))
}
if (runsIndex >= 0) {
  const result = { mode: "recorded-runs", groups: await report(process.argv[runsIndex + 1]) }
  const comparison = process.argv.indexOf("--compare")
  if (comparison >= 0) result.baseline = await report(process.argv[comparison + 1])
  console.log(JSON.stringify(result, null, 2))
} else {
  // Real tool/transport/queue workflows with controlled fixtures. No model or SAP charges.
  const stream = run({ files: [fileURLToPath(new URL("../test/harnessPerformance.test.mjs", import.meta.url))], concurrency: false })
  const scenarios = []
  for await (const event of stream) {
    if (!["test:pass", "test:fail"].includes(event.type)) continue
    scenarios.push({ name: event.data.name, passed: event.type === "test:pass", elapsedMs: event.data.details.duration_ms,
      ...(event.type === "test:fail" ? { error: String(event.data.details.error) } : {}) })
  }
  const passed = scenarios.filter(s => s.passed).length
  console.log(JSON.stringify({ mode: "offline-workflow-regression", modelCalls: 0,
    note: "Offline workflow checks; not a model quality or real SAP latency benchmark.",
    passed, total: scenarios.length, scenarios }, null, 2))
  if (!scenarios.length || passed !== scenarios.length) process.exitCode = 1
}
