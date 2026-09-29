import { scanCodeViolations, validateSourceMode } from "./code-policy.js"
import { canonicalPath, bashCommandAllowed } from "./local-file-policy.js"
import { installLocalOperations } from "./local-operations.js"
import { runToolExecution, classifyFailure } from "./execution.js"
import { boundToolResult } from "./result.js"
/**
 * 工具注册适配层：把 41 个 SAP 工具（zod schema）注册为 pi 的 customTools
 * 直接函数调用，不依赖 MCP 框架
 *
 * 代码级强制规则（不依赖 LLM 遵守，写工具内容写入前硬校验）：
 * 1. 开发客户端守卫：非开发类客户端拒绝一切写操作（assertDevClient）
 * 2. 硬编码中文扫描：写入代码含用户可见中文字面量 → 拒绝（必须走消息类/文本元素）
 * 3. 裸内置类型扫描：自建结构/表（TYPES 定义、DDIC DSL 字段）用 string/i/char1 等 → 拒绝（程序内局部变量允许裸类型）
 */
import { z } from "zod"
import { Type } from "typebox"
import { readFileSync } from "node:fs"
import { join, relative, isAbsolute, sep, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { tools } from "./tools/index.js"
import { assertDevClient, withConnMutex, isConnectionDirty } from "./adtManager.js"
import { resolveConnectionId } from "./tools/shared.js"
import { resetActiveRequests } from "./taskTransport.js"
import { appendAudit } from "./auditLog.js"

// ── 写操作人工确认（human-in-the-loop）──
// 所有写工具执行前必须获得用户确认：TUI 弹窗（CLI）或 Web 确认浮层（block 后重放）。
// 批准后有一个时间窗口（默认 15 分钟，可配置 approvalWindowMinutes），窗口内放行全部写操作，
// 让 AI 一轮内连续完成多个写操作（create→replace→activate）无需逐次确认。
let writeApprovalUntil = 0
const WRITE_TOOL_NAMES = new Set(
  tools.filter((t) => t.write).map((t) => t.name),
)
export function isWriteTool(name: string, input?: unknown): boolean {
  const action = String((input as Record<string, unknown> | undefined)?.action ?? "")
  if (name === "manage_transport_requests" && ["list_user_transports", "get_transport_details", "get_object_transport"].includes(action)) return false
  if (name === "manage_text_elements" && action === "read") return false
  return WRITE_TOOL_NAMES.has(name)
}
export function setWriteApprovalWindow(ms = 60_000): void {
  writeApprovalUntil = Date.now() + ms
  // 新需求开始 → 共享传输请求重置，让本需求的对象用新请求（同需求内复用）
  resetActiveRequests()
}
export function isWriteApproved(): boolean {
  return Date.now() < writeApprovalUntil
}
export function clearWriteApproval(): void {
  writeApprovalUntil = 0
  // 需求取消/拒绝 → 共享请求一并清掉，避免残留影响下次
  resetActiveRequests()
}

/** 从写工具参数中提取对象名（统一大写；fileUri 取末段并去 /source/main 等子路径后缀）。
 * 除常规对象名外，也收集翻译工具的写目标（messageClass=消息类、prefix=DDIC 文本前缀、texts[].name=逐条对象名），
 * 保证审计日志能记录这类"写表"工具的改动范围。 */
export function extractObjectNames(input: unknown): string[] {
  const o = (input ?? {}) as Record<string, unknown>
  const out = new Set<string>()
  for (const key of ["name", "objectName", "className", "parentName"] as const) {
    const v = o[key]
    if (typeof v === "string" && v.trim()) out.add(v.trim().toUpperCase())
  }
  for (const key of ["messageClass", "prefix"] as const) {
    const v = o[key]
    if (typeof v === "string" && v.trim()) out.add(v.trim().toUpperCase())
  }
  const texts = o.texts
  if (Array.isArray(texts)) {
    for (const t of texts) {
      const n = (t as Record<string, unknown>)?.name
      if (typeof n === "string" && n.trim()) out.add(n.trim().toUpperCase())
    }
  }
  const uri = String(o.fileUri ?? "")
  if (uri) {
    const seg = uri.split("/").filter(Boolean).pop()
    if (seg) out.add(seg.replace(/\.\w+$/, "").toUpperCase())
  }
  return [...out]
}

// ── 用户消息处理（确认词/拒绝词 → 授权窗口；CLI 与 Web 共用同一套规则）──
// 只认明确批准词（确认/同意/批准…），避免日常应答（好的/可以/ok/行）无意中打开写授权窗口
// 批准词必须位于消息开头且作为独立短语；“确认连接”“继续分析”“已确认源码”不能打开写授权。
const CONFIRM_RE = /^(?:确认|同意|允许|批准|就这么办|执行|继续执行|go ahead)(?=$|[\s，,。.!！:：；;])/i
const REJECT_RE = /拒绝|不要|取消|算了|不干|停止|换个方案|重新来|推翻|改回|不用了|撤回|不执行|不能执行|先别|暂不|先不做|别急|别继续/i

/** 授权窗口毫秒数：读设置 .SapBuddy/settings.json 的 approvalWindowMinutes（默认 15 分钟） */
function approvalWindowMs(): number {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".SapBuddy", "settings.json"), "utf8").toString())
    const m = Number(cfg.approvalWindowMinutes)
    if (m > 0 && Number.isFinite(m)) return m * 60 * 1000
  } catch { /* 默认 */ }
  return 15 * 60 * 1000
}

