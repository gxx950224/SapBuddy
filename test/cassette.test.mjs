/**
 * 会话录制/回放测试：用录制好的真机会话（JSONL）离线跑 get_abap_object_lines，
 * 验证「录下来的调用序列在回放时能还原出相同结果」。
 *
 * 回放不连任何真实 SAP：客户端被 __setClientFactoryForTest 注入为 makeCassetteClient，
 * 按「方法+参数」精确命中录制文件里的条目。没录到的调用会抛 [cassette] 缺失错误，
 * 而不是假装成功 —— 测试作者会立刻看到"这一段没录"。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const require = createRequire(import.meta.url)
const { __setClientFactoryForTest, markConnectionUnhealthy } = require("../dist/sap-tools/adtManager.js")
const { __setConfigForTest } = require("../dist/sap-tools/config.js")
const { getObjectLinesTool } = require("../dist/sap-tools/tools/getObjectLines.js")
const { makeCassetteClient } = await import("./cassette-client.mjs")

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "cassette-sample.jsonl")

function setFakeDevConfig() {
  __setConfigForTest({
    connections: [{ id: "dev", url: "http://fake:8000", username: "u", password: "p", client: "001", language: "EN", authMethod: "basic" }],
    security: {},
  })
}

function reset() {
  __setClientFactoryForTest(null)
  __setConfigForTest(null)
  markConnectionUnhealthy("dev")
}

test("cassette 回放：get_abap_object_lines 读出录制里的 ZMMR017 源码（不连真实 SAP）", async () => {
  setFakeDevConfig()
  markConnectionUnhealthy("dev")
  __setClientFactoryForTest(() => makeCassetteClient(FIXTURE))
  try {
    const out = await getObjectLinesTool.execute({ objectName: "ZMMR017", objectType: "PROG" })
    assert.ok(out.includes("完整源码"), `应有完整源码头，实际: ${out.slice(0, 120)}`)
    assert.ok(out.includes("Hello from cassette"), "应还原录制文件里的源码内容")
    assert.ok(out.includes("DATA lv_count TYPE i VALUE 42"), "应还原多行源码")
  } finally {
    reset()
  }
})

test("cassette 回放：未录制的对象报 [cassette] 缺失错误（不静默假装成功）", async () => {
  setFakeDevConfig()
  markConnectionUnhealthy("dev")
  __setClientFactoryForTest(() => makeCassetteClient(FIXTURE))
  try {
    const out = await getObjectLinesTool.execute({ objectName: "ZTEST999", objectType: "PROG" })
    assert.ok(out.includes("[cassette] 缺少录制条目"), `应明示缺失，实际: ${out.slice(0, 200)}`)
  } finally {
    reset()
  }
})
