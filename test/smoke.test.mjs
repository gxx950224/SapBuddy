/**
 * SapBuddy 冒烟测试（node --test）
 * 不连接 SAP、不调用 AI，仅验证：工具加载、CLI 命令、构建产物、配置路径
 */
import { test, describe, before } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve, join } from "node:path"

const ROOT = resolve(import.meta.dirname, "..")

describe("工具注册", () => {
  let tools
  before(async () => {
    const { tools: t } = await import("../dist/sap-tools/tools/index.js")
    tools = t
  })

  test("44 个 SAP 工具已加载", () => {
    assert.ok(Array.isArray(tools), "tools 应为数组")
    assert.equal(tools.length, 44, `期望 44 个工具，实际 ${tools.length}`)
  })

  test("工具名唯一且符合 snake_case", () => {
    const names = tools.map((t) => t.name)
    assert.equal(new Set(names).size, names.length, "存在重复工具名")
    for (const n of names) assert.match(n, /^[a-z][a-z0-9_]*$/, `非法工具名: ${n}`)
  })

  test("每个工具都有 schema 与 execute", () => {
    for (const t of tools) {
      assert.ok(t.inputSchema, `${t.name} 缺少 inputSchema`)
      assert.equal(typeof t.execute, "function", `${t.name} 缺少 execute`)
    }
  })

  test("写工具已标记 write:true", () => {
    const writeTools = tools.filter((t) => t.write)
    assert.ok(writeTools.length >= 5, "写工具应 >=5 个")
  })
})

describe("CLI", () => {
  test("node cli.mjs tools 输出 44 个工具", () => {
    const out = execFileSync(process.execPath, ["cli.mjs", "tools"], { cwd: ROOT, encoding: "utf8", timeout: 30000 })
    assert.match(out, /SAP 工具共 44 个/)
  })

  test("node cli.mjs doctor 自检通过", () => {
    const out = execFileSync(process.execPath, ["cli.mjs", "doctor"], { cwd: ROOT, encoding: "utf8", timeout: 60000 })
    assert.match(out, /SAP 工具: 44 个已加载/)
  })
})

describe("构建产物", () => {
  test("dist 已编译且 register 导出可用", () => {
    const reg = join(ROOT, "dist", "sap-tools", "register.js")
    assert.ok(existsSync(reg), "缺少 dist/sap-tools/register.js（先运行 npm run build）")
    const src = readFileSync(reg, "utf8")
    assert.match(src, /export function registerSapTools/)
  })
})

describe("配置文件", () => {
  test("模板文件存在且无真实凭据", () => {
    for (const f of ["config/auth.example.json", "config/connections.example.json", "config/settings.example.json"]) {
      const p = join(ROOT, f)
      assert.ok(existsSync(p), `缺少 ${f}`)
      const txt = readFileSync(p, "utf8")
      assert.doesNotMatch(txt, /sk-[A-Za-z0-9]{20,}/, `${f} 含疑似真实 API Key`)
    }
  })

  test("package.json 元数据完整（npm 发布）", () => {
    const p = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
    assert.ok(p.repository?.url, "缺少 repository")
    assert.ok(p.files?.length, "缺少 files 白名单")
    assert.ok(p.scripts?.prepublishOnly, "缺少 prepublishOnly")
    assert.equal(p.license, "MIT")
  })
})
