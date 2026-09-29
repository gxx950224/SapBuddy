import { realpathSync } from "node:fs"
import path from "node:path"
import { homedir } from "node:os"

/** Resolve existing ancestors as well as new files, so symlinks cannot hide protected targets. */
export function canonicalPath(value: string): string {
  let expanded = value.replace(/^~(?=[\\/]|$)/, homedir())
  if (process.platform === "win32") expanded = expanded.replace(/^\/([a-z])\//i, "$1:/")
  let current = path.resolve(expanded || ".")
  const missing: string[] = []
  for (;;) {
    try { return path.join(realpathSync.native(current), ...missing) }
    catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(String((error as NodeJS.ErrnoException).code))) throw error
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(expanded || ".")
      missing.unshift(path.basename(current))
      current = parent
    }
  }
}

function within(target: string, root: string): boolean {
  const relative = path.relative(root.toLowerCase(), target.toLowerCase())
  return !!relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/** A closed command grammar, not a blacklist of filenames in arbitrary executable code.
 * No scripts, substitutions, pipes, redirection, extra flags, or extra commands.
 * Quoted arguments are mandatory; expansion characters are rejected even in quotes.
 */
export type LocalOperation = { kind: "https" | "upload" | "open"; target: string }
export function parseBashCommand(command: string): LocalOperation | undefined {
  if (/[\r\n\x00`$;%!^<>|]/.test(command) || command.includes("..")) return
  const match = /^(start\s+""|explorer|open|cat|curl(?:\s+-(?:s|sS|fsS))?)\s+(?:"([^"\\]*)"|'([^'\\]*)')\s*$/.exec(command)
  if (!match) return
  const verb = match[1].split(/\s/)[0]
  const argument = match[2] ?? match[3]
  if (verb === "curl") {
    try {
      const url = new URL(argument)
      if (url.protocol === "https:" && !url.username && !url.password && !url.port &&
        /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(url.hostname) &&
        !/(^|\.)(localhost|local|internal|home|test|invalid)$|^[\d.]+$/i.test(url.hostname)) return { kind: "https", target: url.href }
    } catch { /* invalid URL */ }
    return
  }
  if (/[&*?]/.test(argument)) return
  try {
    const target = canonicalPath(argument)
    const root = path.join(canonicalPath(path.join(homedir(), ".SapBuddy")), verb === "cat" ? "uploads" : "output")
    if (!within(target, root)) return
    if (verb === "cat") {
      if (/\.(txt|csv|tsv|md|json|xml)$/i.test(target) &&
        !/(^|[\\/])(connections|auth|settings|models|models-store|mcp)\.json$/i.test(target)) return { kind: "upload", target }
    } else if (/\.(html|pdf|png|jpe?g|gif|webp|txt|csv|tsv)$/i.test(target)) return { kind: "open", target }
  } catch { /* fail closed */ }
}

export const bashCommandAllowed = (command: string): boolean => !!parseBashCommand(command)
