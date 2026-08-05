/**
 * 连接健壮性单测：
 * 1. withConnMutex：同一连接的并发工具调用被串行化（根因修复——并行调用踩踏共享 ADTClient）
 * 2. isConnectionError：连接级故障识别（401/5xx/网络错误 vs 业务错误）
 * 3. findObject：全部搜索失败时如实报"ADT 搜索服务异常"（而非"未找到对象"）
 * 4. 解锁失败报警与写入自检逻辑（replaceString 错误路径提示残留锁）
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const { withConnMutex, isConnectionError, markConnectionUnhealthy, __setClientFactoryForTest } = require(
  "../dist/sap-tools/adtManager.js"
)
const { __setConfigForTest } = require("../dist/sap-tools/config.js")
const { findObject } = require("../dist/sap-tools/tools/shared.js")

// CI 上没有真实 connections.json：findObject 依赖连接配置，注入最小假配置（不实际连接，客户端已被 mock）
function setFakeDevConfig() {
  __setConfigForTest({
    connections: [{ id: "dev", url: "http://fake:8000", username: "u", password: "p", client: "001", language: "EN", authMethod: "basic" }],
    security: {},
  })
}

test("withConnMutex：同一连接上的并发操作被串行化（互不重叠）", async () => {
  const active = { count: 0, max: 0 }
  const run = (id) =>
    withConnMutex("robust-test-1", async () => {
      active.count++
      active.max = Math.max(active.max, active.count)
      await new Promise((r) => setTimeout(r, 20))
      active.count--
      return id
    })
  const results = await Promise.all([run(1), run(2), run(3), run(4), run(5)])
  assert.deepEqual(results, [1, 2, 3, 4, 5], "结果应按调用顺序返回")
  assert.equal(active.max, 1, "同一连接同一时刻最多一个操作在跑")
})

test("withConnMutex：某次失败不阻塞队列中后续操作", async () => {
  const order = []
  const p1 = withConnMutex("robust-test-2", async () => {
    order.push("a")
    throw new Error("boom")
  })
  const p2 = withConnMutex("robust-test-2", async () => {
    order.push("b")
    return "ok"
  })
  await assert.rejects(() => p1, /boom/)
  assert.equal(await p2, "ok")
  assert.deepEqual(order, ["a", "b"], "失败后后续操作仍执行")
})

test("isConnectionError：识别连接级故障", () => {
  assert.equal(isConnectionError(Object.assign(new Error("x"), { status: 401 })), true)
  assert.equal(isConnectionError(Object.assign(new Error("x"), { status: 403 })), true)
  assert.equal(isConnectionError(Object.assign(new Error("x"), { status: 500 })), true)
  assert.equal(isConnectionError(Object.assign(new Error("x"), { status: 404 })), false)
  assert.equal(isConnectionError(new Error("fetch failed")), true)
  assert.equal(isConnectionError(new Error("socket hang up")), true)
  assert.equal(isConnectionError(new Error("read ECONNRESET")), true)
  assert.equal(isConnectionError(new Error("ECONNREFUSED")), true)
  assert.equal(isConnectionError(new Error("syntax error at line 3")), false)
  assert.equal(isConnectionError(new Error("object not found")), false)
  assert.equal(isConnectionError(undefined), false)
})

test("findObject：全部搜索失败时如实报'ADT 搜索服务异常'（不是'未找到'）", async () => {
  setFakeDevConfig()
  markConnectionUnhealthy("dev")
  __setClientFactoryForTest(() => ({
    login: async () => undefined,
    searchObject: async () => {
      throw Object.assign(new Error("socket hang up"), { status: 502 })
    },
  }))
  try {
    await assert.rejects(() => findObject("dev", "SCARR", "TABL"), /ADT 搜索服务异常/)
  } finally {
    __setClientFactoryForTest(null)
    __setConfigForTest(null)
    markConnectionUnhealthy("dev")
  }
})

test("findObject：部分类型搜索失败时仍返回成功结果（不全盘误报）", async () => {
  setFakeDevConfig()
  markConnectionUnhealthy("dev")
  __setClientFactoryForTest(() => ({
    login: async () => undefined,
    searchObject: async (pattern, type) => {
      if (type === "PROG") throw Object.assign(new Error("bad"), { status: 500 })
      return [{ "adtcore:name": "SCARR", "adtcore:type": "TABL", "adtcore:uri": "/x" }]
    },
  }))
  try {
    const found = await findObject("dev", "SCARR", undefined, ["PROG", "TABL"])
    assert.equal(found?.["adtcore:name"], "SCARR", "有成功的类型就返回结果")
  } finally {
    __setClientFactoryForTest(null)
    __setConfigForTest(null)
    markConnectionUnhealthy("dev")
  }
})
