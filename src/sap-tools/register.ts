/**
 * 工具注册适配层：把 42 个 SAP 工具（zod schema）注册为 pi 的 customTools
 * 直接函数调用，不依赖 MCP 框架
 *
 * 代码级强制规则（不依赖 LLM 遵守，写工具内容写入前硬校验）：
 * 1. 开发客户端守卫：非开发类客户端拒绝一切写操作（assertDevClient）
 * 2. 硬编码中文扫描：写入代码含用户可见中文字面量 → 拒绝（必须走消息类/文本元素）
 * 3. 裸内置类型扫描：TYPE string/i/char1/c/n/p 等 → 拒绝（必须用 DDIC 数据元素）
 */
import { z } from "zod"
import { Type } from "typebox"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { tools } from "./tools/index.js"
import { assertDevClient } from "./adtManager.js"
import { resolveConnectionId } from "./tools/shared.js"

// ── 写操作人工确认（human-in-the-loop）──
// 所有写工具执行前必须获得用户确认：TUI 弹窗（CLI）或 Web 确认浮层（block 后重放）。
// 批准后有一个时间窗口，让 AI 一轮内连续完成多个写操作（create→replace→activate）无需逐次确认。
let writeApprovalUntil = 0
const WRITE_TOOL_NAMES = new Set(
  tools.filter((t) => t.write).map((t) => t.name).concat(["translate_text_pool", "manage_text_elements"]),
)
export function isWriteTool(name: string): boolean {
  return WRITE_TOOL_NAMES.has(name)
}
export function setWriteApprovalWindow(ms = 60_000): void {
  writeApprovalUntil = Date.now() + ms
}
export function isWriteApproved(): boolean {
  return Date.now() < writeApprovalUntil
}
export function clearWriteApproval(): void {
  writeApprovalUntil = 0
}

// ── 用户消息处理（确认词/拒绝词 → 授权窗口；CLI 与 Web 共用同一套规则）──
const CONFIRM_RE = /确认|同意|允许|批准|可以|好的|好，|好、|好 |ok|okay|yes|继续|执行|就这么办|没问题|没问题|行，|行 |行$|行，就|go ahead/i
const REJECT_RE = /拒绝|不要|取消|算了|不干|停止|换个方案|重新来|推翻|改回|不用了|撤回/i

/** 授权窗口毫秒数：读设置 .SapBuddy/settings.json 的 approvalWindowMinutes（默认 120 分钟） */
function approvalWindowMs(): number {
  try {
    const cfg = JSON.parse(readFileSync(join(process.cwd(), ".SapBuddy", "settings.json"), "utf8").toString())
    const m = Number(cfg.approvalWindowMinutes)
    if (m > 0 && Number.isFinite(m)) return m * 60 * 1000
  } catch { /* 默认 */ }
  return 2 * 60 * 60 * 1000
}

export function handleUserMessage(text: string): void {
  const t = String(text || "").trim()
  if (REJECT_RE.test(t)) {
    clearWriteApproval()
  } else if (CONFIRM_RE.test(t)) {
    // 授权窗口时长可配置（settings.approvalWindowMinutes，默认 120 分钟）
    setWriteApprovalWindow(approvalWindowMs())
  }
  // 中性/继续类消息不清除窗口，避免同一需求反复授权
}

/** 只读模式开关：settings.security.readOnly=true 时拒绝一切写工具（默认 false，靠确认机制） */
function isReadOnly(): boolean {
  try {
    const cfg = JSON.parse(readFileSync(join(process.cwd(), ".SapBuddy", "settings.json"), "utf8").toString())
    return cfg.security?.readOnly === true
  } catch { return false }
}

/**
 * 安装写操作拦截器（pi tool_call 事件）
 * - TUI/CLI：ctx.ui.confirm 原生确认弹窗
 * - Web/headless：block 并提示 AI 先展示计划，等待前端确认后重放（isWriteApproved）
 * @param onBlocked Web 模式回调（通知 server 广播确认浮层）
 */
