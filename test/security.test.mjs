/**
 * 安全核心逻辑单测（覆盖 register.ts 的硬编码规则与 shared.ts 的转义）
 * 针对：scanCodeViolations / handleUserMessage 授权窗口 / namespaceViolation / escapeXmlAttr
 */
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const register = require("../dist/sap-tools/register.js")
const shared = require("../dist/sap-tools/tools/shared.js")

const { scanCodeViolations, handleUserMessage, clearWriteApproval, isWriteApproved, namespaceViolation } = register
const { escapeXmlAttr } = shared

before(() => clearWriteApproval())
after(() => clearWriteApproval())

// ── scanCodeViolations ───────────────────────────────────────────────────────
test("scanCodeViolations：硬编码中文文案被拦截", () => {
  const code = `WRITE: '你好世界'.`
  const v = scanCodeViolations(code)
  assert.ok(v.some((x) => x.includes("硬编码中文")), `应报中文违规，实际: ${v.join("|")}`)
})

test("scanCodeViolations：注释中的中文不误报", () => {
  const code = `* 这是注释 " 含中文\nWRITE: 'OK'.`
  const v = scanCodeViolations(code)
  assert.deepEqual(v, [])
})

test("scanCodeViolations：裸内置类型被拦截", () => {
  const code = `DATA: lv_text TYPE string, lv_i TYPE i.`
  const v = scanCodeViolations(code)
  assert.ok(v.some((x) => x.includes("TYPE STRING")), `应报 TYPE STRING，实际: ${v.join("|")}`)
  assert.ok(v.some((x) => x.includes("TYPE I")), `应报 TYPE I，实际: ${v.join("|")}`)
})

test("scanCodeViolations：DDIC 元素/复合类型不误报", () => {
  const code = [
    `DATA: lv_matnr TYPE matnr.`,
    `DATA: lr_ref TYPE REF TO zcl_foo.`,
    `DATA: lt_tab TYPE TABLE OF zstruct.`,
    `DATA: lv_bool TYPE abap_bool.`,
    `DATA: lv_idx TYPE sy-tabix.`,
  ].join("\n")
  const v = scanCodeViolations(code)
  assert.deepEqual(v, [], `不应有违规，实际: ${v.join("|")}`)
})

test("scanCodeViolations：空代码通过", () => {
  assert.deepEqual(scanCodeViolations(""), [])
})

// ── 授权窗口（handleUserMessage）────────────────────────────────────────────
test("授权窗口：明确批准词打开窗口", () => {
  clearWriteApproval()
  handleUserMessage("确认，按这个方案执行")
  assert.equal(isWriteApproved(), true)
})

test("授权窗口：日常应答词不再打开窗口（好的/可以/ok/行）", () => {
  clearWriteApproval()
  for (const msg of ["好的", "可以", "ok", "OK", "行", "好的，谢谢", "嗯嗯"]) {
    handleUserMessage(msg)
    assert.equal(isWriteApproved(), false, `消息"${msg}"不应打开授权窗口`)
  }
})

test("授权窗口：普通查询消息不打开窗口", () => {
  clearWriteApproval()
  handleUserMessage("帮我查一下销售订单的数据")
  assert.equal(isWriteApproved(), false)
})

test("授权窗口：拒绝词清空窗口（即使含确认词）", () => {
  clearWriteApproval()
  handleUserMessage("确认")
  assert.equal(isWriteApproved(), true)
  handleUserMessage("不要了，取消")
  assert.equal(isWriteApproved(), false)
})

test("授权窗口：'不执行'按拒绝处理（先于确认词判断）", () => {
  clearWriteApproval()
  handleUserMessage("先不执行，我再想想")
  assert.equal(isWriteApproved(), false)
})

// ── 命名空间强制（namespaceViolation）───────────────────────────────────────
test("namespaceViolation：Z*/Y* 对象放行", () => {
  assert.equal(namespaceViolation({ name: "ZAIR004" }), "")
  assert.equal(namespaceViolation({ objectName: "zcl_foo" }), "")
  assert.equal(namespaceViolation({ className: "YCL_TEST" }), "")
})

test("namespaceViolation：SAP 标准对象被拦截", () => {
  assert.ok(namespaceViolation({ name: "SAPLSEUH" }).includes("Z*/Y*"))
  assert.ok(namespaceViolation({ objectName: "BC_DATAL" }).includes("Z*/Y*"))
})

test("namespaceViolation：传输请求号等非对象名字段不拦截", () => {
  assert.equal(namespaceViolation({ transportNumber: "DEVK900001" }), "")
  assert.equal(namespaceViolation({}), "")
  assert.equal(namespaceViolation({ objectName: "" }), "")
})

// ── XML 转义（escapeXmlAttr）─────────────────────────────────────────────────
test("escapeXmlAttr：& 先转义，避免二次转义", () => {
  assert.equal(escapeXmlAttr('A&B "Q" <X>'), "A&amp;B &quot;Q&quot; &lt;X&gt;")
  // 含引号时不产生 &amp;quot;（旧 bug 的回归用例）
  assert.equal(escapeXmlAttr('AB"C'), "AB&quot;C")
  assert.equal(escapeXmlAttr('A & B'), "A &amp; B")
})
