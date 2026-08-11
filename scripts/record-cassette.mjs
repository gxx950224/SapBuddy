#!/usr/bin/env node
/**
 * 真机会话录制：对真实 SAP 跑一次 get_abap_object_lines，把「方法+参数+结果」调用序列
 * 录成 JSONL，供 test/cassette.test.mjs 离线回放（回放不连任何真实系统）。
 *
 * 用法（在项目根目录）：
 *   node scripts/record-cassette.mjs <对象名> [对象类型] [连接ID] [输出路径]
 *   例：node scripts/record-cassette.mjs ZMMR017 PROG dev test/fixtures/cassette-sample.jsonl
 *
 * 输出路径省略时写到 ./cassette/<对象名>.jsonl。
 * 若 SAP 使用自签证书 https，可临时 NODE_TLS_REJECT_UNAUTHORIZED=0 运行（仅本机录制用）。
 */
import { createRequire } from "node:module"
import { join } from "node:path"

const require = createRequire(import.meta.url)
const { ADTClient } = require("abap-adt-api")
const { __setClientFactoryForTest } = require("../dist/sap-tools/adtManager.js")
const { getObjectLinesTool } = require("../dist/sap-tools/tools/getObjectLines.js")
const { makeRecordingClient } = await import("../test/cassette-client.mjs")

const name = process.argv[2]
if (!name) {
  console.error("用法: node scripts/record-cassette.mjs <对象名> [对象类型] [连接ID] [输出路径]")
  process.exit(1)
}
const type = process.argv[3] ?? "PROG"
const connId = process.argv[4]
const outPath = process.argv[5] ?? join(process.cwd(), "cassette", `${name.toUpperCase()}.jsonl`)

// 工厂被 getClient 调用：构造真实客户端并包一层录制代理。
// login() 真实执行但不会被写入 cassette（回放侧恒为 no-op），避免把登录时序带进录制。
__setClientFactoryForTest((conf) => {
  const real = new ADTClient(conf.url, conf.username, conf.password, conf.client, conf.language, {
    timeout: 120_000,
  })
  return makeRecordingClient(real, outPath)
})

console.log(`== 录制到 ${outPath} ==`)
const out = await getObjectLinesTool.execute({ objectName: name, objectType: type, connectionId: connId })
console.log(out.slice(0, 400))
console.log("\n== 完成。可用 test/cassette.test.mjs 离线回放。==")
process.exit(0)
