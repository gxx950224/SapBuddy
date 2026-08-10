/**
 * 技能同步（syncDefaultSkills）：包内 defaults/skills 首次整体拷贝；升级合并补发缺失技能，已有技能不覆盖
 */
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { syncDefaultSkills } from "../src/agent-core.mjs"

/** 构造一个临时技能源/目标：src = defaults 源，legacy = 旧配置，dst = 目标 skills 目录 */
function setup() {
  const base = mkdtempSync(join(tmpdir(), "skill-sync-"))
  const src = join(base, "defaults")
  const legacy = join(base, "legacy")
  const dst = join(base, "dst")
  return { base, src, legacy, dst }
}

function cleanup({ base }) {
  rmSync(base, { recursive: true, force: true })
}

describe("syncDefaultSkills", () => {
  test("首次运行：dst 不存在 → 整体拷贝 defaults，legacy 优先", () => {
    const { base, src, legacy, dst } = setup()
    try {
      mkdirSync(join(legacy, "legacy-skill"), { recursive: true })
      writeFileSync(join(legacy, "legacy-skill", "SKILL.md"), "legacy 技能")
      mkdirSync(join(src, "default-skill"), { recursive: true })
      writeFileSync(join(src, "default-skill", "SKILL.md"), "内置技能")

      syncDefaultSkills(dst, src, legacy)

      assert.ok(existsSync(join(dst, "legacy-skill", "SKILL.md")), "应拷贝 legacy 技能")
      assert.ok(!existsSync(join(dst, "default-skill")), "legacy 存在时不应再拷 defaults")
      assert.equal(readFileSync(join(dst, "legacy-skill", "SKILL.md"), "utf8"), "legacy 技能")
    } finally {
      cleanup({ base })
    }
  })

  test("首次运行：无 legacy → 整体拷贝 defaults", () => {
    const { base, src, dst } = setup()
    try {
      mkdirSync(join(src, "abap-wiki"), { recursive: true })
      writeFileSync(join(src, "abap-wiki", "SKILL.md"), "abap wiki 技能")

      syncDefaultSkills(dst, src, null)

      assert.ok(existsSync(join(dst, "abap-wiki", "SKILL.md")), "应整体拷贝 defaults")
      assert.equal(readFileSync(join(dst, "abap-wiki", "SKILL.md"), "utf8"), "abap wiki 技能")
    } finally {
      cleanup({ base })
    }
  })

  test("升级：dst 已存在 → 补发 defaults 缺失技能，已有技能不覆盖", () => {
    const { base, src, dst } = setup()
    try {
      // 已有目录：老技能 + 用户改动
      mkdirSync(join(dst, "old-skill"), { recursive: true })
      writeFileSync(join(dst, "old-skill", "SKILL.md"), "用户已改内容")
      // defaults：老技能 + 新技能
      mkdirSync(join(src, "old-skill"), { recursive: true })
      writeFileSync(join(src, "old-skill", "SKILL.md"), "内置原版")
      mkdirSync(join(src, "abap-wiki"), { recursive: true })
      writeFileSync(join(src, "abap-wiki", "SKILL.md"), "新技能")

      syncDefaultSkills(dst, src, null)

      assert.ok(existsSync(join(dst, "abap-wiki", "SKILL.md")), "应补发缺失的新技能")
      assert.equal(readFileSync(join(dst, "abap-wiki", "SKILL.md"), "utf8"), "新技能")
      assert.equal(readFileSync(join(dst, "old-skill", "SKILL.md"), "utf8"), "用户已改内容", "已有技能不得被覆盖")
    } finally {
      cleanup({ base })
    }
  })

  test("升级：已有技能的缺失子文件不补发（技能视为用户管理）", () => {
    const { base, src, dst } = setup()
    try {
      mkdirSync(join(dst, "my-skill"), { recursive: true })
      writeFileSync(join(dst, "my-skill", "SKILL.md"), "用户技能")
      mkdirSync(join(src, "my-skill"), { recursive: true })
      writeFileSync(join(src, "my-skill", "SKILL.md"), "内置")
      writeFileSync(join(src, "my-skill", "README.md"), "内置说明")

      syncDefaultSkills(dst, src, null)

      assert.ok(!existsSync(join(dst, "my-skill", "README.md")), "已有技能内部不补发")
      assert.deepEqual(readdirSync(join(dst, "my-skill")), ["SKILL.md"])
    } finally {
      cleanup({ base })
    }
  })
})
