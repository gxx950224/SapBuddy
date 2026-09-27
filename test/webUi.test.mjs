import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// Optional browser suite: point SAPBUDDY_PLAYWRIGHT at playwright/index.mjs.
test("Web streaming, pagination and message identity in a real browser", { skip: !process.env.SAPBUDDY_PLAYWRIGHT }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.SAPBUDDY_PLAYWRIGHT).href)
  const root = fileURLToPath(new URL("../src/web/public/", import.meta.url))
  const clients = new Set()
  const timestamp = Date.now()
  const chatRequests = []
  const settingsWrites = []
  const sapConfigWrites = []
  const outputPreviewRequests = []
  const apiReads = []
  let nextChatStatus = 200
  const message = (role, text, time) => ({ role, content: [{ type: "text", text }], timestamp: time })
  let history = { messages: [], before: null, userOffset: 0 }
  let posted
  let deletedRequest
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost")
    if (req.method === "GET" && url.pathname.startsWith("/api/")) apiReads.push(url.pathname)
    if (url.pathname === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(": connected\n\n")
      clients.add(res); req.on("close", () => clients.delete(res)); return
    }
    if (url.pathname.startsWith("/api/output-files/") && req.method === "GET") {
      const name = decodeURIComponent(url.pathname.slice("/api/output-files/".length))
      outputPreviewRequests.push(name)
      const files = {
        "docs/guide.txt": { type: "text/plain; charset=utf-8", body: "普通文本 <script>必须作为文本显示</script>" },
        "docs/guide.md": { type: "text/markdown; charset=utf-8", body: "# 预览标题\n\n**加粗内容**" },
        "reports/preview.html": { type: "text/html; charset=utf-8", body: "<!doctype html><title>HTML 预览</title><p>隔离的 HTML 报告</p>" },
      }
      const file = files[name]
      if (!file) { res.writeHead(404); res.end("not found"); return }
      res.writeHead(200, { "Content-Type": file.type })
      res.end(file.body)
      return
    }
    if (url.pathname.startsWith("/api/")) {
      let data = {}
      if (url.pathname === "/api/settings" && req.method === "GET") {
        data = { provider: "deepseek", model: "deepseek-flash", apiKey: "fixture-secret-key", providers: [{ name: "deepseek", hasKey: true, models: ["deepseek-flash", "deepseek-chat"] }] }
      }
      if (url.pathname === "/api/settings" && req.method === "POST") {
        let body = ""; for await (const chunk of req) body += chunk
        settingsWrites.push(JSON.parse(body))
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ success: true, keyValid: true }))
        return
      }
      if (url.pathname === "/api/sap-config" && req.method === "POST") sapConfigWrites.push("sap-config")
      if (url.pathname === "/api/output-tree") data = { tree: [
        { type: "dir", name: "docs", path: "docs", children: [
          { type: "file", name: "guide.txt", path: "docs/guide.txt" },
          { type: "file", name: "guide.md", path: "docs/guide.md" },
        ] },
        { type: "dir", name: "reports", path: "reports", children: [
          { type: "file", name: "preview.html", path: "reports/preview.html" },
          { type: "file", name: "summary.pdf", path: "reports/summary.pdf" },
        ] },
      ] }
      if (url.pathname === "/api/mcp") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ success: true, config: { "fixture-server": { type: "streamable-http", url: "https://fixture.invalid/mcp" } }, status: [] }))
        return
      }
      if (url.pathname === "/api/memory" && req.method === "GET") data = { content: "# 测试记忆", path: "fixture/Memory.md" }
      if (url.pathname === "/api/skills" && req.method === "GET") data = url.searchParams.has("file")
        ? { content: "# 测试技能", path: url.searchParams.get("file") }
        : { tree: [{ type: "dir", name: "fixture-skill", path: "fixture-skill", children: [
          { type: "file", name: "SKILL.md", path: "fixture-skill/SKILL.md" },
        ] }] }
      if (url.pathname === "/api/prompt" && req.method === "GET") {
        const file = url.searchParams.get("file") || "AGENTS.md"
        data = { content: file === "SYSTEM.md" ? "# 系统提示词" : "# Agent 提示词", path: file }
      }
      if (url.pathname === "/api/update/check" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ success: true, current: "2.8.3-test", latest: "2.8.3-test", hasUpdate: false }))
        return
      }
      if (url.pathname === "/api/sap-config" && req.method === "GET") data = { readOnly: true, connections: [
        { id: "fixture-dev", name: "测试开发连接", host: "sap.fixture.invalid", port: "44300", protocol: "https", user: "fixture-user", client: "100", active: true, hasPassword: true },
      ] }
      if (url.pathname === "/api/chat") {
        let body = ""; for await (const chunk of req) body += chunk
        chatRequests.push(JSON.parse(body))
        res.writeHead(nextChatStatus, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ success: nextChatStatus < 400, error: nextChatStatus >= 400 ? "fixture failure" : undefined }))
        nextChatStatus = 200
        return
      }
      if (url.pathname === "/api/upload") {
        let body = ""; for await (const chunk of req) body += chunk
        const upload = JSON.parse(body)
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ success: true, path: `uploads/${upload.name}`, name: upload.name, isOffice: false }))
        return
      }
      if (url.pathname === "/api/history") data = url.searchParams.has("before") ? {
        messages: [message("user", "更早的问题", timestamp - 10), message("assistant", "更早的答复", timestamp - 9)], userOffset: 0, before: null, path: "fixture.jsonl"
      } : history
      if (url.pathname === "/api/sessions") {
        const offset = Number(url.searchParams.get("offset") || 0)
        const all = Array.from({ length: 1000 }, (_, i) => ({ path: `session-${i}.jsonl`, name: `测试会话 ${i}`, firstMessage: `测试会话 ${i}`, modified: timestamp, messageCount: 2 }))
        const filtered = all.filter(s => s.name.includes(url.searchParams.get("q") || ""))
        data = { sessions: filtered.slice(offset, offset + 50), total: filtered.length, nextOffset: offset + 50 < filtered.length ? offset + 50 : null }
      }
      if (url.pathname === "/api/state") data = { ready: true, isStreaming: false }
      if (url.pathname === "/api/session/truncate") {
        let body = ""; for await (const chunk of req) body += chunk
        posted = JSON.parse(body)
      }
      if (url.pathname === "/api/session/delete-messages") {
        let body = ""; for await (const chunk of req) body += chunk
        deletedRequest = JSON.parse(body)
      }
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ success: true, data, required: false })); return
    }
    try {
      const file = path.join(root, url.pathname === "/" ? "index.html" : url.pathname)
      const mime = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml" }
      res.writeHead(200, { "Content-Type": mime[path.extname(file)] || "text/plain" })
      res.end(await fs.readFile(file))
    } catch { res.writeHead(404); res.end() }
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => { for (const res of clients) res.end(); server.closeAllConnections(); server.close() })
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.SAPBUDDY_CHROMIUM_PATH ? { executablePath: process.env.SAPBUDDY_CHROMIUM_PATH } : {}),
  })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  const measurementsMs = {}
  page.on("pageerror", e => errors.push(e.message))
  const capture = async name => {
    if (!process.env.SAPBUDDY_SCREENSHOT_DIR) return
    await page.evaluate(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))
    })
    await fs.mkdir(process.env.SAPBUDDY_SCREENSHOT_DIR, { recursive: true })
    await page.screenshot({ path: path.join(process.env.SAPBUDDY_SCREENSHOT_DIR, `${name}.png`), fullPage: true })
  }
  await page.route("https://**", route => route.abort())
  await page.route("https://fonts.googleapis.com/**", route => route.fulfill({ status: 200, contentType: "text/css", body: "" }))
  const firstScreenStarted = performance.now()
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "domcontentloaded" })
  measurementsMs.domContentLoaded = Number((performance.now() - firstScreenStarted).toFixed(2))
  await page.waitForSelector(".chat-welcome")
  measurementsMs.welcomeRendered = Number((performance.now() - firstScreenStarted).toFixed(2))
  await page.waitForFunction(() => document.querySelectorAll(".session-item").length === 50)
  measurementsMs.firstScreenWithFirstSessionPage = Number((performance.now() - firstScreenStarted).toFixed(2))
  assert.equal(await page.locator(".session-item").count(), 50)
  const nextSessionPageStarted = performance.now()
  await page.locator("#session-list .load-more").click()
  await page.waitForFunction(() => document.querySelectorAll(".session-item").length === 100)
  measurementsMs.nextSessionPage = Number((performance.now() - nextSessionPageStarted).toFixed(2))
  assert.equal(await page.locator(".session-item").count(), 100)
  const searchStarted = performance.now()
  await page.locator("#sidebar-search").fill("测试会话 999")
  await page.waitForFunction(() => document.querySelectorAll(".session-item").length === 1)
  measurementsMs.globalSessionSearch = Number((performance.now() - searchStarted).toFixed(2))

  const broadcast = payload => { for (const res of clients) res.write(`data: ${JSON.stringify(payload)}\n\n`) }
  const emit = event => broadcast({ kind: "agent", event })
  emit({ type: "agent_start" })
  const base = { role: "assistant", timestamp }
  emit({ type: "message_start", message: { ...base, content: [] } })
  emit({ type: "message_update", message: { ...base, content: [{ type: "thinking", thinking: "正在分析需求" }] } })
  await page.waitForSelector(".bu-thinking .bui-shimmer")
  assert.equal(await page.locator(".bui-variants").count(), 0)
  assert.equal(await page.locator(".bui-trace-shell[data-variant='Reasoning']").count(), 1)
  await capture("thinking-loading")
  const firstReplyStarted = performance.now()
  emit({ type: "message_update", message: { ...base, content: [{ type: "text", text: "最初" }] } })
  await page.waitForSelector(".reply-text")
  measurementsMs.firstStreamedReply = Number((performance.now() - firstReplyStarted).toFixed(2))
  emit({ type: "message_update", message: { ...base, content: [{ type: "text", text: "修正" }] } })
  await page.waitForFunction(() => document.querySelector(".reply-text")?.textContent === "修正")
  emit({ type: "message_update", message: { ...base, content: [{ type: "text", text: "这是一段较长的临时回复" }] } })
  await page.waitForFunction(() => document.querySelector(".reply-text")?.textContent === "这是一段较长的临时回复")
  emit({ type: "message_update", message: { ...base, content: [{ type: "text", text: "短" }] } })
  await page.waitForFunction(() => document.querySelector(".reply-text")?.textContent === "短")
  emit({ type: "message_update", message: { ...base, content: [{ type: "text", text: "```abap\nWRITE 'partial'." }] } })
  await page.waitForSelector(".bu-code-line code")
  const body = "说明\n\n```abap\nWRITE 'hello'.\n```\n\n| 字段 | 值 |\n| --- | --- |\n| A | B |"
  const parts = [{ type: "text", text: body }, { type: "thinking", thinking: "检查程序上下文并读取对象" }, { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "demo.abap" } }]
  emit({ type: "message_update", message: { ...base, content: parts } })
  emit({ type: "message_end", message: { ...base, content: parts } })
  emit({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: { path: "demo.abap" } })
  await page.waitForFunction(() => document.querySelector(".bu-tool")?.classList.contains("running"))
  await capture("tool-running")
  emit({ type: "tool_execution_end", toolCallId: "tool-1", result: { content: [{ type: "text", text: "完成" }] } })
  await page.waitForSelector(".reply-text table")
  assert.equal(await page.locator(".bu-code-line code").textContent(), "WRITE 'hello'.")
  assert.equal(await page.locator(".bu-tool").count(), 1)
  await page.locator(".bu-tool-group > summary").click()
  await page.waitForFunction(() => document.querySelector(".bu-tool-group")?.open === false)
  emit({ type: "tool_execution_end", toolCallId: "tool-1", result: { content: [{ type: "text", text: "更新的结果" }] } })
  await page.waitForTimeout(40)
  assert.equal(await page.locator(".bu-tool-group").evaluate(el => el.open), false)
  await page.locator(".bu-tool-group > summary").click()
  assert.equal(await page.locator(".bu-thinking").count(), 1)
  assert.equal(await page.locator(".reply-text").count(), 1)
  assert.equal(await page.locator(".msg.agent .msg-action-btn svg").count(), 3)
  // Final-only content must render even without a preceding delta.
  emit({ type: "message_start", message: { role: "assistant", timestamp: timestamp + 1, content: [] } })
  emit({ type: "message_end", message: message("assistant", "最终答案", timestamp + 1) })
  emit({ type: "agent_end" })
  await page.waitForFunction(() => document.querySelectorAll(".reply-text").length === 2)
  assert.equal(await page.locator(".reply-text").last().textContent(), "最终答案")
  assert.equal(await page.locator(".bu-thinking").evaluate(el => el.open), false)
  await page.locator(".bu-thinking > summary").click()
  await page.waitForFunction(() => document.querySelector(".bu-thinking")?.open === true)
  await capture("thinking-expanded")
  assert.ok((await page.locator(".bui-reasoning-row").textContent()).includes("检查程序上下文"))
  await page.locator(".bu-thinking > summary").click()
  await page.waitForFunction(() => document.querySelector(".bu-thinking")?.open === false)
  assert.equal(await page.locator(".msg.agent").count(), 1)
  assert.equal(await page.locator(".bu-tool-group").evaluate(el => el.open), false)
  await page.locator(".bu-tool-group > summary").click()
  await page.locator(".bu-tool > summary").waitFor({ state: "visible" })
  await page.locator(".bu-tool > summary").focus()
  await page.keyboard.press("Enter")
  await page.waitForFunction(() => document.querySelector(".bu-tool")?.open === true)
  assert.equal(await page.locator(".bu-tool").getAttribute("open"), "")
  const input = page.locator("#input")
  await input.fill("输入法组合中")
  await input.evaluate(element => element.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Enter", code: "Enter", keyCode: 229, isComposing: true, bubbles: true, cancelable: true,
  })))
  assert.equal(chatRequests.length, 0)
  assert.equal(await input.inputValue(), "输入法组合中")
  await input.fill("")
  await page.locator("#model-select-btn").click()
  await page.locator("#model-dropdown .dropdown-item").filter({ hasText: "deepseek-chat" }).click()
  await page.waitForFunction(() => document.querySelector("#model-select-btn .model-name")?.textContent === "deepseek-chat")
  await page.locator(".reply-text").first().evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    const textNode = walker.nextNode()
    const selection = window.getSelection()
    const range = document.createRange()
    range.setStart(textNode, 0)
    range.setEnd(textNode, Math.min(2, textNode.textContent.length))
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 200, clientY: 300 }))
  })
  await page.waitForSelector(".bu-selection-actions")
  await page.locator(".bu-selection-actions").getByRole("button", { name: "解释" }).click()
  assert.match(await input.inputValue(), /^请解释以下 ABAP 内容：/)
  await input.fill("")

  await page.locator("#file-input").setInputFiles({ name: "readme.txt", mimeType: "text/plain", buffer: Buffer.from("fixture attachment") })
  await page.waitForFunction(() => document.querySelector("#attachments .attach-chip")?.textContent.includes("readme.txt"))
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/SxsAAAAASUVORK5CYII="
  await input.evaluate((element, base64) => {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0))
    const file = new File([bytes], "pasted.png", { type: "image/png" })
    const item = { kind: "file", type: "image/png", getAsFile: () => file }
    const event = new Event("paste", { bubbles: true, cancelable: true })
    Object.defineProperty(event, "clipboardData", { value: { items: [item] } })
    element.dispatchEvent(event)
  }, png)
  await page.waitForSelector("#images .img-chip img")
  await input.fill("分析这个文件")
  const chatResponse = page.waitForResponse(response => response.url().endsWith("/api/chat"))
  await page.locator("#send-btn").click()
  await chatResponse
  await page.waitForFunction(() => document.querySelectorAll("#attachments .attach-chip").length === 0 && document.querySelectorAll("#images .img-chip").length === 0)
  assert.match(chatRequests.at(-1).text, /uploads\/readme\.txt/)
  assert.equal(chatRequests.at(-1).images.length, 1)

  // Output file preview covers plain text escaping, Markdown, sandboxed HTML, and binary guidance.
  await page.locator("#file-list .skill-tree-dir").filter({ hasText: "docs" }).click()
  await page.locator("#file-list .skill-tree-dir").filter({ hasText: "reports" }).click()
  await page.waitForSelector('[data-name="docs/guide.txt"]')
  await page.locator('[data-name="docs/guide.txt"]').click()
  await page.waitForFunction(() => document.querySelector("#preview-body")?.textContent.includes("必须作为文本显示"))
  assert.equal(await page.locator("#preview-body script").count(), 0)
  await page.locator("#preview-close").click()
  await page.locator('[data-name="docs/guide.md"]').click()
  await page.waitForSelector("#preview-body.md-preview h1")
  assert.equal(await page.locator("#preview-body h1").textContent(), "预览标题")
  assert.equal(await page.locator("#preview-body strong").textContent(), "加粗内容")
  await page.locator("#preview-close").click()
  await page.locator('[data-name="reports/preview.html"]').click()
  await page.waitForFunction(() => document.querySelector("#preview-dialog")?.classList.contains("html-mode"))
  await page.waitForFunction(() => document.querySelector("#preview-frame")?.contentDocument?.body?.textContent.includes("隔离的 HTML 报告"))
  assert.equal(await page.locator("#preview-open-external").isVisible(), true)
  assert.match(await page.locator("#preview-open-external").getAttribute("href"), /reports%2Fpreview\.html/)
  await page.locator("#preview-close").click()
  assert.match(await page.locator("#preview-frame").getAttribute("src"), /about:blank/)
  const previewCountBeforeBinary = outputPreviewRequests.length
  await page.locator('[data-name="reports/summary.pdf"]').click()
  await page.waitForFunction(() => document.querySelector("#preview-body")?.textContent.includes("二进制格式"))
  assert.equal(outputPreviewRequests.length, previewCountBeforeBinary)
  assert.equal(await page.locator("#preview-body").getByRole("button", { name: "打开位置查看" }).count(), 1)
  await page.locator("#preview-close").click()

  // Settings render configured values, load the SAP connection list without its password, and save only via the fixture API.
  settingsWrites.length = 0 // Ignore the composer model selection exercised earlier in this browser session.
  apiReads.length = 0
  await page.locator("#sidebar-settings").click()
  await page.waitForFunction(() => document.querySelector("#settings-overlay")?.classList.contains("open"))
  await page.waitForFunction(() => document.querySelector("#llm-model")?.value === "deepseek-flash")
  assert.equal(await page.locator("#llm-provider").inputValue(), "deepseek")
  for (const endpoint of ["/api/mcp", "/api/memory", "/api/skills", "/api/sap-config"]) assert.equal(apiReads.includes(endpoint), false, `unexpected eager request: ${endpoint}`)
  assert.equal(await page.locator("#llm-key").getAttribute("type"), "password")
  await page.locator("#llm-model").selectOption("deepseek-chat")
  await page.locator("#settings-save").click()
  await page.waitForFunction(() => !document.querySelector("#settings-overlay")?.classList.contains("open"))
  assert.equal(settingsWrites.length, 1, JSON.stringify(settingsWrites))
  assert.equal(settingsWrites[0].provider, "deepseek")
  assert.equal(settingsWrites[0].model, "deepseek-chat")
  assert.equal(settingsWrites[0].apiKey, "fixture-secret-key")
  await page.locator("#sidebar-settings").click()
  await page.waitForFunction(() => document.querySelector("#settings-overlay")?.classList.contains("open"))
  await page.locator('.settings-tab[data-tab="sap"]').click()
  await page.waitForSelector(".conn-row")
  assert.match(await page.locator(".conn-row").textContent(), /测试开发连接/)
  await page.locator('.conn-row button[data-act="edit"]').click()
  assert.equal(await page.locator("#sap-password").inputValue(), "")
  assert.match(await page.locator("#sap-password").getAttribute("placeholder"), /密码已配置/)
  await page.locator("#sap-cancel").click()

  await page.locator('.settings-tab[data-tab="mcp"]').click()
  await page.waitForFunction(() => document.querySelector("#mcp-config")?.value.includes("fixture-server"))
  await page.locator('[data-mcp-mode="json"]').click()
  assert.notEqual(await page.locator("#mcp-json-mode").evaluate(element => getComputedStyle(element).display), "none")
  await page.locator('[data-mcp-mode="visual"]').click()

  await page.locator('.settings-tab[data-tab="memory"]').click()
  await page.waitForFunction(() => document.querySelector("#memory-preview h1")?.textContent === "测试记忆")
  await page.locator('.settings-tab[data-tab="skills"]').click()
  await page.locator("#skill-tree .skill-tree-dir").filter({ hasText: "fixture-skill" }).click()
  await page.locator('#skill-tree .skill-tree-file[data-path="fixture-skill/SKILL.md"]').click()
  await page.waitForFunction(() => document.querySelector("#skill-preview h1")?.textContent === "测试技能")

  await page.locator('.settings-tab[data-tab="prompts"]').click()
  await page.waitForFunction(() => document.querySelector("#prompt-preview h1")?.textContent === "Agent 提示词")
  await page.locator('.prompt-subtab[data-prompt="SYSTEM.md"]').click()
  await page.waitForFunction(() => document.querySelector("#prompt-preview h1")?.textContent === "系统提示词")

  await page.locator('.settings-tab[data-tab="about"]').click()
  await page.waitForFunction(() => document.querySelector("#about-current")?.textContent === "2.8.3-test")
  await page.locator("#settings-close").click()
  await page.waitForFunction(() => !document.querySelector("#settings-overlay")?.classList.contains("open"))
  assert.deepEqual(sapConfigWrites, [])

  emit({ type: "agent_end" })
  if (process.env.SAPBUDDY_SCREENSHOT) await page.screenshot({ path: process.env.SAPBUDDY_SCREENSHOT, fullPage: true })

  // Approval buttons submit directly and update only their associated card.
  broadcast({ kind: "write_approval_required", id: "approval-one", toolCallId: "blocked-one", toolName: "write_program", input: { name: "ZFIRST", password: "must not render", nested: { api_key: "also hidden" } } })
  await page.waitForSelector('[data-cid="approval:approval-one"]')
  const firstApproval = page.locator('[data-cid="approval:approval-one"]')
  await page.waitForTimeout(100)
  const approvalBounds = await page.evaluate(() => {
    const card = document.querySelector('[data-cid="approval:approval-one"]')
    const messages = document.querySelector("#messages")
    return { cardBottom: card.getBoundingClientRect().bottom, messagesBottom: messages.getBoundingClientRect().bottom,
      scrollTop: messages.scrollTop, scrollHeight: messages.scrollHeight, clientHeight: messages.clientHeight }
  })
  assert.ok(approvalBounds.cardBottom <= approvalBounds.messagesBottom + 1, JSON.stringify(approvalBounds))
  await capture("approval-pending")
  assert.equal(await firstApproval.textContent().then(text => text.includes("must not render")), false)
  assert.equal(await firstApproval.textContent().then(text => text.includes("also hidden")), false)
  await firstApproval.getByRole("button", { name: "确认并发送" }).click()
  await page.waitForFunction(() => document.querySelector('[data-cid="approval:approval-one"] .bu-approval-status')?.textContent === "确认词已发送，等待 Agent 校验")
  assert.equal(chatRequests.at(-1).text, "确认")
  assert.deepEqual(await page.evaluate(() => window.SapBuddy.chatView.submitApproval("确认", window.SapBuddy.state.currentPath)), [])
  emit({ type: "tool_execution_start", toolCallId: "execute-one", toolName: "write_program", args: { name: "ZFIRST", password: "must not render", nested: { api_key: "also hidden" } } })
  await page.waitForFunction(() => document.querySelector('[data-cid="approval:approval-one"] .bu-approval-status')?.textContent === "后端已放行，工具正在执行")
  await capture("approval-executing")
  emit({ type: "tool_execution_end", toolCallId: "execute-one", result: { content: [{ type: "text", text: "完成" }] } })
  await page.waitForFunction(() => document.querySelector('[data-cid="approval:approval-one"] .bu-approval-status')?.textContent === "工具执行完成")
  emit({ type: "agent_end" })

  // Identical tool names are associated by sanitized input, not all updated together.
  broadcast({ kind: "write_approval_required", id: "approval-two", toolCallId: "blocked-two", toolName: "write_program", input: { name: "ZFIRST" } })
  broadcast({ kind: "write_approval_required", id: "approval-three", toolCallId: "blocked-three", toolName: "write_program", input: { name: "ZSECOND" } })
  await page.waitForSelector('[data-cid="approval:approval-three"]')
  await page.evaluate(() => {
    for (const id of ["approval-two", "approval-three"]) {
      window.SapBuddy.chatView.updateApproval(id, "submitted")
    }
  })
  emit({ type: "tool_execution_start", toolCallId: "execute-two", toolName: "write_program", args: { name: "ZSECOND" } })
  await page.waitForFunction(() => document.querySelector('[data-cid="approval:approval-three"] .bu-approval-status')?.textContent === "后端已放行，工具正在执行")
  assert.equal(await page.locator('[data-cid="approval:approval-two"] .bu-approval-status').textContent(), "确认词已发送，等待 Agent 校验")
  emit({ type: "tool_execution_end", toolCallId: "execute-two", result: { content: [{ type: "text", text: "完成" }] } })
  emit({ type: "tool_execution_start", toolCallId: "execute-two-a", toolName: "write_program", args: { name: "ZFIRST" } })
  await page.waitForFunction(() => document.querySelector('[data-cid="approval:approval-two"] .bu-approval-status')?.textContent === "后端已放行，工具正在执行")
  emit({ type: "tool_execution_end", toolCallId: "execute-two-a", result: { content: [{ type: "text", text: "完成" }] } })
  emit({ type: "tool_execution_end", toolCallId: "execute-two", result: { content: [{ type: "text", text: "完成" }] } })
  await page.waitForFunction(() => document.querySelector('[data-cid="approval:approval-two"] .bu-approval-status')?.textContent === "工具执行完成" && document.querySelector('[data-cid="approval:approval-three"] .bu-approval-status')?.textContent === "工具执行完成")
  assert.equal(await page.locator('[data-cid="approval:approval-two"] .bu-approval-status').textContent(), "工具执行完成")

  const questionArgs = { question: "选择一个选项", options: ["选项 A", "选项 B", "选项 C"], allowCustom: true }
  emit({ type: "agent_start" })
  emit({ type: "message_start", message: { role: "assistant", timestamp: timestamp + 50, content: [] } })
  emit({ type: "message_end", message: { role: "assistant", timestamp: timestamp + 50, content: [{ type: "toolCall", id: "question-one", name: "ask_user", arguments: questionArgs }] } })
  emit({ type: "tool_execution_start", toolCallId: "question-one", toolName: "ask_user", args: questionArgs })
  emit({ type: "tool_execution_end", toolCallId: "question-one", result: { content: [{ type: "text", text: "等待用户回答" }] } })
  emit({ type: "agent_end" })
  await page.waitForSelector('[data-cid="approval:question-one"]')
  const question = page.locator('[data-cid="approval:question-one"]')
  await question.getByRole("radio", { name: "选项 A" }).check()
  assert.equal(await question.locator(".bu-approval-status").count(), 0)
  await capture("question-card")
  await page.setViewportSize({ width: 390, height: 844 })
  await question.scrollIntoViewIfNeeded()
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
  await capture("question-narrow")
  await page.setViewportSize({ width: 1440, height: 1000 })
  await question.getByRole("button", { name: "发送答案", exact: true }).click()
  await page.waitForFunction(() => [...window.SapBuddy.chatView.getSnapshot().items.values()].find(x => x.id === "approval:question-one")?.status === "complete")
  assert.equal(await question.count(), 0)
  emit({ type: "agent_end" })
  history = { path: "fixture.jsonl", messages: [message("user", "帮助我选择", timestamp),
    { role: "assistant", timestamp: timestamp + 1, content: [{ type: "toolCall", id: "persisted-question", name: "ask_user", arguments: questionArgs }] },
    { role: "toolResult", toolCallId: "persisted-question", content: [{ type: "text", text: "等待用户回答" }] },
  ], before: null, userOffset: 0 }
  await page.evaluate(() => { window.SapBuddy.setStreaming(false); return window.SapBuddy.loadHistory("fixture.jsonl") })
  await page.waitForSelector('[data-cid="approval:persisted-question"]')
  assert.equal(await page.locator('[data-cid="approval:persisted-question"] input[type="radio"]').count(), 3)
  assert.equal(await page.locator(".bu-tool").count(), 0)

  broadcast({ kind: "write_approval_required", id: "approval-failed", toolCallId: "blocked-failed", toolName: "write_program", input: { name: "ZFAILED" } })
  await page.waitForSelector('[data-cid="approval:approval-failed"]')
  nextChatStatus = 500
  await page.locator('[data-cid="approval:approval-failed"]').getByRole("button", { name: "确认并发送" }).click()
  await page.waitForFunction(() => document.querySelector('[data-cid="approval:approval-failed"] .bu-approval-status')?.textContent === "发送失败，请重试")
  await capture("approval-failed")
  await page.locator('[data-cid="approval:approval-failed"]').getByRole("button", { name: "确认并发送" }).click()
  await page.waitForFunction(() => document.querySelector('[data-cid="approval:approval-failed"] .bu-approval-status')?.textContent === "确认词已发送，等待 Agent 校验")
  emit({ type: "agent_end" })

  broadcast({ kind: "write_approval_required", id: "approval-stale", toolCallId: "blocked-stale", toolName: "write_program", input: { name: "ZSTALE" } })
  await page.waitForSelector('[data-cid="approval:approval-stale"]')
  await page.locator('[data-cid="approval:approval-stale"]').getByRole("button", { name: "确认并发送" }).click()
  await page.waitForFunction(() => document.querySelector('[data-cid="approval:approval-stale"] .bu-approval-status')?.textContent === "确认词已发送，等待 Agent 校验")
  emit({ type: "agent_end", willRetry: true })
  assert.equal(await page.locator('[data-cid="approval:approval-stale"] .bu-approval-status').textContent(), "确认词已发送，等待 Agent 校验")
  emit({ type: "agent_end" })
  await page.waitForFunction(() => document.querySelector('[data-cid="approval:approval-stale"] .bu-approval-status')?.textContent === "请求已结束，未执行写操作")

  broadcast({ kind: "write_approval_required", id: "approval-interrupted", toolCallId: "blocked-interrupted", toolName: "write_program", input: { name: "ZINTERRUPTED" } })
  await page.waitForSelector('[data-cid="approval:approval-interrupted"]')
  await page.locator('[data-cid="approval:approval-interrupted"]').getByRole("button", { name: "确认并发送" }).click()
  await page.waitForFunction(() => document.querySelector('[data-cid="approval:approval-interrupted"] .bu-approval-status')?.textContent === "确认词已发送，等待 Agent 校验")
  emit({ type: "agent_start" })
  emit({ type: "tool_execution_start", toolCallId: "execute-interrupted", toolName: "write_program", args: { name: "ZINTERRUPTED" } })
  await page.waitForFunction(() => document.querySelector('[data-cid="approval:approval-interrupted"] .bu-approval-status')?.textContent === "后端已放行，工具正在执行")
  emit({ type: "agent_abort" })
  await page.waitForFunction(() => document.querySelector('[data-cid="approval:approval-interrupted"] .bu-approval-status')?.textContent === "请求已中断，写操作未完成")
  await capture("approval-interrupted")

  history = { path: "fixture.jsonl", messages: [message("user", "当前问题", timestamp + 2), message("assistant", "当前答复", timestamp + 3)], before: 25, userOffset: 25 }
  const historyPageStarted = performance.now()
  await page.evaluate(() => window.SapBuddy.loadHistory("fixture.jsonl"))
  measurementsMs.historyPage = Number((performance.now() - historyPageStarted).toFixed(2))
  assert.equal(await page.locator(".msg.user").count(), 1)
  // Editing/regenerating a paged message must retain its absolute user index.
  await page.locator('.msg.agent [data-action="regenerate"]').click()
  await page.waitForFunction(() => !window.SapBuddy.state.historyLoading)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(posted.keepUserCount, 25)
  await page.evaluate(() => { window.SapBuddy.setStreaming(false); return window.SapBuddy.loadHistory("fixture.jsonl") })
  await page.locator(".history-more").click()
  await page.waitForFunction(() => document.querySelectorAll(".msg.user").length === 2)
  assert.equal(await page.locator(".msg.user .body").first().textContent(), "更早的问题")
  assert.equal(await page.locator(".msg.user .body").last().textContent(), "当前问题")
  const chatsBeforeEdit = chatRequests.length
  await page.locator('.msg.user [data-action="edit"]').last().click()
  await page.locator('.msg-edit-textarea').fill("修改后的问题")
  await page.locator('.msg-edit-textarea').evaluate(el => el.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Enter", code: "Enter", isComposing: true, bubbles: true, cancelable: true,
  })))
  await page.waitForTimeout(80)
  assert.equal(chatRequests.length, chatsBeforeEdit, "IME confirmation must not submit edited history")
  posted = undefined
  await page.locator('.msg-edit-actions').getByRole("button", { name: "发送", exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('.msg-edit-textarea'))
  assert.equal(posted.keepUserCount, 25)
  assert.equal(chatRequests.length, chatsBeforeEdit + 1)
  assert.ok(JSON.stringify(chatRequests.at(-1)).includes("修改后的问题"))
  await page.evaluate(() => { window.SapBuddy.setStreaming(false); return window.SapBuddy.loadHistory("fixture.jsonl") })
  await page.locator(".history-more").click()
  await page.waitForFunction(() => document.querySelectorAll(".msg.user").length === 2)
  await page.locator('.msg.user [data-action="delete"]').last().click()
  await page.locator('.delete-dialog-item').first().click()
  await page.locator('.delete-dialog-confirm').click()
  await page.waitForFunction(() => !document.querySelector('.delete-dialog-overlay') && !window.SapBuddy.state.historyLoading)
  assert.equal(deletedRequest.path, "fixture.jsonl")
  assert.deepEqual(deletedRequest.userIndices.sort((a, b) => a - b), [0, 25])
  broadcast({ kind: "write_approval_required", sessionFile: "previous-session.jsonl", id: "late-previous", toolCallId: "late-call", toolName: "write_program", input: { name: "ZOLD" } })
  await page.waitForTimeout(40)
  assert.equal(await page.locator('[data-cid="approval:late-previous"]').count(), 0)
  // Refresh during regeneration: the new user turn has no assistant output yet.
  history = { path: "fixture.jsonl", messages: [message("user", "上一轮", timestamp), message("assistant", "上一轮完整回答", timestamp + 1), message("user", "重新生成的问题", timestamp + 2)], userOffset: 0, before: null, isStreaming: true }
  await page.evaluate(() => window.SapBuddy.loadHistory("fixture.jsonl"))
  assert.equal(await page.locator(".msg.agent.typing").count(), 0)
  assert.equal(await page.locator(".is-streaming").count(), 0)
  assert.equal(await page.evaluate(() => !!window.SapBuddy.chatView.getSnapshot().waiting), true)
  emit({ type: "message_start", message: { role: "assistant", timestamp: timestamp + 3, content: [] } })
  emit({ type: "message_update", message: message("assistant", "重新生成的新回答", timestamp + 3) })
  await page.waitForFunction(() => document.querySelectorAll(".reply-text").length === 2)
  assert.equal(await page.locator(".reply-text").first().textContent(), "上一轮完整回答")
  assert.equal(await page.locator(".reply-text").last().textContent(), "重新生成的新回答")
  emit({ type: "message_end", message: message("assistant", "重新生成的新回答", timestamp + 3) })
  emit({ type: "agent_end" })
  // Reconnect restores a persisted snapshot and subsequent deltas reuse its bubble.
  history = { path: "fixture.jsonl", messages: [message("user", "当前问题", timestamp + 2), message("assistant", "恢复片段", timestamp + 3)], userOffset: 25, before: 25, isStreaming: true }
  const reconnectStarted = performance.now()
  for (const res of clients) res.end()
  await page.waitForFunction(() => document.querySelector(".reply-text")?.textContent === "恢复片段", { timeout: 10000 })
  measurementsMs.reconnectSnapshot = Number((performance.now() - reconnectStarted).toFixed(2))
  const resumedReplyStarted = performance.now()
  emit({ type: "message_update", message: message("assistant", "恢复片段，继续完成", timestamp + 3) })
  emit({ type: "message_end", message: message("assistant", "恢复片段，继续完成", timestamp + 3) })
  emit({ type: "agent_end" })
  await page.waitForFunction(() => document.querySelector(".reply-text")?.textContent === "恢复片段，继续完成")
  measurementsMs.resumedStreamUpdate = Number((performance.now() - resumedReplyStarted).toFixed(2))
  assert.equal(await page.locator(".msg.agent").count(), 1)

  // Transient errors stay hidden until the SDK decides not to retry.
  const failedReply = { role: "assistant", timestamp: timestamp + 4, content: [], stopReason: "error", errorMessage: "Connection error." }
  emit({ type: "agent_start" })
  emit({ type: "message_end", message: failedReply })
  await page.waitForTimeout(60)
  assert.equal(await page.locator(".generation-error").count(), 0)
  emit({ type: "agent_end", messages: [failedReply], willRetry: true })
  emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3 })
  await page.waitForFunction(() => window.SapBuddy.chatView.getSnapshot().waiting?.text.includes("1/3"))
  assert.equal(await page.locator(".generation-error").count(), 0)
  emit({ type: "agent_start" })
  emit({ type: "message_end", message: failedReply })
  emit({ type: "agent_end", messages: [failedReply], willRetry: false })
  await page.waitForSelector(".generation-error")
  assert.equal(await page.locator(".generation-error").count(), 1)
  emit({ type: "agent_start" })
  const recovered = message("assistant", "重试后成功", timestamp + 4)
  emit({ type: "message_end", message: recovered })
  emit({ type: "agent_end", messages: [recovered], willRetry: false })
  await page.waitForFunction(() => !document.querySelector(".generation-error"))

  const longReply = "一段 SAP 排查说明，用于验证长回复的渲染和滚动跟随。".repeat(4000)
  emit({ type: "agent_start" })
  const longMessage = { role: "assistant", timestamp: timestamp + 5, content: [{ type: "text", text: longReply }] }
  emit({ type: "message_start", message: { ...longMessage, content: [] } })
  const longReplyStarted = performance.now()
  emit({ type: "message_update", message: longMessage })
  await page.waitForFunction(length => Array.from(document.querySelectorAll(".reply-text")).at(-1)?.textContent.length === length, longReply.length)
  measurementsMs.longReplyRender = Number((performance.now() - longReplyStarted).toFixed(2))
  const messagesViewport = page.locator("#messages")
  await messagesViewport.evaluate(element => { element.scrollTop = 0 })
  await page.waitForTimeout(40)
  emit({ type: "message_update", message: { ...longMessage, content: [{ type: "text", text: longReply + "追加内容" }] } })
  await page.waitForFunction(length => Array.from(document.querySelectorAll(".reply-text")).at(-1)?.textContent.length === length, longReply.length + 4)
  assert.ok(await messagesViewport.evaluate(element => element.scrollTop <= 1))
  emit({ type: "agent_end" })

  const wideLine = `DATA(lv_value) = '${"X".repeat(500)}'.`
  const wideText = `\`\`\`abap\n${wideLine}\n\`\`\``
  const wideRows = Array.from({ length: 3 }, (_, row) => Object.fromEntries(Array.from({ length: 12 }, (_, column) => [`wide_field_${String(column).padStart(2, "0")}`, `row_${row}_${"value".repeat(18)}`])))
  emit({ type: "agent_start" })
  const wideMessage = { role: "assistant", timestamp: timestamp + 4, content: [{ type: "text", text: wideText }, { type: "toolCall", id: "wide-table", name: "read_records", arguments: {} }] }
  emit({ type: "message_start", message: { ...wideMessage, content: [] } })
  emit({ type: "message_update", message: wideMessage })
  emit({ type: "tool_execution_start", toolCallId: "wide-table", toolName: "read_records", args: {} })
  emit({ type: "tool_execution_end", toolCallId: "wide-table", result: { structuredContent: wideRows, content: [{ type: "text", text: "3 条记录" }] } })
  emit({ type: "message_end", message: wideMessage })
  emit({ type: "agent_end" })
  await page.waitForFunction(() => document.querySelectorAll(".bu-code-lines").length === 1 && document.querySelectorAll(".bu-tool-group").length === 1)
  assert.equal(await page.locator(".bu-tool").count(), 0)
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  await page.locator(".bu-tool-group > summary").click()
  await page.locator(".bu-tool > summary").click()
  await page.waitForSelector(".bu-records-table")
  const overflow = await page.evaluate(() => {
    const code = document.querySelector(".bu-code-lines")
    const table = document.querySelector(".bu-records-scroll")
    return { code: code.scrollWidth > code.clientWidth, table: table.scrollWidth > table.clientWidth,
      document: document.documentElement.scrollWidth <= window.innerWidth }
  })
  assert.deepEqual(overflow, { code: true, table: true, document: true })
  await page.locator(".bu-records-scroll").scrollIntoViewIfNeeded()
  await capture("narrow-history")
  const repeatedSwitchStarted = performance.now()
  for (let index = 0; index < 10; index++) {
    await page.evaluate(path => window.SapBuddy.loadHistory(path), `fixture-switch-${index}.jsonl`)
  }
  measurementsMs.tenSessionSwitches = Number((performance.now() - repeatedSwitchStarted).toFixed(2))
  await page.evaluate(() => window.SapBuddy.loadHistory("fixture.jsonl"))
  assert.equal(await page.locator(".msg.user").count(), 1)
  assert.equal(await page.locator(".msg.agent").count(), 1)
  if (process.env.SAPBUDDY_PERF_REPORT) {
    await fs.writeFile(process.env.SAPBUDDY_PERF_REPORT, JSON.stringify({
      environment: { node: process.version, platform: process.platform, chromium: browser.version(), viewport: "1440x1000 then 390x844" },
      dataset: { syntheticSessions: 1000, initialSessionPage: 50, secondPage: 50, historyPage: 20, longReplyCharacters: longReply.length, wideCodeCharacters: 500, tableColumns: 12 },
      measurementsMs,
    }, null, 2))
  }
  history = { path: "fixture.jsonl", userOffset: 0, before: null, messages: [message("user", "回放多个步骤", timestamp),
    ...Array.from({ length: 6 }, (_, index) => [
      { role: "assistant", timestamp: timestamp + index + 1, content: [{ type: "thinking", thinking: `步骤 ${index + 1}` }, { type: "toolCall", id: `group-${index}`, name: index ? "bash" : "edit", arguments: index ? { command: "node --version" } : { path: "demo.abap" } }] },
      { role: "toolResult", toolCallId: `group-${index}`, content: [{ type: "text", text: "完成" }], details: index ? {} : { diff: "-WRITE 'old'.\n+WRITE 'new'." } },
    ]).flat(),
  ] }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.evaluate(() => window.SapBuddy.loadHistory("fixture.jsonl"))
  assert.equal(await page.locator(".bu-thinking").count(), 1)
  assert.equal(await page.locator(".bu-tool-group").count(), 1)
  assert.equal(await page.locator(".bu-tool").count(), 0)
  await page.locator(".bu-tool-group > summary").click()
  await page.locator(".bu-tool-group > .bui-more").click()
  await page.waitForFunction(() => document.querySelectorAll(".bu-tool").length === 6)
  assert.equal(await page.locator(".bui-file-diff summary").textContent(), "demo.abap+1−1")
  await page.locator(".bui-file-diff summary").click()
  assert.ok((await page.locator(".bui-file-diff pre").textContent()).includes("WRITE 'new'"))
  if (process.env.SAPBUDDY_REPLAY_SESSION) {
    const records = (await fs.readFile(process.env.SAPBUDDY_REPLAY_SESSION, "utf8")).trim().split("\n").map(line => JSON.parse(line))
    const messages = records.filter(record => record.type === "message" && record.message).map(record => record.message)
    const callCount = messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === "toolCall" && part.name !== "ask_user").length
    history = { path: "fixture.jsonl", messages, userOffset: 0, before: null }
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.evaluate(() => { window.SapBuddy.setStreaming(false); return window.SapBuddy.loadHistory("fixture.jsonl") })
    assert.equal(await page.locator(".bu-tool-group").count(), 1)
    assert.equal(await page.locator(".bu-thinking").count(), 1)
    assert.equal(await page.locator(".bu-tool").count(), 0)
    assert.equal(await page.locator(".bui-trace-shell[data-variant='Reasoning']").count(), 1)
    await page.locator(".bu-tool-group").scrollIntoViewIfNeeded()
    await page.locator(".bu-tool-group > summary").click()
    await capture("session-tool-chips")
    await page.locator(".bui-trace-shell").scrollIntoViewIfNeeded()
    await capture("session-thinking-search")
    await page.locator(".bu-tool-group > .bui-more").click()
    assert.equal(await page.locator(".bu-tool").count(), callCount)
    await page.locator(".bu-tool > summary").last().click()
    assert.equal(await page.locator(".bu-tool").last().evaluate(el => el.open), true)
    await page.locator(".bu-tool-group > .bui-more").click()
    await page.setViewportSize({ width: 390, height: 844 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    await capture("session-narrow")
  }
  history = { path: "fixture.jsonl", messages: [message("user", "恢复重试", timestamp + 100)], userOffset: 0, before: null,
    isStreaming: true, sequence: 80, streamId: "old-server", retry: { attempt: 2, maxAttempts: 3 } }
  for (const client of clients) client.end()
  await page.waitForFunction(() => document.querySelector(".waiting-text")?.textContent.includes("2/3"))
  assert.equal(await page.locator("#send-btn").textContent(), "停止")
  // An event already covered by the snapshot must not overwrite restored output.
  broadcast({ kind: "agent", sequence: 79, streamId: "old-server", event: { type: "message_update", message: message("assistant", "不应出现", timestamp + 101) } })
  // A restarted server can begin at a lower sequence and must still be accepted.
  broadcast({ kind: "agent", sequence: 1, streamId: "new-server", event: { type: "message_update", message: message("assistant", "恢复后的回答", timestamp + 102) } })
  broadcast({ kind: "agent", sequence: 2, streamId: "new-server", event: { type: "agent_end" } })
  await page.waitForFunction(() => document.querySelector("#send-btn")?.textContent === "发送")
  assert.equal(await page.locator(".msg.agent").count(), 1)
  assert.doesNotMatch(await page.locator("#messages").textContent(), /不应出现/)
  assert.match(await page.locator("#messages").textContent(), /恢复后的回答/)

  history = { path: "fixture.jsonl", userOffset: 0, before: null, messages: [message("user", "失败工具", timestamp + 200),
    { role: "assistant", timestamp: timestamp + 201, content: [{ type: "toolCall", id: "failed-summary", name: "bash", arguments: { command: "fixture" } }] },
    { role: "toolResult", toolCallId: "failed-summary", isError: true, content: [{ type: "text", text: "连接超时\n完整日志内容" }] }] }
  await page.evaluate(() => window.SapBuddy.loadHistory("fixture.jsonl"))
  assert.match(await page.locator(".bu-tool-group > summary").textContent(), /1 次失败/)
  assert.equal(await page.locator(".bu-tool").count(), 0)
  await page.locator(".bu-tool-group > summary").click()
  await page.locator(".bu-tool > summary").click()
  await page.locator(".bu-tool-detail .bu-tool-error-summary").waitFor()
  assert.equal(await page.locator(".bu-tool-detail .bu-tool-error-summary").textContent(), "连接超时")
  assert.equal(await page.locator(".bu-tool pre").count(), 0)
  await page.getByRole("button", { name: "查看完整输入与错误" }).click()
  assert.match(await page.locator(".bu-tool-result").textContent(), /完整日志内容/)
  // Scroll follows only while at the bottom, including delayed layout growth.
  const scrollTime = timestamp + 300
  let scrollText = Array.from({ length: 90 }, (_, i) => `段落 ${i}：滚动回归内容。`).join("\n\n")
  history = { path: "fixture.jsonl", userOffset: 0, before: null, isStreaming: true, messages: [message("user", "滚动测试", scrollTime), message("assistant", scrollText, scrollTime + 1)] }
  await page.setViewportSize({ width: 1100, height: 720 })
  await page.evaluate(() => window.SapBuddy.loadHistory("fixture.jsonl"))
  const waitAtBottom = () => page.waitForFunction(() => {
    const el = document.querySelector("#messages")
    return el.scrollHeight - el.scrollTop - el.clientHeight <= 4 && !document.querySelector(".scroll-bottom-btn").classList.contains("show")
  })
  await waitAtBottom()
  scrollText += "\n\n继续输出\n\n".repeat(20)
  emit({ type: "message_update", message: message("assistant", scrollText, scrollTime + 1) })
  await page.waitForFunction(() => document.querySelector(".reply-text")?.textContent.includes("继续输出"))
  await waitAtBottom()
  await page.locator("#messages").hover()
  await page.mouse.wheel(0, -500)
  await page.waitForFunction(() => document.querySelector(".scroll-bottom-btn").classList.contains("show"))
  await page.waitForTimeout(150)
  const pausedTop = await page.locator("#messages").evaluate(el => el.scrollTop)
  scrollText += "\n\n上滚时新增内容\n\n".repeat(20)
  emit({ type: "message_update", message: message("assistant", scrollText, scrollTime + 1) })
  emit({ type: "agent_end" })
  await page.waitForFunction(() => document.querySelector("#send-btn")?.textContent === "发送")
  await page.waitForTimeout(100)
  assert.ok(Math.abs(await page.locator("#messages").evaluate(el => el.scrollTop) - pausedTop) < 5, "finishing the reply must not steal the user's scroll position")
  await page.locator(".scroll-bottom-btn").click()
  await waitAtBottom()
  // Directly returning the scrollbar to the bottom also resumes following.
  await page.locator("#messages").evaluate(el => { el.scrollTop -= 300 })
  await page.waitForFunction(() => document.querySelector(".scroll-bottom-btn").classList.contains("show"))
  await page.locator("#messages").evaluate(el => { el.scrollTop = el.scrollHeight })
  await waitAtBottom()
  await page.locator(".reply-text").evaluate(el => { el.style.paddingBottom = "250px" })
  await waitAtBottom()
  await page.setViewportSize({ width: 1100, height: 600 })
  await waitAtBottom()
  // Reconnect refresh preserves the current reading position rather than forcing the bottom.
  await page.locator("#messages").evaluate(el => { el.scrollTop = 500 })
  await page.waitForFunction(() => document.querySelector(".scroll-bottom-btn").classList.contains("show"))
  const readingTop = await page.locator("#messages").evaluate(el => el.scrollTop)
  await page.evaluate(() => window.SapBuddy.loadHistory("fixture.jsonl", null, { preserveScroll: true }))
  await page.waitForTimeout(100)
  assert.ok(Math.abs(await page.locator("#messages").evaluate(el => el.scrollTop) - readingTop) < 5)

  // Stop remains pending until the server responds, and failures remain retryable.
  let releaseStop
  await page.route("**/api/abort", async route => {
    await new Promise(resolve => { releaseStop = resolve })
    await route.fulfill({ json: { ok: true } })
  })
  await page.evaluate(() => window.SapBuddy.setStreaming(true))
  await page.locator("#send-btn").click()
  await page.waitForFunction(() => document.querySelector("#send-btn").textContent === "正在停止…")
  assert.equal(await page.locator("#send-btn").isDisabled(), true)
  assert.equal(await page.evaluate(() => window.SapBuddy.state.streaming), true)
  releaseStop()
  await page.waitForFunction(() => document.querySelector("#send-btn").textContent === "发送")
  await page.unroute("**/api/abort")
  await page.route("**/api/abort", route => route.fulfill({ status: 500, json: { error: "fixture stop failure" } }))
  await page.evaluate(() => window.SapBuddy.setStreaming(true))
  await page.locator("#send-btn").click()
  await page.waitForFunction(() => document.querySelector("#send-btn").textContent === "停止" && !document.querySelector("#send-btn").disabled)
  await page.evaluate(() => window.SapBuddy.setStreaming(false))
  await page.unroute("**/api/abort")

  // Failed pagination leaves existing content intact and offers a retry in place.
  const originalReply = await page.locator(".reply-text").textContent()
  await page.route("**/api/history?**", route => route.fulfill({ status: 500, json: { error: "fixture history failure" } }))
  await page.evaluate(() => window.SapBuddy.loadHistory("fixture.jsonl", 1))
  assert.match(await page.locator(".history-more").textContent(), /点击重试/)
  assert.equal(await page.locator(".reply-text").textContent(), originalReply)
  await page.unroute("**/api/history?**")
  await page.locator(".history-more").click()
  await page.waitForFunction(() => document.querySelector("#messages").textContent.includes("更早的问题"))

  history = { path: "fixture.jsonl", before: null, userOffset: 0, messages: [message("user", "生成文件", scrollTime + 5),
    { role: "assistant", timestamp: scrollTime + 6, content: [{ type: "toolCall", id: "artifact-ok", name: "write", arguments: { path: "~/.SapBuddy/output/docs/guide.md", content: "example" } }] },
    { role: "toolResult", toolCallId: "artifact-ok", isError: false, content: [{ type: "text", text: "ok" }] }] }
  await page.evaluate(() => window.SapBuddy.loadHistory("fixture.jsonl"))
  await page.locator(".artifact-card").waitFor()
  assert.equal(await page.locator(".artifact-name").textContent(), "docs/guide.md")
  assert.match(await page.locator(".artifact-card a").getAttribute("href"), /download=1/)
  await page.locator(".artifact-card").getByRole("button", { name: "预览", exact: true }).click()
  await page.waitForFunction(() => document.querySelector("#preview-overlay").classList.contains("open"))
  await page.locator("#preview-close").click()
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  // Every saved desktop fold state must keep the chat full width on narrow screens.
  for (const width of [390, 720, 840, 900]) {
    await page.setViewportSize({ width, height: 844 })
    for (const left of [false, true]) for (const right of [false, true]) {
      await page.evaluate(({ left, right }) => {
        const app = document.querySelector("#app")
        app.classList.toggle("left-collapsed", left)
        app.classList.toggle("right-collapsed", right)
      }, { left, right })
      await page.locator("#left-toggle").click()
      await page.waitForFunction(() => !document.querySelector("#sidebar").inert)
      assert.ok(await page.locator("#chat").evaluate(el => el.getBoundingClientRect().width >= window.innerWidth - 2))
      assert.ok(await page.locator("#input-card").evaluate(el => el.getBoundingClientRect().width > 250))
      await page.locator(".panel-backdrop").click({ position: { x: width - 10, y: 400 } })
      assert.equal(await page.locator("#left-toggle").getAttribute("aria-expanded"), "false")
      await page.locator("#right-toggle").click()
      await page.waitForFunction(() => !document.querySelector("#right-panel").inert)
      assert.ok(await page.locator("#chat").evaluate(el => el.getBoundingClientRect().width >= window.innerWidth - 2))
      await page.keyboard.press("Escape")
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.locator("#left-toggle").click()
  await page.waitForFunction(() => !document.querySelector("#sidebar").inert)
  assert.ok(await page.locator("#chat").evaluate(el => el.getBoundingClientRect().width > 600))
  assert.deepEqual(errors, [])
})
