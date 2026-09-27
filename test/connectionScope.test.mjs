import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { __setConfigForTest } from "../dist/sap-tools/config.js"
import { resolveConnectionId } from "../dist/sap-tools/tools/shared.js"
import { registerSapTools } from "../dist/sap-tools/register.js"
import { connectedSystemsTool } from "../dist/sap-tools/tools/connectedSystems.js"
import { clearConnectionDirty } from "../dist/sap-tools/adtManager.js"

test("SAP tools remain bound to the selected system, including discovery", async t => {
  let foreignRequests = 0
  const server = http.createServer((_req, res) => { foreignRequests++; res.writeHead(503); res.end() })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => { __setConfigForTest(null); server.closeAllConnections(); server.close() })
  const config = { security: { readOnly: true }, connections: [
    { id: "dev", url: `http://127.0.0.1:${server.address().port}`, client: "100", username: "fixture", password: "fixture" },
    { id: "prod", active: true, url: "https://scope-test.invalid", client: "300", username: "fixture", password: "fixture" },
  ] }
  __setConfigForTest(config)
  clearConnectionDirty()
  assert.equal(await resolveConnectionId(), "prod")
  assert.equal(await resolveConnectionId("PROD"), "prod")
  await assert.rejects(resolveConnectionId("dev"), /连接范围拦截/)
  const registered = new Map()
  registerSapTools({ registerTool: tool => registered.set(tool.name, tool) })
  for (const name of ["search_abap_objects", "abap_activate"]) {
    const result = await registered.get(name).execute("fixture", { connectionId: "dev", objectName: "ZTEST" })
    assert.match(result.content[0].text, /连接范围拦截/)
  }
  const discovery = await connectedSystemsTool.execute()
  assert.match(discovery, /prod/)
  assert.equal(discovery.includes(config.connections[0].url), false)
  assert.equal(foreignRequests, 0, "discovery and denied operations must not contact the inactive system")
  config.connections[0].active = true
  config.connections[1].active = false
  __setConfigForTest(config)
  assert.equal(await resolveConnectionId(), "dev")
  await assert.rejects(resolveConnectionId("prod"), /连接范围拦截/)
})