export function handleUserMessage(text: string): void {
  const t = String(text || "").trim()
  if (REJECT_RE.test(t)) {
    clearWriteApproval()
  } else if (CONFIRM_RE.test(t)) {
    // 授权窗口时长可配置（settings.approvalWindowMinutes，默认 15 分钟）
    setWriteApprovalWindow(approvalWindowMs())
  }
  // 中性/继续类消息不清除窗口，避免同一需求反复授权
}

/** 只读模式开关：connections.json 的 security.readOnly 未明确为 false 即只读
 * （与网页端默认显示"已锁定"一致：没写该项 = 只读保护开启） */
function isReadOnly(): boolean {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".SapBuddy", "connections.json"), "utf8").toString())
    return cfg.security?.readOnly !== false
  } catch { return true } // 读取/解析失败时保守只读（fail-closed，与 config.ts 的 readOnly ?? true 一致）
}

/** 函数组内部程序是否属于客户命名空间：SAPL<FG>/L<FG><后缀>，所属函数组（FG）为 Z/Y 开头即为客户对象（SE38 可直接编辑） */
function isCustomerFunctionGroupProgram(name: string): boolean {
  return /^(SAPL|L)[ZY]/i.test(name)
}

/** 从 ADT 对象 URI（/sap/bc/adt/... 或 adt://host/...）提取对象名：
 * 从右往左跳过资源子路径段（source/main/includes/fmodules/subcomponents 等），取第一个名字段。 */
function objectNameFromUri(uri: string): string {
  let path = uri.trim()
  if (/^adt:\/\//i.test(path)) {
    try { path = new URL(path).pathname } catch { return "" }
  }
  const segs = path.split("/").filter(Boolean)
  const SKIP = new Set(["source", "main", "includes", "fmodules", "subcomponents", "fragments", "texts", "lines", "methods", "attributes", "events", "types"])
  while (segs.length && SKIP.has(segs[segs.length - 1].toLowerCase())) segs.pop()
  const name = segs.pop()
  return name ? name.toUpperCase() : ""
}

/** 命名空间强制：写操作对象名必须以 Z 或 Y 开头（SAP 标准对象只读不写）。
 * 函数组内部程序（SAPL<FG>/L<FG>*）按所属函数组判断：函数组为 Z/Y 开头时放行。
 * 只检查明确的"对象名"字段（name/objectName/className/parentName），传输请求号等不参与。
 * 返回违规说明；空串 = 通过。 */
