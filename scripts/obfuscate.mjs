/**
 * 扩展代码混淆脚本（发布保护）：
 * 只混淆扩展代码（dist/sap-tools/ 编译产物 + agent-core 入口），
 * md 文件（README/SYSTEM/AGENTS/docs 等）保持明文，不做任何处理。
 *
 * 用法：node scripts/obfuscate.mjs
 * 由 `npm run build`（tsc && obfuscate）自动调用。
 */
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from "node:fs"
import { join, dirname, extname } from "node:path"
import { fileURLToPath } from "node:url"
import JavaScriptObfuscator from "javascript-obfuscator"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..")
const SRC_DIRS = ["dist/sap-tools"]
const SRC_FILES = ["dist/agent-core.mjs"] // 单文件（build-copy 复制后一起混淆）
const SKIP = /\.d\.ts$|\.map$/

/** 混淆单个 JS 文件（原地覆盖，保留可运行性） */
function obfuscateFile(file) {
  const code = readFileSync(file, "utf8")
  const result = JavaScriptObfuscator.obfuscate(code, {
    compact: true,
    controlFlowFlattening: false, // 保性能（SAP 工具高频调用）
    deadCodeInjection: false,
    identifierNamesGenerator: "hexadecimal",
    renameGlobals: false, // 保留模块导出名（registerTool 等外部依赖）
    selfDefending: false,
    simplify: true,
    stringArray: true,
    stringArrayEncoding: ["base64"],
    stringArrayThreshold: 0.6,
    target: "node",
    sourceMap: false,
    log: false,
  }).getObfuscatedCode()
  writeFileSync(file, result)
  return { bytes: code.length, out: result.length }
}

let total = 0
let skipped = 0
const allFiles = []
for (const dir of SRC_DIRS) {
  const base = join(ROOT, dir)
  if (!existsSync(base)) continue
  allFiles.push(...walk(base))
}
for (const f of SRC_FILES) {
  const full = join(ROOT, f)
  if (existsSync(full)) allFiles.push(full)
}
for (const f of allFiles) {
  const ext = extname(f)
  if (ext !== ".js" && ext !== ".mjs") { skipped++; continue }
  if (SKIP.test(f)) { skipped++; continue }
  const { bytes, out } = obfuscateFile(f)
  total++
  console.log(`  ${"✔"} ${f.replace(ROOT + "/", "")}  ${bytes}B → ${out}B`)
}
console.log(`\n[obfuscate] 混淆 ${total} 个文件（跳过 ${skipped} 个非 JS/映射）完成`)

function existsSync(p) { try { statSync(p); return true } catch { return false } }
function walk(p, acc = []) {
  const st = statSync(p)
  if (st.isDirectory()) for (const e of readdirSync(p)) walk(join(p, e), acc)
  else acc.push(p)
  return acc
}
