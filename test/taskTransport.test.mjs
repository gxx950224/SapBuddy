/**
 * 任务级共享传输请求单测：
 * 1. taskTransport 模块 get/set/reset
 * 2. createObjectTool：同需求创建多对象复用同一请求；$TMP 不建请求；用户指定请求号则用之
 * 3. replaceStringTool：同需求修改多对象复用共享请求；$TMP 不建请求
 * 4. 写授权（批准/取消）重置共享请求
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const { getActiveRequest, setActiveRequest, resetActiveRequests } = require("../dist/sap-tools/taskTransport.js")
const { createObjectTool, replaceStringTool } = require("../dist/sap-tools/tools/writeTools.js")
const { __setClientFactoryForTest, markConnectionUnhealthy } = require("../dist/sap-tools/adtManager.js")
const { setWriteApprovalWindow, clearWriteApproval } = require("../dist/sap-tools/register.js")

/** 假客户端：记录 createTransport 次数/传参，模拟源码读写与对象创建 */
function makeFakeClient({ devclass = "ZPKG" } = {}) {
  const state = { current: "", createTransportCalls: 0, created: [], savedTransport: undefined }
  const client = {
    login: async () => undefined,
    searchObject: async () => [],
    createTransport: async (_uri, _desc, _dc) => {
      state.createTransportCalls++
      return `REQ${String(state.createTransportCalls).padStart(2, "0")}`
    },
    createObject: async (o) => { state.created.push(o) },
    getObjectSource: async () => state.current,
    setObjectSource: async (_uri, src, _lockHandle, transport) => {
      state.current = src
      state.savedTransport = transport
    },
    lock: async () => ({ LOCK_HANDLE: "L1", IS_LOCAL: " ", CORRNR: undefined }),
    unLock: async () => undefined,
    transportInfo: async () => ({ DEVCLASS: devclass }),
  }
  return { client, state }
}

function cleanup() {
  __setClientFactoryForTest(null)
  markConnectionUnhealthy("dev")
  resetActiveRequests()
}

const PROG_INCLUDE = "/sap/bc/adt/programs/includes/ztest1/source/main"

test("taskTransport：get/set/reset 按 连接+包 隔离", () => {
  resetActiveRequests()
  setActiveRequest("dev", "ZPKG", "REQ01")
  assert.equal(getActiveRequest("dev", "ZPKG"), "REQ01")
  assert.equal(getActiveRequest("dev", "ZPKG2"), undefined, "不同包不共享")
  resetActiveRequests()
  assert.equal(getActiveRequest("dev", "ZPKG"), undefined)
})

test("createObjectTool：同需求创建多对象复用同一请求（只自动建一次）", async () => {
  resetActiveRequests(); markConnectionUnhealthy("dev")
  const { client, state } = makeFakeClient()
  __setClientFactoryForTest(() => client)
  try {
    const base = { objectType: "PROG/P", description: "测试", packageName: "ZPKG", connectionId: "dev" }
    const r1 = await createObjectTool.execute({ ...base, name: "ZTESTA1" })
    const r2 = await createObjectTool.execute({ ...base, name: "ZTESTA2" })
    assert.equal(state.createTransportCalls, 1, "两个对象只应自动建一个请求")
    assert.ok(r1.includes("REQ01"), r1)
    assert.ok(r2.includes("REQ01"), `第二个应复用 REQ01，实际: ${r2.slice(0, 120)}`)
    assert.equal(state.created[0].transport, "REQ01")
    assert.equal(state.created[1].transport, "REQ01")
  } finally { cleanup() }
})

test("createObjectTool：$TMP 不建请求", async () => {
  resetActiveRequests(); markConnectionUnhealthy("dev")
  const { client, state } = makeFakeClient()
  __setClientFactoryForTest(() => client)
  try {
    const r = await createObjectTool.execute({ objectType: "PROG/P", name: "ZTESTT1", description: "测试", packageName: "$TMP", connectionId: "dev" })
    assert.equal(state.createTransportCalls, 0, "$TMP 不应建请求")
    assert.ok(r.includes("$TMP"), r)
    assert.equal(state.created[0].transport, undefined)
  } finally { cleanup() }
})

test("createObjectTool：用户指定请求号则用它且后续对象复用", async () => {
  resetActiveRequests(); markConnectionUnhealthy("dev")
  const { client, state } = makeFakeClient()
  __setClientFactoryForTest(() => client)
  try {
    const base = { objectType: "PROG/P", description: "测试", packageName: "ZPKG", connectionId: "dev" }
    const r1 = await createObjectTool.execute({ ...base, name: "ZTESTB1", requestNumber: "DS4K000001" })
    const r2 = await createObjectTool.execute({ ...base, name: "ZTESTB2" })
    assert.equal(state.createTransportCalls, 0, "用户指定请求不应自动新建")
    assert.ok(r1.includes("DS4K000001"), r1)
    assert.ok(r2.includes("DS4K000001"), `第二个应复用用户指定请求，实际: ${r2.slice(0, 120)}`)
  } finally { cleanup() }
})

test("replaceStringTool：同需求修改多对象复用共享请求（只自动建一次）", async () => {
  resetActiveRequests(); markConnectionUnhealthy("dev")
  const content = "CLASS lcl_test DEFINITION.\n  DATA: lv_a TYPE i.\nENDCLASS.\n"
  const { client, state } = makeFakeClient()
  state.current = content
  __setClientFactoryForTest(() => client)
  try {
    const r1 = await replaceStringTool.execute({ fileUri: PROG_INCLUDE, oldString: "DATA: lv_a TYPE i.", newString: "DATA: lv_b TYPE i.", connectionId: "dev" })
    const r2 = await replaceStringTool.execute({ fileUri: PROG_INCLUDE, oldString: "DATA: lv_b TYPE i.", newString: "DATA: lv_a TYPE i.", connectionId: "dev" })
    assert.equal(state.createTransportCalls, 1, "两次修改只应自动建一个请求")
    assert.ok(r1.includes("REQ01"), r1)
    assert.ok(r2.includes("REQ01"), `第二个应复用 REQ01，实际: ${r2.slice(0, 120)}`)
  } finally { cleanup() }
})

test("replaceStringTool：$TMP 对象不建请求", async () => {
  resetActiveRequests(); markConnectionUnhealthy("dev")
  const { client, state } = makeFakeClient({ devclass: "$TMP" })
  state.current = "REPORT ztest1.\nDATA: lv_a TYPE i.\n"
  __setClientFactoryForTest(() => client)
  try {
    const r = await replaceStringTool.execute({ fileUri: PROG_INCLUDE, oldString: "DATA: lv_a TYPE i.", newString: "DATA: lv_b TYPE i.", connectionId: "dev" })
    assert.equal(state.createTransportCalls, 0, "$TMP 不应建请求")
    assert.ok(r.includes("$TMP"), r)
    assert.equal(state.savedTransport, undefined)
  } finally { cleanup() }
})

test("写授权（批准/取消）重置共享请求", async () => {
  resetActiveRequests()
  setActiveRequest("dev", "ZPKG", "REQ01")
  setWriteApprovalWindow(1000)
  assert.equal(getActiveRequest("dev", "ZPKG"), undefined, "批准（新需求开始）应清空共享请求")
  setActiveRequest("dev", "ZPKG", "REQ01")
  clearWriteApproval()
  assert.equal(getActiveRequest("dev", "ZPKG"), undefined, "取消（拒绝）应清空共享请求")
})
