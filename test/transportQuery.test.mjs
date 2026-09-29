import test from "node:test"
import assert from "node:assert/strict"
import { registerSapTools } from "../dist/sap-tools/register.js"
import { __setConfigForTest } from "../dist/sap-tools/config.js"
import { __setClientFactoryForTest, markConnectionUnhealthy } from "../dist/sap-tools/adtManager.js"

test("对象多请求查询不超过 SAP SQL 行长；查询失败必须返回错误状态", async t => {
  const id = "transport-query-fixture"
  const ids = Array.from({ length: 50 }, (_, i) => `DS4K${String(940000 + i)}`)
  let failure = false
  let e070Calls = 0
  __setConfigForTest({ connections: [{ id, client: "100", username: "fixture", url: "https://fixture.invalid" }] })
  __setClientFactoryForTest(() => ({
    login: async () => {},
    searchObject: async () => [{ "adtcore:name": "ZAIR004", "adtcore:type": "PROG/P", "adtcore:uri": "/sap/bc/adt/programs/programs/zair004" }],
    transportInfo: async () => ({}),
    transportDetails: async () => ({ objects: [] }),
    runQuery: async sql => {
      if (failure) throw new Error("fixture SQL unavailable")
      if (sql.includes("FROM E071")) return { values: ids.map(TRKORR => ({ TRKORR })) }
      e070Calls++
      assert.ok(sql.split("\n").every(line => line.length <= 255), "long SQL lines fail on the live ADT runner")
      for (const id of ids) assert.ok(sql.includes(`'${id}'`))
      return { values: ids.map(TRKORR => ({ TRKORR, TRSTATUS: "D" })) }
    },
  }))
  t.after(() => { __setConfigForTest(null); __setClientFactoryForTest(null); markConnectionUnhealthy(id) })
  const tools = new Map()
  registerSapTools({ registerTool: tool => tools.set(tool.name, tool) })
  const execute = args => tools.get("manage_transport_requests").execute("fixture", args)
  const args = { action: "get_object_transport", objectName: "ZAIR004", objectType: "PROG" }
  const success = await execute(args)
  assert.notEqual(success.isError, true)
  assert.equal(e070Calls, 1)
  for (const id of ids) assert.ok(success.content[0].text.includes(id))
  failure = true
  for (const input of [args, { action: "get_transport_details", transportNumber: ids[0] }]) {
    const failed = await execute(input)
    assert.equal(failed.isError, true)
    assert.match(failed.content[0].text, /查询失败/)
  }
})
