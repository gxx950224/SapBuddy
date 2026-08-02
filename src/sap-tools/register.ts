/**
 * 工具注册适配层：把 42 个 SAP 工具（zod schema）注册为 pi 的 customTools
 * 方案 C：直接函数调用，无 MCP 服务器/进程/端口
 *
 * 代码级强制规则（不依赖 LLM 遵守，写工具内容写入前硬校验）：
 * 1. 开发客户端守卫：非开发类客户端拒绝一切写操作（assertDevClient）
 * 2. 硬编码中文扫描：写入代码含用户可见中文字面量 → 拒绝（必须走消息类/文本元素）
 * 3. 裸内置类型扫描：TYPE string/i/char1/c/n/p 等 → 拒绝（必须用 DDIC 数据元素）
 */
import { z } from "zod"
import { Type } from "typebox"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { tools } from "./tools/index.js"
import { assertDevClient } from "./adtManager.js"
import { resolveConnectionId } from "./tools/shared.js"

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
    const typeMatches = noComment.match(/TYPE\s+(REF\s+TO|TABLE\s+OF|LINE\s+OF|STANDARD\s+TABLE|SORTED\s+TABLE|HASHED\s+TABLE)/i)
    if (typeMatches) {
      // 复合类型声明，跳过（行内可能有多个 TYPE）
    }
    const bareType = noComment.match(/TYPE\s+([a-z]\w*)/i)
    if (bareType && !noComment.match(/TYPE\s+(REF|TABLE|LINE|STANDARD|SORTED|HASHED)\s+/i)) {
      const t = bareType[1].toLowerCase()
      const banned = new Set([
        "c", "n", "i", "p", "string", "xstring", "decfloat16", "decfloat34",
        "int1", "int2", "int4", "int8", "char1", "char2", "char3", "char4",
        "char10", "char12", "char20", "char30", "char40", "char50", "char60",
        "char80", "char100", "char120", "char132", "char133", "char200", "char255",
        "numc2", "numc3", "numc4", "numc5", "numc6", "numc8", "numc10",
        "dats", "tims", "tstmp", "raw", "rawstring", "unit", "curr", "quan",
      ])
      if (banned.has(t)) {
        violations.push(`第 ${i + 1} 行：裸内置类型 TYPE ${t.toUpperCase()}（必须使用 DDIC 数据元素/结构，找不到标准元素时创建 Z 数据元素 + 域）`)
      }
    }
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

/** zod → JSON Schema → TypeBox */
function zodToTypebox(schema: z.ZodType): unknown {
  try {
    const json = z.toJSONSchema(schema)
    return jsonSchemaToTypebox(json as Record<string, unknown>)
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
      description: `[SAP ABAP] ${t.description}\nSAP 连接：不确定 connectionId 时先调用 get_connected_systems。`,
      promptSnippet: "SAP ABAP 工具（搜索/读取/分析/编辑 SAP 对象、执行 ATC/单测/SQL 等）",
      parameters: zodToTypebox(t.inputSchema) as never,
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
