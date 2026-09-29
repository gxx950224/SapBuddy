import test from "node:test"
import assert from "node:assert/strict"
import { registerWriteApprovalTool } from "../src/write-approval-tool.mjs"

test("request_write_approval presents a card and ends the turn without attempting a write", async () => {
  let tool
  const requests = []
  registerWriteApprovalTool({ registerTool(value) { tool = value } }, (info) => requests.push(info))

  const diff = "--- a/ZAIR004\n+++ b/ZAIR004\n@@ -3 +3 @@\n-* aaaa\n+* aa"
  const result = await tool.execute("approval-1", { objectName: "ZAIR004", summary: "第 3 行修改注释，验证后回滚", diff })
  assert.equal(tool.name, "request_write_approval")
  assert.equal(result.terminate, true)
  assert.equal(JSON.parse(result.content[0].text).status, "awaiting_user")
  assert.deepEqual(requests, [{
    toolCallId: "approval-1",
    toolName: "request_write_approval",
    input: { name: "ZAIR004", summary: "第 3 行修改注释，验证后回滚", diff },
    preflight: true,
  }])
})

test("request_write_approval refuses a plan without a reviewable diff", async () => {
  let tool
  let requested = false
  registerWriteApprovalTool({ registerTool(value) { tool = value } }, () => { requested = true })
  const result = await tool.execute("approval-2", { objectName: "ZAIR004", summary: "修改注释", diff: "稍后再展示差异" })
  assert.equal(result.isError, true)
  assert.equal(requested, false)
})
