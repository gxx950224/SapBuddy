import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

test("question submission retries, retires the card and preserves composer draft", { skip: !process.env.SAPBUDDY_PLAYWRIGHT }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.SAPBUDDY_PLAYWRIGHT))
  const root = fileURLToPath(new URL("../src/web/public/", import.meta.url))
  const server = http.createServer(async (req, res) => {
    try {
      const filename = path.join(root, req.url === "/" ? "index.html" : req.url.split("?")[0])
      const data = await fs.readFile(filename)
      res.setHeader("Content-Type", ({ ".js": "text/javascript", ".css": "text/css", ".html": "text/html" })[path.extname(filename)] || "application/octet-stream")
      res.end(data)
    } catch { res.writeHead(404); res.end() }
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const browser = await chromium.launch({ headless: true, channel: "msedge" })
  t.after(() => browser.close())
  const page = await browser.newPage()
  let fail = true
  const requests = []
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/chat") {
      requests.push(route.request().postDataJSON())
      await route.fulfill({ status: fail ? 500 : 200, json: fail ? { error: "fixture failure" } : { success: true } })
    } else await route.fulfill({ json: { data: {}, sessions: [], models: [], messages: [] } })
  })
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.waitForFunction(() => window.SapBuddy?.chatView && window.SapBuddy?.sendMessage)
  await page.evaluate(() => {
    const app = window.SapBuddy
    app.setStreaming(false)
    app.prefillMessage("未发送的草稿")
    app.state.attachments = [{ name: "draft.txt", path: "/draft.txt" }]
    app.state.images = [{ mimeType: "image/png", data: "draft-image" }]
    app.chatView.addApproval({ id: "retry-question", question: "选择方案", options: ["A", "B"], allowCustom: true })
  })
  const card = page.locator('[data-cid="approval:retry-question"]')
  await card.getByRole("radio", { name: "A", exact: true }).check()
  await card.getByRole("button", { name: "发送答案" }).click()
  await page.waitForFunction(() => document.querySelector('[data-cid="approval:retry-question"] .bu-approval-status')?.textContent === "发送失败")
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0], { text: "A", images: [] })
  assert.equal(await card.getByRole("radio", { name: "A", exact: true }).isChecked(), true)
  fail = false
  await card.getByRole("button", { name: "发送答案" }).click()
  await page.waitForFunction(() => [...window.SapBuddy.chatView.getSnapshot().items.values()].find(x => x.id === "approval:retry-question")?.status === "complete")
  assert.equal(await card.count(), 0)
  assert.equal(requests.length, 2)
  assert.equal(await page.locator("#input").inputValue(), "未发送的草稿")
  assert.deepEqual(await page.evaluate(() => ({ attachments: window.SapBuddy.state.attachments, images: window.SapBuddy.state.images })), {
    attachments: [{ name: "draft.txt", path: "/draft.txt" }], images: [{ mimeType: "image/png", data: "draft-image" }],
  })
  // Exercise the actual settings manager with fixture sessions only.
  const deleted = []
  let sessionRows = [
    { path: "current.jsonl", name: "当前", current: true, modified: Date.now(), count: 2 },
    { path: "old.jsonl", name: "旧会话", modified: Date.now(), count: 4 },
    { path: "failed.jsonl", name: "失败会话", modified: Date.now(), count: 1 },
  ]
  await page.route("**/api/sessions?**", route => route.fulfill({ json: { success: true, data: { sessions: sessionRows, total: sessionRows.length, nextOffset: null } } }))
  await page.route("**/api/session/delete", route => {
    const file = route.request().postDataJSON().path
    deleted.push(file)
    if (file === "failed.jsonl") return route.fulfill({ status: 500, json: { error: "模拟删除失败" } })
    sessionRows = sessionRows.filter(row => row.path !== file)
    return route.fulfill({ json: { success: true } })
  })
  await page.evaluate(async () => {
    document.querySelector("#settings-overlay").classList.add("open")
    document.querySelectorAll(".settings-panel").forEach(panel => panel.classList.toggle("active", panel.dataset.panel === "sessions"))
    await window.SapBuddy.loadSessionManager()
  })
  assert.equal(await page.locator('#session-manager-list input[value="current.jsonl"]').isDisabled(), true)
  await page.locator("#session-manager-all").check()
  await page.locator("#session-manager-delete").click()
  await page.locator("#confirm-cancel").click()
  assert.equal(deleted.length, 0)
  await page.locator("#session-manager-delete").click()
  await page.locator("#confirm-ok").click()
  await page.waitForFunction(() => document.querySelector("#session-manager-status").textContent.includes("已删除 1 个会话"))
  assert.deepEqual(deleted, ["old.jsonl", "failed.jsonl"])
  assert.match(await page.locator("#session-manager-status").textContent(), /模拟删除失败/)
  assert.equal(await page.locator('#session-manager-list input[value="failed.jsonl"]').isChecked(), true)
  assert.match(await page.locator("#session-manager-delete").textContent(), /1/)
  // Selection survives page changes and exports the rows from both pages.
  await page.locator("#session-manager-clear").click()
  await page.route("**/api/sessions?**", route => {
    const offset = Number(new URL(route.request().url()).searchParams.get("offset") || 0)
    return route.fulfill({ json: { success: true, data: { sessions: [{ path: offset ? "second.jsonl" : "first.jsonl", name: offset ? "第二页" : "第一页", modified: Date.now() }], total: 31, nextOffset: offset ? null : 30 } } })
  })
  await page.evaluate(() => window.SapBuddy.loadSessionManager())
  await page.locator("#session-manager-all").check()
  await page.locator("#session-manager-next").click()
  await page.locator('#session-manager-list input[value="second.jsonl"]').check()
  assert.match(await page.locator("#session-manager-delete").textContent(), /2/)
  assert.match(await page.locator("#session-manager-selection").textContent(), /已选 2 项，其中 1 项不在当前页/)
  await page.locator("#session-manager-prev").click()
  assert.equal(await page.locator('#session-manager-list input[value="first.jsonl"]').isChecked(), true)
  let exported
  await page.route("**/api/session/export", route => {
    exported = route.request().postDataJSON().paths
    return route.fulfill({ json: { success: true, sessions: exported.map(name => ({ name, jsonl: "fixture" })) } })
  })
  const download = page.waitForEvent("download")
  await page.locator("#session-manager-export").click()
  await download
  assert.deepEqual(exported, ["first.jsonl", "second.jsonl"])
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  const toolbarFits = await page.locator(".settings-panel[data-panel='sessions']").evaluate(el => el.scrollWidth <= el.clientWidth)
  assert.equal(toolbarFits, true)
})
