import { readFileSync } from "node:fs"
// 测量工具定义总大小（42 个工具的 JSON Schema）
const r = await import("./dist/sap-tools/register.js")
// 工具定义通过 registerSapTools 注册，这里直接量 tools 的 schema 大小
const { tools } = await import("./dist/sap-tools/tools/index.js")
let total = 0
for (const t of tools) {
  const s = JSON.stringify(t.inputSchema || {}).length
  const descLen = (t.description || "").length
  total += s + descLen
}
console.log("工具数:", tools.length)
console.log("工具 schema+描述 总大小: ~", (total / 1024).toFixed(1), "KB")
// 单个最大工具
let max = null
for (const t of tools) {
  const s = JSON.stringify(t.inputSchema || {}).length
  if (!max || s > max.size) max = { name: t.name, size: s }
}
console.log("最大工具:", max.name, JSON.stringify(max.size / 1024).toFixed(1), "KB")
// SYSTEM.md 大小
const sys = readFileSync("SYSTEM.md", "utf8")
console.log("SYSTEM.md:", (sys.length / 1024).toFixed(1), "KB")
// 每轮注入规则大小（agent-core）
const ac = readFileSync("src/agent-core.mjs", "utf8")
const m = ac.match(/const GLOBAL_TOOL_RULES = `([\s\S]*?)`/)
console.log("每轮注入规则:", m ? (m[1].length / 1024).toFixed(1) + "KB" : "未找到")