export function namespaceViolation(input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>
  for (const key of ["name", "objectName", "className", "parentName"] as const) {
    const v = o[key]
    if (typeof v !== "string" || !v.trim()) continue
    const n = v.trim()
    if (/^[A-Za-z0-9_/-]+$/.test(n) && !/^[ZY]/i.test(n)) {
      // 函数组内部程序（SAPL<FG>/L<FG><后缀>）：所属函数组为 Z*/Y* 即为客户对象，放行
      if (isCustomerFunctionGroupProgram(n)) continue
      return `对象名 "${n}" 不是 Z*/Y* 开头（SAP 标准对象只读不写）。请确认对象名，或改用只读工具查询。`
    }
  }
  // 工具特定写目标：fix_ddic_text 的 prefix（copy 模式批量对象范围）、translate_message_class 的
  // messageClass（消息类，copy 可带 % 通配）——同样限定 Z*/Y*，否则 prefix="%" 可批量改全系统文本、
  // 消息类可写标准类（如 00）。去掉尾部通配符（ZE_% / Z*）后的字面部分必须 Z*/Y* 开头；全通配（%）视为违规。
  for (const key of ["prefix", "messageClass"] as const) {
    const v = o[key]
    if (typeof v !== "string" || !v.trim()) continue
    const n = v.trim()
    const literal = n.replace(/[%*]+$/, "").trim()
    if (!literal || (/^[A-Za-z0-9_/-]+$/.test(literal) && !/^[ZY]/i.test(literal))) {
      return `对象范围 "${n}" 不是 Z*/Y* 开头（SAP 标准对象只读不写）。请确认对象名，或改用只读工具查询。`
    }
  }
  // fileUri：按文件地址定位对象的写工具（如 replace_string_in_abap_object）只有 URI、没有上面的对象名字段，
  // 从 URI 提取对象名后同样做 Z*/Y* 校验，堵住"改标准对象不被命名空间卡"的口子。
  const fileUri = String(o.fileUri ?? "")
  if (fileUri) {
    const n = objectNameFromUri(fileUri)
    if (n && /^[A-Za-z0-9_/-]+$/.test(n) && !/^[ZY]/i.test(n) && !isCustomerFunctionGroupProgram(n)) {
      return `对象 "${n}"（来自 fileUri ${fileUri.slice(0, 60)}）不是 Z*/Y* 开头（SAP 标准对象只读不写）。请确认对象名，或改用只读工具查询。`
    }
  }
  return ""
}

/** 从文件名推断程序名（用于 output/<程序名>/ 子目录提示，让拦截后可直接照抄正确路径）：
 * ZPPR085_CodeReview.html → ZPPR085；ZAIR010.abap → ZAIR010；ZCL_FOO.abap → ZCL_FOO */
function inferProgramDir(basename: string): string {
  let stem = basename.replace(/\.(abap|md|html|txt|json|xml|yaml|yml)$/i, "")
  stem = stem.replace(/_(CodeReview|code_review|flowchart|flow_chart|review)(_\d+)?$/i, "")
  return stem
}

/**
 * 安装写操作拦截器（pi tool_call 事件）
 * - TUI/CLI：ctx.ui.confirm 原生确认弹窗
 * - Web/headless：block 并提示 AI 先展示计划，等待前端确认后重放（isWriteApproved）
 * @param onBlocked Web 模式回调（通知 server 广播确认浮层）
 */
