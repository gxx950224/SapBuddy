import test from "node:test"
import assert from "node:assert/strict"
import { registerQuestionTool } from "../src/question-tool.mjs"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"

test("ask_user returns an unanswered question and supports free text without choices", async () => {
  let tool
  registerQuestionTool({ registerTool(value) { tool = value } })
  assert.equal(tool.name, "ask_user")
  const result = await tool.execute("q1", { question: "选择方案", options: ["A", "B"], allowCustom: false })
  const data = JSON.parse(result.content[0].text)
  assert.equal(data.status, "awaiting_user")
  assert.equal(data.allowCustom, false)
  assert.equal(data.answer, undefined)
  const freeText = await tool.execute("q2", { question: "程序名称？", options: [], allowCustom: false })
  assert.equal(JSON.parse(freeText.content[0].text).allowCustom, true)
})

test("ask_user stops the real Agent loop and the next user message resumes normally", async () => {
  const sdkRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))
  const { Agent } = await import(new URL("./dist/index.js", pathToFileURL(sdkRequire.resolve("@earendil-works/pi-agent-core/package.json"))))
  let tool
  registerQuestionTool({ registerTool(value) { tool = value } })
  let requests = 0
  const agent = new Agent({
    initialState: { model: { id: "fixture", provider: "fixture", api: "openai-completions" }, tools: [tool] },
    streamFn: () => {
      requests++
      const message = { role: "assistant", timestamp: Date.now(),
        content: requests === 1 ? [{ type: "toolCall", id: "q1", name: "ask_user", arguments: { question: "选择方案", options: ["A", "B"] } }] : [{ type: "text", text: "收到答案" }],
        stopReason: requests === 1 ? "toolUse" : "stop" }
      return { async *[Symbol.asyncIterator]() { yield { type: "done", message } }, result: async () => message }
    },
  })
  const events = []
  agent.subscribe(event => events.push(event))
  await agent.prompt("请提问")
  assert.equal(requests, 1, "must not request the model again after asking")
  assert.equal(agent.state.messages.at(-1).role, "toolResult")
  assert.equal(events.at(-1).type, "agent_end")
  await agent.prompt("A")
  assert.equal(requests, 2)
  assert.equal(agent.state.messages.at(-1).content[0].text, "收到答案")
})