export function installWriteGate(pi: ExtensionAPI, opts?: { onBlocked?: (info: { toolName: string; input: unknown }) => void }): void {
  pi.on("tool_call" as never, async (event: { toolName?: string; input?: unknown }, ctx: { hasUI?: boolean; ui?: { confirm?: (title: string, msg: string) => Promise<boolean> } }) => {
    const name = event?.toolName
    if (!name) return
    // ── 生成源码路径强制规则：ABAP 源码必须保存到 .SapBuddy/output/（相对路径 output/）──
    if ((name === "write" || name === "edit")) {
      const input = (event.input ?? {}) as Record<string, unknown>
      const p = String(input.path ?? input.file ?? "").replace(/\\/g, "/")
      const lower = p.toLowerCase()
      const isAbap = lower.endsWith(".abap")
      const inOutput =
        lower.startsWith("output/") || lower.includes("/output/") || lower.includes(".sapbuddy/output")
      if (isAbap && !inOutput) {
        return {
          block: true,
          reason:
            `⛔ 生成的 ABAP 源码必须统一保存到 output/ 目录（相对路径 .SapBuddy/output/），不要写到其他位置（如 ${p || "当前路径"}）。\n` +
            `请用 write 工具写入 output/<程序名>.abap（文件不存在会自动创建）。`,
        }
      }
      // ── 审查 HTML 报告需人工确认（代码审查产物，先展示结论再生成）──
      const isReviewHtml = /_CodeReview\.html$/i.test(lower) || /_code_review\.html$/i.test(lower)
      if (isReviewHtml && !isWriteApproved()) {
        if (ctx?.hasUI && typeof ctx.ui?.confirm === "function") {
          const ok = await ctx.ui.confirm("SapBuddy 审查报告确认", `AI 请求生成代码审查 HTML 报告：${p}\n\n允许生成吗？`)
          if (ok) return
          return { block: true, reason: "⛔ 用户拒绝了审查报告生成。请向用户说明审查结论（不生成文件）。" }
        }
        opts?.onBlocked?.({ toolName: name, input: event.input })
        return {
          block: true,
          reason:
            `⛔ 生成代码审查 HTML 报告需人工确认（已拦截，未生成）：${p}\n` +
            `请先把审查结论摘要展示给用户（发现的问题/风险/建议），并明确请求确认。\n` +
            `用户在对话中输入"确认"后重试即可生成报告文件。`,
        }
      }
    }
    if (!isWriteTool(name)) return
    // 只读模式开关（settings.security.readOnly=true 时全部写操作拒绝）
    if (isReadOnly()) {
      return {
        block: true,
        reason: `⛔ 当前为只读模式（security.readOnly=true），写操作已禁止：${name}\n请在设置中关闭只读模式后再试。`,
      }
    }
    // 批准窗口内放行（Web 确认后 AI 重放）
    if (isWriteApproved()) return
    if (ctx?.hasUI && typeof ctx.ui?.confirm === "function") {
      // CLI/TUI：原生确认弹窗
      const summary = JSON.stringify(event.input ?? {})?.slice(0, 300)
      const ok = await ctx.ui.confirm("SapBuddy 写操作确认", `AI 请求执行写操作：${name}\n${summary}\n\n允许执行吗？`)
      if (ok) return
      return { block: true, reason: `⛔ 用户拒绝了写操作 ${name}。请调整方案，不要再次尝试该写操作。` }
    }
    // Web/headless：拦截并提示 AI 先出计划，等待用户手动输入确认
    opts?.onBlocked?.({"toolName": name, "input": event.input})
    return {
      block: true,
      reason:
        `⛔ 写操作需人工确认（已拦截，未执行）：${name}\n` +
        `请先把本次改动计划完整展示给用户（改哪个对象/文件、具体改动内容），并明确请求确认。\n` +
        `用户在对话中输入"确认/同意/可以/执行"后重试本工具即可放行；若用户提出修改意见，则按新需求调整计划后再请求确认。`,
    }
  })
}

/**
 * 扫描 ABAP 代码：硬编码中文文案 + 裸内置类型
 * @returns 违规列表（空 = 通过）
 */
