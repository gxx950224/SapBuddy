/**
 * 写工具硬化单测（覆盖 create_object_programmatically 的强制校验）
 * 只测"连 SAP 之前"就拦截的规则：对象类型 / 包名 / 描述
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const { createObjectTool } = require("../dist/sap-tools/tools/writeTools.js")

const base = { name: "ZTEST001", description: "测试对象", packageName: "ZPKG", connectionId: "none" }

test("create_object_programmatically：PROG/I（Include）放行，进入连接阶段", async () => {
  const out = await createObjectTool.execute({ ...base, objectType: "PROG/I" })
  assert.ok(!out.includes("必须用 PROG/P"), `Include 创建不应被报表规则拦截，实际: ${out.slice(0, 200)}`)
})

test("create_object_programmatically：FUGR/F 被拦截（必须用 FUGR/FF）", async () => {
  const out = await createObjectTool.execute({ ...base, objectType: "FUGR/F", parentName: "ZFG" })
  assert.ok(out.includes("FUGR/FF"), `应提示用 FUGR/FF，实际: ${out.slice(0, 160)}`)
})

test("create_object_programmatically：FUGR/FF 缺 parentName 被拦截", async () => {
  const out = await createObjectTool.execute({ ...base, objectType: "FUGR/FF" })
  assert.ok(out.includes("parentName"), `应提示提供 parentName，实际: ${out.slice(0, 160)}`)
})

test("create_object_programmatically：$TMP 放行（不再被拦截，进入连接阶段）", async () => {
  const out = await createObjectTool.execute({ ...base, objectType: "CLAS/OC", packageName: "$TMP" })
  assert.ok(!out.includes("禁止 $TMP") && !out.includes("必须提供正式开发包"),
    `$TMP 不应被包名规则拦截，实际: ${out.slice(0, 200)}`)
})

test("create_object_programmatically：缺包名被拦截，并提示向用户确认写哪个包", async () => {
  const out = await createObjectTool.execute({ ...base, objectType: "CLAS/OC", packageName: "  " })
  assert.ok(out.includes("哪个包"), `应提示确认写哪个包（正式包或 $TMP），实际: ${out.slice(0, 200)}`)
})

test("create_object_programmatically：缺描述仍被拦截（既有规则）", async () => {
  const out = await createObjectTool.execute({ ...base, objectType: "CLAS/OC", packageName: "ZPKG", description: "  " })
  assert.ok(out.includes("描述"), `应提示缺少描述，实际: ${out.slice(0, 160)}`)
})
