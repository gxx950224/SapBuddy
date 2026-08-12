// 临时探针：验证"连接变更脏标记 + get_connected_systems 全连接独占"两个新机制
import { __setConfigForTest } from "../dist/sap-tools/config.js"
import {
  withAllConnMutex, withReadLock, withConnMutex,
  markConnectionDirty, isConnectionDirty, clearConnectionDirty,
} from "../dist/sap-tools/adtManager.js"
import { connectedSystemsTool } from "../dist/sap-tools/tools/connectedSystems.js"

__setConfigForTest({
  connections: [{ id: "dev", url: "https://x.invalid", client: "100", username: "u", password: "p", language: "ZH", authMethod: "basic" }],
  security: { readOnly: true },
})

let pass = 0, fail = 0
function assert(name, cond) {
  if (cond) { pass++; console.log("✔", name) }
  else { fail++; console.log("✘", name) }
}

// 1. 脏标记 打→查→清
markConnectionDirty()
assert("mark 后 isConnectionDirty=true", isConnectionDirty() === true)
clearConnectionDirty()
assert("clear 后 isConnectionDirty=false", isConnectionDirty() === false)

// 2. get_connected_systems 执行后清脏标记（类别查询失败也不影响清标记）
markConnectionDirty()
const result = await connectedSystemsTool.execute()
assert("get_connected_systems 成功返回连接清单", /可用 SAP 连接/.test(result))
assert("get_connected_systems 后脏标记被清", isConnectionDirty() === false)

// 3. 全连接独占：withAllConnMutex 运行期间，同一连接的读/写被阻塞（不重叠）
const log = []
const exclusive = withAllConnMutex(async () => {
  log.push("exclusive-start")
  await new Promise((r) => setTimeout(r, 250))
  log.push("exclusive-end")
})
const reader = withReadLock("dev", async () => {
  log.push("reader-start")
  await new Promise((r) => setTimeout(r, 10))
  log.push("reader-end")
})
const writer = withConnMutex("dev", async () => {
  log.push("writer-start")
  await new Promise((r) => setTimeout(r, 10))
  log.push("writer-end")
})
await Promise.all([exclusive, reader, writer])
console.log("  执行顺序:", JSON.stringify(log))
// 无重叠：exclusive 与 reader/writer 不能交错（exclusive-end 必须早于 reader-start，或 reader-end 早于 exclusive-start）
const iExS = log.indexOf("exclusive-start"), iExE = log.indexOf("exclusive-end")
const noOverlap = (iExE < log.indexOf("reader-start") && iExE < log.indexOf("writer-start")) ||
                  (log.indexOf("reader-end") < iExS && log.indexOf("writer-end") < iExS)
assert("withAllConnMutex 独占：期间无并发读/写", noOverlap)
// 且三者都执行完成
assert("读/写最终都完成（阻塞而非死锁）", log.includes("reader-end") && log.includes("writer-end"))

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