export function scanCodeViolations(code: string): string[] {
  const violations: string[] = []
  if (!code) return violations
  const lines = code.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    // 去掉 ABAP 注释（" 之后到行尾），避免误报注释中的中文/类型
    const noComment = raw.split('"')[0]

    // 1) 硬编码中文：单引号字符串字面量含中文（MESSAGE WITH '中文'、VALUE #( message = '中文' ) 等）
    const cnMatches = noComment.match(/'([^']*[\u4e00-\u9fa5][^']*)'/g)
    if (cnMatches) {
      for (const m of cnMatches) {
        const text = m.slice(1, -1)
        // 允许中文变量名/字段名等非常规场景极少，一律视为文案违规（规范要求走消息类/文本元素）
        violations.push(`第 ${i + 1} 行：硬编码中文文案 ${text.length > 20 ? text.slice(0, 20) + "…" : text}（必须改为消息类 MESSAGE e001(zxxx) 或文本元素 TEXT-xxx）`)
      }
    }

    // 2) 裸内置类型：TYPE string / TYPE i / TYPE char1 / TYPE c / TYPE n / TYPE p / TYPE int4 等
    //    排除：TYPE REF TO、TYPE TABLE OF、TYPE LINE OF、TYPE abap_*（ABAP 内建元素）、TYPE sy-*
    const compositeRe = /TYPE\s+(REF|TABLE|LINE|STANDARD|SORTED|HASHED)\s+/i
    const banned = new Set([
      "c", "n", "i", "p", "string", "xstring", "d", "t", "decfloat16", "decfloat34",
      "int1", "int2", "int4", "int8", "char1", "char2", "char3", "char4",
      "char10", "char12", "char20", "char30", "char40", "char50", "char60",
      "char80", "char100", "char120", "char132", "char133", "char200", "char255",
      "numc2", "numc3", "numc4", "numc5", "numc6", "numc8", "numc10",
      "dats", "tims", "tstmp", "raw", "rawstring", "unit", "curr", "quan",
    ])
    // 一行内可能有多个 TYPE（如 DATA: a TYPE i, b TYPE string.）→ 全部检查
    const typeTokens = noComment.matchAll(/TYPE\s+([a-z]\w*)/gi)
    for (const m of typeTokens) {
      const t = m[1].toLowerCase()
      if (banned.has(t)) {
        violations.push(`第 ${i + 1} 行：裸内置类型 TYPE ${t.toUpperCase()}（必须使用 DDIC 数据元素/结构，找不到标准元素时创建 Z 数据元素 + 域）`)
      }
    }
    // 复合类型声明行单独跳过（避免误报 TYPE 后跟 REF/TABLE 等）——matchAll 已按 token 判断，此处无需额外处理
  }
  return violations
}


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
  // 加载期不能调 getAllTools（action method），直接注册（同名前缀工具极少冲突）
  for (const t of tools) {
    pi.registerTool({
      name: t.name,
      label: t.title ?? t.name,
      description: `[SAP ABAP] ${t.description}
connectionId 缺省用 get_connected_systems 第一个。`,
      promptSnippet: "SAP ABAP 工具（搜索/读取/分析/编辑 SAP 对象、执行 ATC/单测/SQL 等）",
      parameters: jsonSchemaToTypeboxCompact(t.inputSchema) as never,
      async execute(_toolCallId, params) {
        try {
          const p = (params ?? {}) as Record<string, unknown>
          // 写操作安全守卫：非开发客户端（T000.CCCATEGORY）拒绝一切代码修改
          if (t.write) {
            const connId = await resolveConnectionId(p.connectionId as string | undefined)
            await assertDevClient(connId)
          }
          // 内容级强制规则：写入代码前硬校验（硬编码中文 / 裸内置类型）
          if (t.name === "replace_string_in_abap_object" && typeof p.newString === "string") {
            const violations = scanCodeViolations(p.newString)
            if (violations.length > 0) {
              return {
                content: [{
                  type: "text" as const,
                  text: `⛔ 代码级规则拦截（不依赖 AI 自觉，写前硬校验）：\n${violations.join("\n")}\n\n请修正后重试：硬编码中文 → 消息类/文本元素；裸内置类型 → DDIC 数据元素（找不到则创建 Z 元素 + 域）。`,
                }],
                details: {},
                isError: true,
              }
            }
          }
          const text = await t.execute((params ?? {}) as Record<string, unknown>)
          return { content: [{ type: "text" as const, text }], details: {} }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return {
            content: [{ type: "text" as const, text: `SAP 工具 ${t.name} 执行失败: ${msg}` }],
            details: {},
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
