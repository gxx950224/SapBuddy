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

const { scanCodeViolations, handleUserMessage, clearWriteApproval, isWriteApproved, namespaceViolation, installWriteGate } = register
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

test("scanCodeViolations：程序内局部变量裸类型放行（DATA 变量）", () => {
  const code = `DATA: lv_text TYPE string, lv_i TYPE i.`
  const v = scanCodeViolations(code)
  assert.deepEqual(v, [], `程序内 DATA 裸类型应放行，实际: ${v.join("|")}`)
})

test("scanCodeViolations：方法/函数参数裸类型放行", () => {
  const code = `METHODS m IMPORTING iv_text TYPE string RETURNING VALUE(rv_n) TYPE i.`
  const v = scanCodeViolations(code)
  assert.deepEqual(v, [], `方法参数裸类型应放行，实际: ${v.join("|")}`)
})

test("scanCodeViolations：自建结构 TYPES 块字段裸类型被拦截", () => {
  const code = [
    `TYPES: BEGIN OF ts_line,`,
    `  field1 TYPE string,`,
    `  field2 TYPE i,`,
    `END OF ts_line.`,
  ].join("\n")
  const v = scanCodeViolations(code)
  assert.ok(v.some((x) => x.includes("TYPE STRING")), `应报 TYPE STRING，实际: ${v.join("|")}`)
  assert.ok(v.some((x) => x.includes("TYPE I")), `应报 TYPE I，实际: ${v.join("|")}`)
})

test("scanCodeViolations：TYPES 引用 DDIC 表/元素不误报", () => {
  const code = `TYPES: tt_mard TYPE STANDARD TABLE OF MARD.`
  const v = scanCodeViolations(code)
  assert.deepEqual(v, [], `引用 DDIC 表不应误报，实际: ${v.join("|")}`)
})