export function installWriteGate(pi: ExtensionAPI, opts?: { onBlocked?: (info: { toolCallId?: string; toolName: string; input: unknown }) => void }): void {
  if (typeof pi.registerTool === "function") installLocalOperations(pi)
  pi.on("tool_call" as never, async (event: { toolCallId?: string; toolName?: string; input?: unknown }, ctx: { hasUI?: boolean; ui?: { confirm?: (title: string, msg: string) => Promise<boolean> } }) => {
    const name = event?.toolName
    if (!name) return
    const input = (event.input ?? {}) as Record<string, unknown>
    const p = String(input.path ?? input.file ?? input.filePath ?? "").replace(/\\/g, "/")
    let lower: string
    try { lower = canonicalPath(p).replace(/\\/g, "/").toLowerCase() }
    catch { return { block: true, reason: "⛔ 无法确认文件实际路径，已按安全策略拦截。" } }
    // ── 敏感配置保护：.SapBuddy 配置目录（连接凭据/API 密钥/模型/MCP 等）禁止由 AI 读写 ──
    const PROTECTED_CONFIG = ["connections.json", "auth.json", "settings.json", "models.json", "models-store.json", "mcp.json"]
    const READ_TOOLS = ["read", "glob", "grep", "find", "ls"]
    // Recursive searches must not start above protected roots; omitting path means cwd.
    if (["glob", "grep", "find"].includes(name)) {
      const root = join(dirname(fileURLToPath(import.meta.url)), "../..")
      const protectedRoots = [join(homedir(), ".SapBuddy"), ...["src", "dist", "test", "config", "docs"].map(d => join(root, d))]
      if (protectedRoots.some(dir => {
        const rel = relative(lower, canonicalPath(dir).toLowerCase())
        return !rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
      })) return { block: true, reason: "⛔ 搜索范围包含敏感配置或自身源码，请指定允许读取的具体子目录。" }
    }
    // bash 命令行工具不在 read/glob/grep 名单，输入字段是 command 而非 path —— 单独拦截涉及敏感路径/文件名的命令
    if (name === "bash") {
      const cmd = String((input as Record<string, unknown>).command ?? "").toLowerCase()
      const traversal = cmd.includes("..")
      const refsProtected = PROTECTED_CONFIG.some((f) => cmd.includes(f))
      if (!bashCommandAllowed(String(input.command ?? ""))) {
        const artifactCheck = !traversal && !refsProtected &&
          /\.sapbuddy[\\/]output([\\/]|[\s"']|$)/.test(cmd) &&
          [...cmd.matchAll(/\.sapbuddy[\\/]?([^\s"';&|]*)/g)].every(m => /^output([\\/]|$)/.test(m[1]))
        if (artifactCheck) return {
          block: true,
          reason: "⛔ 产物检查命令未执行：output 目录中的文件允许读取，但请使用 read 工具读取刚写入文件的完整路径，不要通过 bash 的 ls/wc/head/tail/cat 检查。\n" +
            "文件较长时使用 read 的 offset/limit 分段核对；此拦截不表示文件写入失败。不要重写文件、换用脚本或重复执行同类命令。只按实际读取结果报告检查结论，未统计时不要宣称精确字数。",
        }
        return {
          block: true,
          reason:
            `⛔ 命令行操作被安全拦截（不属于允许操作）：${String(input.command ?? "").slice(0, 120)}\n` +
            `仅允许打开产物、cat 读取上传文本、curl 查询 HTTPS；不执行任意脚本或复合命令。上传 Office 文件请读取已提取的 .txt 文件。`,
        }
      }
    }
    // 目录级拦截（P0-3）：path 落在 ~/.SapBuddy（output/skills/sessions/prompts/uploads 子树除外）即 block，
    // 不再依赖"文件名含 connections.json"这类字符串匹配——grep(path=".SapBuddy") 可绕过文件名匹配整目录扫描。
    // prompts/ 放行：SYSTEM.md 避坑记录要求 AI 读 ~/.SapBuddy/prompts/Memory.md 追加经验（非密钥）。
    // uploads/ 放行：用户上传的文件（如 zits004.xlsx.txt）AI 必须能读取用于分析，不能拦。
    if ([...READ_TOOLS, "write", "edit"].includes(name) && /\.sapbuddy(\/|$)/.test(lower)) {
      const rest = (lower.split(".sapbuddy").pop() ?? "").replace(/^[\\/]+/, "")
      const allowed = /^(output|skills|sessions|prompts|uploads)(\/|$)/.test(rest)
      if (!allowed) {
        return {
          block: true,
          reason:
            `⛔ .SapBuddy 配置目录${name === "write" || name === "edit" ? "禁止由 AI 直接修改" : "禁止由 AI 读取"}（已拦截）：${p}\n` +
            `安全配置（连接凭据 / API 密钥 / 模型 / MCP）仅限你本人手动查看 .SapBuddy/ 目录。`,
        }
      }
    }
    // 文件名级拦截（覆盖项目根等非 .SapBuddy 位置的配置副本）
    if (PROTECTED_CONFIG.some((f) => lower.includes(f))) {
      if (READ_TOOLS.includes(name)) {
        return {
          block: true,
          reason:
            `⛔ 敏感配置文件禁止由 AI 读取（已拦截）：${p}\n` +
            `安全配置（连接凭据 / API 密钥 / 模型 / MCP）仅限你本人手动查看 .SapBuddy/ 目录。`,
        }
      }
      if (name === "write" || name === "edit") {
        return {
          block: true,
          reason:
            `⛔ 配置文件禁止由 AI 直接修改（已拦截，未写入）：${p}\n` +
            `安全配置（连接凭据 / API 密钥 / 只读开关 / 模型 / MCP）只能由你在 .SapBuddy/ 目录手动编辑，改完重启服务生效。`,
        }
      }
    }
    // ── SapBuddy 自身源码/规则文件禁止由 AI 读写：运行中的助手不得改自己的代码 ──
    // 保留可编辑区：Memory.md（避坑记录）、.SapBuddy/（skills/output/sessions）、output/ 产物
    const SELF_CODE = [
      /(^|\/)src(?:\/|$)/, /(^|\/)dist(?:\/|$)/, /(^|\/)test(?:\/|$)/, /(^|\/)docs(?:\/|$)/,
      /(^|\/)config(?:\/|$)/, /(^|\/)\.claude(?:\/|$)/,
      /(^|\/)cli\.mjs$/, /(^|\/)package(?:-lock)?\.json$/, /(^|\/)tsconfig[^/]*\.json$/,
      /(^|\/)agents\.md$/, /(^|\/)system\.md$/, /(^|\/)readme\.md$/, /(^|\/)license$/,
      /(^|\/)credits\.md$/, /(^|\/)contributing\.md$/, /(^|\/)\.gitignore$/,
    ]
    if (SELF_CODE.some((re) => re.test(lower))) {
      if ([...READ_TOOLS, "write", "edit"].includes(name)) {
        return {
          block: true,
          reason:
            `⛔ SapBuddy 自身源码/规则文件禁止由 AI 读写（已拦截）：${p}\n` +
            `仅限开发者本人手动修改（或通过外部编辑器）。运行时对话中的助手不能改自己的代码。`,
        }
      }
    }
    // ── 生成产物路径强制规则：程序相关文件（Z*/Y* 开头：源码/审查报告/流程图等）必须保存到 output/<程序名>/ 子目录，通用文件才可平铺 ──
    if ((name === "write" || name === "edit")) {
      const isAbap = lower.endsWith(".abap")
      const isReviewHtml = /_CodeReview\.html$/i.test(lower) || /_code_review\.html$/i.test(lower)
      // 唯一输出目录：.SapBuddy/output（Web 产物树读此目录；项目根 output/ 是旧位置，不再接受）
      const inOutput = lower.includes(".sapbuddy/output/")
      // .SapBuddy/output 后必须带程序名子目录（如 .SapBuddy/output/ZAIR010/ZAIR010.abap），禁止平铺根目录
      const afterLower = lower.split(".sapbuddy/output/").pop() || ""
      const hasSubdir = afterLower.includes("/")
      // 提示用原始大小写 basename，确保建议路径保留程序名大小写（ZPPR085 而非 zppr085）
      const afterOrig = p.split(".SapBuddy/output/").pop() || p.split(".sapbuddy/output/").pop() || ""
      const basename = afterOrig.split("/").pop() || ""
      // 程序相关 = 文件名以 Z*/Y* 开头（程序源码、审查报告、流程图等）；与程序无关的通用文件（README 等）才可平铺
      const programRelated = /^[ZY][a-z0-9_]*/i.test(basename) || isAbap
      if (programRelated) {
        if (!inOutput) {
          return {
            block: true,
            reason:
              `⛔ 跟程序相关的文件必须统一保存到 ~/.SapBuddy/output/ 目录，不要写到其他位置（如 ${p || "当前路径"}）。\n` +
              `请用 write 工具直接写入正确路径：~/.SapBuddy/output/${inferProgramDir(basename)}/${basename}（目录不存在会自动创建）。`,
          }
        }
        if (!hasSubdir) {
          return {
            block: true,
            reason:
              `⛔ 跟程序相关的文件必须按程序名建文件夹，不要平铺在 ~/.SapBuddy/output/ 根目录（已拦截）：${p}\n` +
              `请改为写入：~/.SapBuddy/output/${inferProgramDir(basename)}/${basename}（目录不存在会自动创建）。\n` +
              `与程序无关的通用文件（如 README、说明文档）才可平铺在 ~/.SapBuddy/output/ 根目录。`,
          }
        }
      }
      // ── 审查 HTML 报告：人工确认（路径强制已由上面 programRelated 覆盖）──
      if (isReviewHtml && !isWriteApproved()) {
          if (ctx?.hasUI && typeof ctx.ui?.confirm === "function") {
            const ok = await ctx.ui.confirm("SapBuddy 审查报告确认", `AI 请求生成代码审查 HTML 报告：${p}\n\n允许生成吗？`)
            if (ok) return
            return { block: true, reason: "⛔ 用户拒绝了审查报告生成。请向用户说明审查结论（不生成文件）。" }
          }
          opts?.onBlocked?.({ toolCallId: event.toolCallId, toolName: name, input: event.input })
          return {
            block: true,
            reason:
              `⛔ 生成代码审查 HTML 报告需人工确认（已拦截，未生成）：${p}\n` +
              `请先把审查结论摘要展示给用户（发现的问题/风险/建议），并明确请求确认。\n` +
              `用户在对话中输入"确认"后重试即可生成报告文件。`,
          }
    }
    }
        // abap_wiki 知识库专用写门禁：mcp_abap_wiki_ 写类工具（append/create/update/patch/delete/rename 等）一律直接拦截，不可人工确认放行（知识库只读）；其他 MCP 服务器工具不拦截
    const ABAP_WIKI_WRITE_RE = /^mcp_abap_wiki_(append|create|update|patch|delete|rename|write|edit|move|remove|set)(_|$)/i
    if (ABAP_WIKI_WRITE_RE.test(name)) {
      opts?.onBlocked?.({ toolCallId: event.toolCallId, toolName: name, input: event.input })
      return {
        block: true,
        reason:
          `⛔ 知识库为只读参考，已直接拦截（未执行）：${name}\n` +
          `禁止向 abap_wiki 知识库做任何写入（创建/修改/删除笔记均不允许）。\n` +
          `如需新增或修改知识库分析，请提示用户手动在 Obsidian 中编辑，不要再次尝试写入。`,
      }
    }
    if (!isWriteTool(name, input)) return
    // 命名空间强制：只允许 Z*/Y*（代码级兜底，不依赖 LLM 遵守）
    const nsv = namespaceViolation(event.input)
    if (nsv) {
      appendAudit({ event: "blocked", tool: name, objects: extractObjectNames(input), reason: `namespace:${nsv.slice(0, 60)}` })
      return { block: true, reason: `⛔ 命名空间拦截（代码级强制）：${nsv}` }
    }
    // 只读模式开关（settings.security.readOnly=true 时全部写操作拒绝）
    if (isReadOnly()) {
      appendAudit({ event: "blocked", tool: name, objects: extractObjectNames(input), reason: "readonly" })
      return {
        block: true,
        reason: `⛔ 当前为只读模式（security.readOnly=true），写操作已禁止：${name}\n请在设置中关闭只读模式后再试。`,
      }
    }
    // 临时包 $TMP 专用确认：对象不进传输请求、无法发布，需用户明确同意（与常规写操作确认叠加）
    if (name === "create_object_programmatically") {
      const pkg = String((event.input as Record<string, unknown>)?.packageName || "").trim().toUpperCase()
      if (pkg === "$TMP" && !isWriteApproved()) {
        const warn =
          "AI 请求把对象创建到临时包 $TMP。$TMP 里的对象不关联传输请求，无法发布到正式系统，仅适合本地测试。确认这样创建吗？"
        if (ctx?.hasUI && typeof ctx.ui?.confirm === "function") {
          const ok = await ctx.ui.confirm("SapBuddy 临时包创建确认", warn)
          if (ok) return
          appendAudit({ event: "blocked", tool: name, objects: extractObjectNames(input), reason: "tmp:user_reject" })
          return { block: true, reason: "⛔ 用户拒绝了创建到 $TMP。请改为正式开发包，或先向用户确认测试意图。" }
        }
        opts?.onBlocked?.({ toolCallId: event.toolCallId, toolName: name, input: event.input })
        appendAudit({ event: "blocked", tool: name, objects: extractObjectNames(input), reason: "tmp:confirm_required" })
        return {
          block: true,
          reason:
            `⛔ 创建对象到临时包 $TMP 需人工确认（已拦截，未创建）。\n` +
            `请把要创建的对象（名称/类型/描述）和"写入 $TMP 临时包、不进传输请求"的意图完整展示给用户，并明确请求确认。\n` +
            `用户在对话中输入"确认/同意/批准/执行"后重试即可放行。`,
        }
      }
    }
    // 批准窗口内放行（用户确认后 AI 重放）。窗口时长默认 15 分钟（settings.approvalWindowMinutes 可配），
    // 窗口内放行全部写操作，无需逐次确认。
    if (isWriteApproved()) {
      appendAudit({ event: "approved", tool: name, objects: extractObjectNames(input), connectionId: String((input as Record<string, unknown>).connectionId ?? "") || undefined })
      return
    }
    if (ctx?.hasUI && typeof ctx.ui?.confirm === "function") {
      // CLI/TUI：原生确认弹窗
      const summary = JSON.stringify(event.input ?? {})?.slice(0, 300)
      const ok = await ctx.ui.confirm("SapBuddy 写操作确认", `AI 请求执行写操作：${name}\n${summary}\n\n允许执行吗？`)
      if (ok) {
        appendAudit({ event: "approved", tool: name, objects: extractObjectNames(input), connectionId: String((input as Record<string, unknown>).connectionId ?? "") || undefined, reason: "ui_confirm" })
        return
      }
      appendAudit({ event: "blocked", tool: name, objects: extractObjectNames(input), reason: "user_reject" })
      return { block: true, reason: `⛔ 用户拒绝了写操作 ${name}。请调整方案，不要再次尝试该写操作。` }
    }
    // Web/headless：拦截并提示 AI 先出计划，等待用户手动输入确认
    opts?.onBlocked?.({ toolCallId: event.toolCallId, toolName: name, input: event.input })
    appendAudit({ event: "blocked", tool: name, objects: extractObjectNames(input), connectionId: String((input as Record<string, unknown>).connectionId ?? "") || undefined, reason: "confirm_required" })
    return {
      block: true,
      reason:
        `⛔ 写操作需人工确认（已拦截，未执行）：${name}\n` +
        `请先把本次改动计划完整展示给用户（改哪个对象/文件、具体改动内容），并明确请求确认。\n` +
        `用户在对话中输入"确认/同意/批准/执行"后重试本工具即可放行；若用户提出修改意见，则按新需求调整方案后再请求确认。`,
    }
  })
}

export { scanCodeViolations } from "./code-policy.js"

/** JSON Schema → TypeBox（供 register.ts 与 MCP 工具注册共用） */
export function jsonSchemaToTypebox(schema: Record<string, unknown> | undefined): unknown {
  if (!schema || typeof schema !== "object") return Type.Unknown()
  const s = schema as {
    type?: string
    description?: string
    enum?: unknown[]
    items?: unknown
    properties?: Record<string, unknown>
    required?: string[]
  }
  const desc = typeof s.description === "string" ? s.description : undefined
  switch (s.type) {
    case "string": {
      if (Array.isArray(s.enum) && s.enum.length > 0) {
        const lits = s.enum.map((e) => Type.Literal(e as string | number | boolean))
        return lits.length === 1 ? lits[0] : Type.Union(lits as never)
      }
      return Type.String(desc ? { description: desc } : {})
    }
    case "number":
    case "integer":
      return Type.Number(desc ? { description: desc } : {})
    case "boolean":
      return Type.Boolean(desc ? { description: desc } : {})
    case "array":
      return Type.Array(jsonSchemaToTypebox(s.items as Record<string, unknown> | undefined) as never, desc ? { description: desc } : {})
    case "object": {
      const props: Record<string, unknown> = {}
      const required = new Set(Array.isArray(s.required) ? s.required : [])
      for (const [key, propSchema] of Object.entries(s.properties ?? {})) {
        const converted = jsonSchemaToTypebox(propSchema as Record<string, unknown> | undefined)
        props[key] = required.has(key) ? converted : Type.Optional(converted as never)
      }
      return Type.Object(props as never, desc ? { description: desc } : {})
    }
    default:
      return Type.Unknown()
  }
}

/** zod → JSON Schema → TypeBox（紧凑化：去掉 def/format/checks 等噪声，只留 AI 需要的 type/description/enum/properties） */
function compactize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map((x) => compactize(x))
  if (!node || typeof node !== "object") return node
  const n = node as Record<string, unknown>
  // 展开 def 包装（typebox 冗余结构）
  if (n.def) return compactize(n.def)
  // 仅处理"schema 结构节点"（有 type/enum/properties 等结构特征）；
  // 普通容器（如 properties 映射：key 是 action/transportNumber 等参数名）原样返回，防止误当 schema 节点丢失字段
  const SCHEMA_KEYS = ["type", "enum", "properties", "items", "required", "additionalProperties", "anyOf", "allOf", "oneOf"]
  if (!SCHEMA_KEYS.some((k) => n[k] !== undefined)) return n
  const out: Record<string, unknown> = {}
  for (const k of ["type", "description", "enum", "properties", "items", "required", "additionalProperties"]) {
    const v = n[k]
    if (v !== undefined && v !== null) out[k] = k === "properties" || k === "items" ? compactize(v) : v
  }
  if (n.type === "optional" && n.innerType) {
    // 保留可选语义（模型需知道可不传）
    const inner = compactize(n.innerType) as Record<string, unknown>
    return { ...inner, optional: true }
  }
  if (n.type === "union") {
    const opts = n.options as unknown[] | undefined
    const types = (opts || []).map((x: unknown) => compactize(x))
    return { type: "union", options: types }
  }
  return Object.keys(out).length ? out : n
}
function jsonSchemaToTypeboxCompact(schema: z.ZodType): unknown {
  try {
    const json = z.toJSONSchema(schema)
    return compactize(json as Record<string, unknown>)
  } catch {
    return Type.Unknown()
  }
}

/** 注册全部 SAP 工具到 pi（扩展加载期即可调用 registerTool） */
export function registerSapTools(pi: ExtensionAPI): number {
  let registered = 0
  // SDK ignores execute().isError; tool_result is the supported final status hook.
  pi.on?.("tool_result", event => {
    if ((event.details as { error?: unknown })?.error) return { isError: true }
  })
  // 加载期不能调 getAllTools（action method），直接注册（同名前缀工具极少冲突）
  for (const t of tools) {
    pi.registerTool({
      name: t.name,
      label: t.title ?? t.name,
      description: `[SAP ABAP] ${t.description}
connectionId 仅允许当前启用连接；省略时使用当前连接。禁止自动切换其他系统。`,
      promptSnippet: "SAP ABAP 工具（搜索/读取/分析/编辑 SAP 对象、执行 ATC/单测/SQL 等）",
      parameters: jsonSchemaToTypeboxCompact(t.inputSchema) as never,
      async execute(_toolCallId, params, signal): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; isError?: boolean }> {
        const write = isWriteTool(t.name, params)
        try {
          const p = (params ?? {}) as Record<string, unknown>
          // 连接变更强制重确认：连接配置被修改后，除 get_connected_systems 外一律拒绝，
          // 直到 get_connected_systems 成功清标记——防止 AI 拿着旧连接假设并行发请求被掐断
          if (t.name !== "get_connected_systems" && isConnectionDirty()) {
            return {
              content: [{ type: "text" as const, text: `⛔ SAP 连接配置已变更，必须先调用 get_connected_systems 确认当前连接，然后再重试本操作。` }],
              details: { error: { code: "CONNECTION_CHANGED", retryable: false } },
              isError: true,
            }
          }
          // 内容级强制规则：写入代码前硬校验（硬编码中文 / 裸内置类型）——纯本地检查，不触连接
          // 局部替换用 newString、整段覆盖用 fullSource，两者都检查（fullSource 是写函数模块的推荐路径，不能漏）
          if (t.name === "replace_string_in_abap_object") {
            validateSourceMode(p)
            const code = p.fullSource ?? p.newString
            if (typeof code === "string") {
              const violations = scanCodeViolations(code)
              if (violations.length > 0) {
                return {
                  content: [{
                    type: "text" as const,
                    text: `⛔ 代码级规则拦截（不依赖 AI 自觉，写前硬校验）：\n${violations.join("\n")}\n\n请修正后重试：硬编码中文 → 消息类/文本元素；自建结构/表字段裸内置类型 → DDIC 数据元素（找不到则创建 Z 元素 + 域）。`,
                  }],
                  details: { error: { code: "VALIDATION", retryable: false } },
                  isError: true,
                }
              }
            }
          }
          // 读/写并发策略：
          // - 写工具在工具级独占锁内执行（lock→改→存→激活 必须原子，防止 cookie jar / stateful
          //   会话被并行踩踏 → 解锁命中错误会话 → 残留编辑锁）
          // - 读工具直接执行，由客户端包装层的读闸门限制每连接并发读 ≤ READ_CONCURRENCY
          //   （防止一次分析几十个对象时对 SAP 打出请求洪峰）
          const connId = await resolveConnectionId(p.connectionId as string | undefined)
          const outcome = await runToolExecution(signal, async () => write
            ? await withConnMutex(connId, async () => {
                // 写操作安全守卫：非开发客户端（T000.CCCATEGORY）拒绝一切代码修改
                await assertDevClient(connId)
                return t.execute({ ...p, connectionId: connId })
              })
            : await t.execute({ ...p, connectionId: connId }))
          const text = outcome.value
          const failure = outcome.failures[0] ?? (/^(⛔|未找到 ABAP 对象|工具执行失败|SAP 工具 .*执行失败)/.test(text) ? classifyFailure(text) : undefined)
          // 写操作成功执行 → 记审计（谁/何时/改了哪个对象）
          if (write) {
            appendAudit({ event: failure ? "failed" : "executed", tool: t.name, objects: extractObjectNames(p), connectionId: connId, ...(failure ? { reason: failure.message.slice(0, 200) } : {}) })
          }
          const bounded = await boundToolResult(text)
          return { content: [{ type: "text" as const, text: bounded.text }], details: { ...bounded.details, ...(failure ? { error: { ...failure, retryable: !write && failure.retryable } } : {}) }, ...(failure ? { isError: true } : {}) }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (write) {
            appendAudit({ event: "failed", tool: t.name, objects: extractObjectNames(params), connectionId: String((params as Record<string, unknown>)?.connectionId ?? "") || undefined, reason: msg.slice(0, 200) })
          }
          return {
            content: [{ type: "text" as const, text: `SAP 工具 ${t.name} 执行失败: ${msg}` }],
            details: { error: { ...classifyFailure(err), retryable: !write && classifyFailure(err).retryable } },
            isError: true,
          }
        }
      },
    })
    registered++
  }
  return registered
}

/** 工具清单（供 cli tools 命令展示） */
export function listToolNames(): Array<{ name: string; write: boolean }> {
  return tools.map((t) => ({ name: t.name, write: !!t.write }))
}
