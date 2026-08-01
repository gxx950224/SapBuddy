/**
 * 工具注册适配层：把 42 个 SAP 工具（zod schema）注册为 pi 的 customTools
 * 方案 C：直接函数调用，无 MCP 服务器/进程/端口
 */
import { z } from "zod"
import { Type } from "typebox"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { tools } from "./tools/index.js"
import { assertDevClient } from "./adtManager.js"
import { resolveConnectionId } from "./tools/shared.js"

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
          // 写操作安全守卫：非开发客户端（T000.CCCATEGORY）拒绝一切代码修改
          if (t.write) {
            const p = (params ?? {}) as Record<string, unknown>
            const connId = await resolveConnectionId(p.connectionId as string | undefined)
            await assertDevClient(connId)
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
