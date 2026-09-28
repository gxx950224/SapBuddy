import { mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

/** Keep complete results on disk; subsequent model turns carry only the bounded preview. */
export async function boundToolResult(text: string, directory = join(homedir(), ".SapBuddy", "output", "_tool-results")) {
  if (text.length <= 32_000) return { text, details: {} }
  await mkdir(directory, { recursive: true })
  const file = join(directory, `${randomUUID()}.txt`)
  await writeFile(file, text, "utf8")
  return {
    text: `${text.slice(0, 24_000)}\n\n[结果已分页，完整内容 ${text.length} 字符保存在 ${file}。用 read 的 offset/limit 继续读取，勿把预览当成全文。]`,
    details: { truncated: true, fullResultPath: file, characters: text.length },
  }
}
