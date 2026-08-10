/**
 * 系统提示默认内容同步（syncDefaultPrompts）：
 * AGENTS.md/SYSTEM.md 随包版本更新（升级覆盖为包内最新）；Memory.md 首次 seed 后永不覆盖（用户管理）
 */
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { syncDefaultPrompts } from "../src/agent-core.mjs"

function setup(version) {
  const base = mkdtempSync(join(tmpdir(), "prompt-sync-"))
  const pkg = join(base, "pkg")
  const dst = join(base, "prompts")
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "sapbuddy", version: version ?? "2.1.6" }))
  writeFileSync(join(pkg, "AGENTS.md"), "包内 AGENTS v1\n")
  writeFileSync(join(pkg, "SYSTEM.md"), "包内 SYSTEM v1\n")
  writeFileSync(join(pkg, "Memory.md"), "包内记忆\n")
  return { base, pkg, dst }
}

function cleanup({ base }) {
  rmSync(base, { recursive: true, force: true })
}

describe("syncDefaultPrompts", () => {
  test("首次运行：本地缺失 → 拷贝 AGENTS/SYSTEM/Memory，并写 .version", () => {
    const { base, pkg, dst } = setup("2.1.6")
    try {
      syncDefaultPrompts(dst, pkg)
      assert.equal(readFileSync(join(dst, "AGENTS.md"), "utf8"), "包内 AGENTS v1\n")
      assert.equal(readFileSync(join(dst, "SYSTEM.md"), "utf8"), "包内 SYSTEM v1\n")
      assert.equal(readFileSync(join(dst, "Memory.md"), "utf8"), "包内记忆\n")
      assert.equal(readFileSync(join(dst, ".version"), "utf8").trim(), "2.1.6")
    } finally { cleanup({ base }) }
  })

  test("版本未变：不覆盖本地（保留本地已有内容）", () => {
    const { base, pkg, dst } = setup("2.1.6")
    try {
      syncDefaultPrompts(dst, pkg)
      writeFileSync(join(dst, "SYSTEM.md"), "用户已修改内容\n")
      syncDefaultPrompts(dst, pkg)
      assert.equal(readFileSync(join(dst, "SYSTEM.md"), "utf8"), "用户已修改内容\n", "同版本不应覆盖本地")
    } finally { cleanup({ base }) }
  })

  test("升级版本：AGENTS/SYSTEM 覆盖为包内最新，Memory 保留用户内容", () => {
    const { base, pkg, dst } = setup("2.1.6")
    try {
      syncDefaultPrompts(dst, pkg)
      writeFileSync(join(dst, "Memory.md"), "用户积累的记忆\n")
      writeFileSync(join(pkg, "AGENTS.md"), "包内 AGENTS v2\n")
      writeFileSync(join(pkg, "SYSTEM.md"), "包内 SYSTEM v2\n")
      writeFileSync(join(pkg, "Memory.md"), "包内记忆 v2\n")
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "sapbuddy", version: "2.1.7" }))

      syncDefaultPrompts(dst, pkg)

      assert.equal(readFileSync(join(dst, "AGENTS.md"), "utf8"), "包内 AGENTS v2\n", "升级应覆盖 AGENTS")
      assert.equal(readFileSync(join(dst, "SYSTEM.md"), "utf8"), "包内 SYSTEM v2\n", "升级应覆盖 SYSTEM")
      assert.equal(readFileSync(join(dst, "Memory.md"), "utf8"), "用户积累的记忆\n", "Memory 不得被覆盖")
      assert.equal(readFileSync(join(dst, ".version"), "utf8").trim(), "2.1.7")
    } finally { cleanup({ base }) }
  })

  test("包内缺失默认文件：不报错，其余正常", () => {
    const { base, pkg, dst } = setup("2.1.6")
    try {
      rmSync(join(pkg, "AGENTS.md"))
      syncDefaultPrompts(dst, pkg)
      assert.ok(!existsSync(join(dst, "AGENTS.md")), "包内缺失则跳过")
      assert.ok(existsSync(join(dst, "SYSTEM.md")), "其余文件照常同步")
    } finally { cleanup({ base }) }
  })
})