test("scanCodeViolations：DDIC DSL 结构字段 abap.* 裸类型被拦截（clnt 放行）", () => {
  const code = [
    `define structure zss_demo {`,
    `  key client : abap.clnt not null;`,
    `  chars : abap.char(3);`,
    `  num   : abap.int4;`,
    `  id    : zdemo_abap_dtel;`,
    `}`,
  ].join("\n")
  const v = scanCodeViolations(code)
  assert.ok(v.some((x) => x.includes("abap.CHAR")), `应报 abap.CHAR，实际: ${v.join("|")}`)
  assert.ok(v.some((x) => x.includes("abap.INT4")), `应报 abap.INT4，实际: ${v.join("|")}`)
  assert.ok(!v.some((x) => x.includes("CLNT")), `abap.clnt 客户端键不应误报，实际: ${v.join("|")}`)
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

test("scanCodeViolations：CDS 注解中文（@EndUserText.label 等 DDIC 元数据）不误报", () => {
  const code = [
    `@EndUserText.label: '物料编码与描述查询'`,
    `@AbapCatalog.sqlViewName: 'ZCTEST'`,
    `DEFINE VIEW ZC_TEST AS SELECT FROM I_Product`,
    `  KEY ProductID AS ProductId,`,
  ].join("\n")
  const v = scanCodeViolations(code)
  assert.deepEqual(v, [], `CDS 注解中的中文描述不应违规，实际: ${v.join("|")}`)
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

// ── 敏感配置文件读写拦截（installWriteGate：AI 不得读写安全配置）────
async function triggerWriteGate(input, toolName = "write") {
  let cb
  const pi = { on: (evt, handler) => { if (evt === "tool_call") cb = handler } }
  installWriteGate(pi)
  return cb({ toolName, input }, {})
}

test("配置文件禁止 AI 修改：connections.json 被拦截", async () => {
  const r = await triggerWriteGate({ path: ".SapBuddy/connections.json" })
  assert.equal(r?.block, true)
  assert.ok((r?.reason ?? "").includes("禁止由 AI 直接修改"), `应报写入拦截，实际: ${r?.reason?.slice(0, 80)}`)
})

test("配置文件禁止 AI 修改：auth.json / mcp.json 也被拦截", async () => {
  for (const f of [".SapBuddy/auth.json", ".SapBuddy/mcp.json"]) {
    const r = await triggerWriteGate({ path: f })
    assert.equal(r?.block, true, `${f} 应被拦截`)
  }
})

test("配置文件禁止 AI 读取：read auth.json 被拦截", async () => {
  const r = await triggerWriteGate({ path: ".SapBuddy/auth.json" }, "read")
  assert.equal(r?.block, true)
  assert.ok((r?.reason ?? "").includes("禁止由 AI 读取"), `应报读取拦截，实际: ${r?.reason?.slice(0, 80)}`)
})

test("配置文件禁止 AI 读取：glob/grep 命中敏感文件名也被拦截", async () => {
  for (const [tool, arg] of [["glob", "pattern"], ["grep", "path"]]) {
    const r = await triggerWriteGate({ [arg]: ".SapBuddy/connections.json" }, tool)
    assert.equal(r?.block, true, `${tool} 应拦截敏感配置读取`)
  }
})

test("配置文件拦截：普通 output 文件不受影响", async () => {
  const r = await triggerWriteGate({ path: ".SapBuddy/output/ZAIR010/ZAIR010.abap" })
  // 配置文件拦截不触发；但 .abap 平铺/目录规则可能拦，这里断言不是"配置文件"拦截即可
  assert.ok(!(r?.reason ?? "").includes("配置文件"), "普通输出文件不应报配置文件拦截")
})

// ── bash 命令门禁：放行"打开产物"，仍拦敏感配置/读取 ──
test("bash 命令门禁：start 打开 .SapBuddy/output 产物放行（自动打开 HTML 流程图场景）", async () => {
  const r = await triggerWriteGate(
    { command: 'start "" "C:/Users/Administrator/.SapBuddy/output/ZPPR006_NEW2/ZPPR006_NEW2_排产引擎流程图.html"' },
    "bash"
  )
  assert.equal(r?.block, undefined, "打开产物命令不应被拦截")
})

test("bash 命令门禁：start 指向敏感配置仍拦截", async () => {
  const r = await triggerWriteGate({ command: 'start "" "C:/Users/Administrator/.SapBuddy/auth.json"' }, "bash")
  assert.equal(r?.block, true, "指向 auth.json 应拦截")
  assert.ok((r?.reason ?? "").includes("安全拦截"), `应报安全拦截，实际: ${r?.reason?.slice(0, 60)}`)
})

test("bash 命令门禁：cat 读取 output 仍拦截（读产物应走 read 工具）", async () => {
  const r = await triggerWriteGate({ command: "cat C:/Users/Administrator/.SapBuddy/output/x/y.html" }, "bash")
  assert.equal(r?.block, true, "cat 不是放行操作，应拦截")
})

test("bash 命令门禁：路径穿越 ../ 不因 output 前缀被放行", async () => {
  const r = await triggerWriteGate(
    { command: 'start "" "C:/Users/Administrator/.sapbuddy/output/../auth.json"' },
    "bash"
  )
  assert.equal(r?.block, true, "含 ../ 的 open 命令应拦截")
})

test("bash 命令门禁：python 读 uploads 上传的 Excel 放行（分析上传文件场景）", async () => {
  const r = await triggerWriteGate(
    { command: 'cd /c/Users/24990/.SapBuddy/uploads && python -c "import openpyxl; wb = openpyxl.load_workbook(\'越南翻译文本清单.xlsx\')"' },
    "bash"
  )
  assert.equal(r?.block, undefined, "引用仅限 uploads 子树的命令不应被拦截")
})

test("bash 命令门禁：python 内联路径引用 uploads 文件也放行", async () => {
  const r = await triggerWriteGate(
    { command: "python -c \"import openpyxl; wb = openpyxl.load_workbook('.SapBuddy/uploads/zits004.xlsx')\"" },
    "bash"
  )
  assert.equal(r?.block, undefined, "uploads 子树引用不应被拦截")
})

test("bash 命令门禁：uploads 引用带路径穿越 ../ 仍拦截", async () => {
  const r = await triggerWriteGate(
    { command: "python -c \"open('.SapBuddy/uploads/../../auth.json').read()\"" },
    "bash"
  )
  assert.equal(r?.block, true, "含 ../ 的 uploads 命令应拦截")
})

test("bash 命令门禁：uploads 引用命中敏感配置文件名仍拦截", async () => {
  const r = await triggerWriteGate({ command: "cat .SapBuddy/uploads/connections.json" }, "bash")
  assert.equal(r?.block, true, "uploads 下命中敏感配置文件名也应拦截")
  assert.ok((r?.reason ?? "").includes("安全拦截"), `应报安全拦截，实际: ${r?.reason?.slice(0, 60)}`)
})

// ── 自身源码禁读写（installWriteGate：运行中的 AI 不得读写 SapBuddy 自身代码）────
test("自身源码禁止 AI 读写：write src/register.ts 被拦截", async () => {
  const r = await triggerWriteGate({ path: "src/register.ts" })
  assert.equal(r?.block, true)
  assert.ok((r?.reason ?? "").includes("自身源码"), `应报自身代码拦截，实际: ${r?.reason?.slice(0, 80)}`)
})

test("自身源码禁止 AI 读写：read cli.mjs / AGENTS.md / SYSTEM.md 被拦截", async () => {
  for (const f of ["cli.mjs", "AGENTS.md", "SYSTEM.md", "test/security.test.mjs"]) {
    const r = await triggerWriteGate({ path: f }, "read")
    assert.equal(r?.block, true, `${f} 读取应被拦截`)
  }
})

test("自身源码拦截：Memory.md 避坑记录仍允许写", async () => {
  const r = await triggerWriteGate({ path: "Memory.md" })
  const reason = r?.reason ?? ""
  assert.ok(!reason.includes("自身源码") && !reason.includes("配置文件"), `Memory.md 不应被拦截，实际: ${reason.slice(0, 60)}`)
})

test("自身源码拦截：output 产物与 .SapBuddy/skills 不受影响", async () => {
  for (const f of [".SapBuddy/output/ZAIR010/ZAIR010.abap", ".SapBuddy/skills/clean-abap/rule.md"]) {
    const r = await triggerWriteGate({ path: f })
    assert.ok(!(r?.reason ?? "").includes("自身源码"), `${f} 不应被自身代码拦截`)
  }
})

test("uploads 目录允许 AI 读取：用户上传文件不拦截（2026-08-10 回归）", async () => {
  const r = await triggerWriteGate({ path: ".SapBuddy/uploads/zits004.xlsx.txt" }, "read")
  const reason = r?.reason ?? ""
  assert.ok(!reason.includes("配置目录禁止由 AI 读取"), `用户上传文件不应被目录拦截，实际: ${reason.slice(0, 80)}`)
})

// ── 程序相关文件路径强制（installWriteGate：Z*/Y* 程序相关文件须按程序名建子目录）────
test("审查报告平铺被拦截：.SapBuddy/output/ZAIR004_CodeReview.html", async () => {
  const r = await triggerWriteGate({ path: ".SapBuddy/output/ZAIR004_CodeReview.html" }, "write")
  assert.equal(r?.block, true)
  assert.ok((r?.reason ?? "").includes("按程序名建文件夹"), `实际: ${r?.reason?.slice(0, 80)}`)
})

test("审查报告带子目录放行到确认环节", async () => {
  const r = await triggerWriteGate({ path: ".SapBuddy/output/ZAIR004/ZAIR004_CodeReview.html" }, "write")
  assert.ok((r?.reason ?? "").includes("人工确认"), `应进入确认环节，实际: ${r?.reason?.slice(0, 80)}`)
  assert.ok(!(r?.reason ?? "").includes("建文件夹"), "带子目录不应报路径拦截")
})

test("程序相关文档平铺被拦截：.SapBuddy/output/ZAIR004_flowchart.md", async () => {
  const r = await triggerWriteGate({ path: ".SapBuddy/output/ZAIR004_flowchart.md" }, "write")
  assert.equal(r?.block, true)
  assert.ok((r?.reason ?? "").includes("按程序名建文件夹"), `实际: ${r?.reason?.slice(0, 80)}`)
})

test("程序无关通用文件允许平铺：.SapBuddy/output/README.md", async () => {
  const r = await triggerWriteGate({ path: ".SapBuddy/output/README.md" }, "write")
  assert.ok(!(r?.reason ?? "").includes("按程序名建文件夹"), "通用文件不应被程序目录规则拦截")
})

// ── 路径拦截提示必须直接给出正确目标路径（避免 AI 反复猜路径影响体验）────
test("审查报告平铺拦截：提示给出正确路径 .SapBuddy/output/ZPPR085/ZPPR085_CodeReview.html", async () => {
  const r = await triggerWriteGate({ path: ".SapBuddy/output/ZPPR085_CodeReview.html" }, "write")
  assert.equal(r?.block, true)
  assert.ok((r?.reason ?? "").includes(".SapBuddy/output/ZPPR085/ZPPR085_CodeReview.html"), `应给出正确路径，实际: ${r?.reason?.slice(0, 120)}`)
})

test("源码平铺拦截：提示给出正确路径 .SapBuddy/output/ZAIR010/ZAIR010.abap", async () => {
  const r = await triggerWriteGate({ path: ".SapBuddy/output/ZAIR010.abap" }, "write")
  assert.equal(r?.block, true)
  assert.ok((r?.reason ?? "").includes(".SapBuddy/output/ZAIR010/ZAIR010.abap"), `应给出正确路径，实际: ${r?.reason?.slice(0, 120)}`)
})

test("流程图平铺拦截：提示给出正确路径 .SapBuddy/output/ZAIR004/ZAIR004_flowchart.md", async () => {
  const r = await triggerWriteGate({ path: ".SapBuddy/output/ZAIR004_flowchart.md" }, "write")
  assert.equal(r?.block, true)
  assert.ok((r?.reason ?? "").includes(".SapBuddy/output/ZAIR004/ZAIR004_flowchart.md"), `应给出正确路径，实际: ${r?.reason?.slice(0, 120)}`)
})

test("类文件平铺拦截：下划线类名不误拆 .SapBuddy/output/ZCL_FOO/ZCL_FOO.abap", async () => {
  const r = await triggerWriteGate({ path: ".SapBuddy/output/ZCL_FOO.abap" }, "write")
  assert.equal(r?.block, true)
  assert.ok((r?.reason ?? "").includes(".SapBuddy/output/ZCL_FOO/ZCL_FOO.abap"), `类名应整体作为子目录，实际: ${r?.reason?.slice(0, 120)}`)
})

test("写错目录（非 .SapBuddy/output）拦截：提示给出正确路径", async () => {
  const r = await triggerWriteGate({ path: "deliverables/ZPPR085_CodeReview.html" }, "write")
  assert.equal(r?.block, true)
  assert.ok((r?.reason ?? "").includes(".SapBuddy/output/ZPPR085/ZPPR085_CodeReview.html"), `应给出正确路径，实际: ${r?.reason?.slice(0, 120)}`)
})

test("项目根 output/ 不再接受：要求改到 .SapBuddy/output（统一唯一输出目录）", async () => {
  const r = await triggerWriteGate({ path: "output/ZPPR085_CodeReview.html" }, "write")
  assert.equal(r?.block, true)
  assert.ok((r?.reason ?? "").includes(".SapBuddy/output/ZPPR085/ZPPR085_CodeReview.html"), `应提示改到 .SapBuddy/output，实际: ${r?.reason?.slice(0, 120)}`)
})

// ── 临时包 $TMP 写门禁（installWriteGate：create_object_programmatically 传 $TMP 需人工确认）────
const tmpObj = { objectType: "CLAS/OC", name: "ZTEST001", description: "测试对象", packageName: "$TMP" }

test("临时包写门禁：create_object_programmatically 传 $TMP 且未确认 → 拦截并提示需人工确认", async () => {
  clearWriteApproval()
  const r = await triggerWriteGate(tmpObj, "create_object_programmatically")
  assert.equal(r?.block, true)
  assert.ok((r?.reason ?? "").includes("$TMP") && (r?.reason ?? "").includes("需人工确认"),
    `应提示 $TMP 需人工确认，实际: ${r?.reason?.slice(0, 120)}`)
})

test("临时包写门禁：正式包 ZPKG 不触发 $TMP 确认（走通用写确认）", async () => {
  clearWriteApproval()
  const r = await triggerWriteGate({ ...tmpObj, packageName: "ZPKG" }, "create_object_programmatically")
  assert.equal(r?.block, true)
  assert.ok(!(r?.reason ?? "").includes("临时包 $TMP"), "正式包不应报 $TMP 专用确认")
  assert.ok((r?.reason ?? "").includes("写操作需人工确认"), `应走通用写确认，实际: ${r?.reason?.slice(0, 120)}`)
})

test("临时包写门禁：用户明确确认后 $TMP 放行（确认绑定被拦截的对象）", async () => {
  clearWriteApproval()
  // 真实流程：写被拦截（记录待批准对象 ZTEST001）→ 用户确认 → 重试放行
  const first = await triggerWriteGate(tmpObj, "create_object_programmatically")
  assert.equal(first?.block, true)
  handleUserMessage("确认，创建到 $TMP 测试")
  const r = await triggerWriteGate(tmpObj, "create_object_programmatically")
  assert.equal(r, undefined, "确认被拦截对象后重试应放行")
})

test("对象级确认：确认对象 A 后，窗口内写对象 B 仍拦截", async () => {
  clearWriteApproval()
  await triggerWriteGate(tmpObj, "create_object_programmatically") // 拦截 A，记录待批准 [ZTEST001]
  handleUserMessage("确认")
  // A 放行
  const a = await triggerWriteGate(tmpObj, "create_object_programmatically")
  assert.equal(a, undefined, "已确认的 A 应放行")
  // B（另一对象）在同一批准窗口内仍拦截
  const b = await triggerWriteGate({ ...tmpObj, name: "ZTEST002" }, "create_object_programmatically")
  assert.equal(b?.block, true, "未确认的 B 应拦截")
  assert.ok((b?.reason ?? "").includes("写操作需人工确认"), `B 应走通用写确认，实际: ${b?.reason?.slice(0, 80)}`)
})

// ── MCP 外部服务器写工具门禁（installWriteGate：mcp_abap_wiki_* 写工具一律直接拦截，不可确认放行）────
test("MCP 写工具门禁：obsidian 库 append/update/patch/delete/rename/create 全部拦截", async () => {
  clearWriteApproval()
  for (const t of ["append_to_note", "update_note", "patch_note", "delete_note", "rename_note", "create_note"]) {
    const r = await triggerWriteGate({ path: "ZFI001/program-ZFIR015_BANK_SERCH.md", content: "x" }, `mcp_abap_wiki_${t}`)
    assert.equal(r?.block, true, `${t} 应被拦截`)
    assert.ok((r?.reason ?? "").includes("知识库为只读参考"), `${t} 应提示知识库只读已直接拦截，实际: ${r?.reason?.slice(0, 80)}`)
  }
})

test("MCP 写工具门禁：只读 MCP 工具（read/search/list）不受影响", async () => {
  clearWriteApproval()
  for (const t of ["read_note", "read_multiple_notes", "search_notes", "list_notes", "list_templates"]) {
    const r = await triggerWriteGate({ path: "index.md" }, `mcp_abap_wiki_${t}`)
    assert.equal(r, undefined, `${t} 不应被拦截，实际: ${r?.reason?.slice(0, 80)}`)
  }
})

test("MCP 写工具门禁：用户确认后仍拦截（知识库只读，不可放行）", async () => {
  clearWriteApproval()
  handleUserMessage("确认，更新这条 wiki 记录")
  const r = await triggerWriteGate({ path: "ZFI001/program-ZFIR015_BANK_SERCH.md", content: "x" }, "mcp_abap_wiki_patch_note")
  assert.equal(r?.block, true, "确认后仍应拦截")
  assert.ok((r?.reason ?? "").includes("知识库为只读参考"), "应提示知识库只读已直接拦截，实际: " + (r?.reason ?? "").slice(0, 80))
})

test("MCP 写工具门禁：SAP 自带 mcp 读工具（abap_download 等）不误拦", async () => {
  clearWriteApproval()
  for (const t of ["abap_download", "execute_data_query", "get_tcode_info"]) {
    const r = await triggerWriteGate({}, `mcp_sap-mcp-dev_${t}`)
    assert.equal(r, undefined, `${t} 不应被拦截，实际: ${r?.reason?.slice(0, 80)}`)
  }
})

test("MCP 写工具门禁：仅 abap_wiki 受限，其他 MCP 服务器的写工具不拦截", async () => {
  clearWriteApproval()
  for (const t of ["append_note", "patch_note", "update_note", "delete_note", "create_record"]) {
    const r = await triggerWriteGate({ path: "a.md", content: "x" }, `mcp_notes_${t}`)
    assert.equal(r, undefined, `${t} 属于其他 MCP 服务器，不应被拦截，实际: ${r?.reason?.slice(0, 80)}`)
  }
})
