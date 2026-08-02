/** build 辅助：复制 src/agent-core.mjs → dist/agent-core.mjs（与 dist/sap-tools 一起混淆发布） */
import { copyFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..")
mkdirSync(join(ROOT, "dist"), { recursive: true })
copyFileSync(join(ROOT, "src", "agent-core.mjs"), join(ROOT, "dist", "agent-core.mjs"))
console.log("[build] src/agent-core.mjs → dist/agent-core.mjs")
