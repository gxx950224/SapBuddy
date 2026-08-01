/** 工具组：传输请求与文本元素（manage_transport_requests、manage_text_elements） */
import { z } from "zod"
import { session_types } from "abap-adt-api"
import { getClient } from "../adtManager.js"
import { requireObject, resolveConnectionId, toToolError, connectionIdSchema } from "./shared.js"

// ─── manage_transport_requests ──────────────────────────────────────────────
export const transportTool = {
  name: "manage_transport_requests",
  title: "Manage Transport Requests",
  description:
    "查询和管理传输请求（CTS）：列出用户的传输请求/任务、查看请求详情（对象列表）、按传输号查详情。用于了解变更内容和发布准备。",
  inputSchema: z.object({
    action: z
      .enum(["list_user_transports", "get_transport_details", "get_object_transport"])
      .describe("操作：list_user_transports=列出用户的请求; get_transport_details=按请求号查详情; get_object_transport=查对象所在请求"),
    transportNumber: z.string().optional().describe("传输请求/任务号，如 DEVK900001（get_transport_details 必填）"),
    userName: z.string().optional().describe("用户名（list_user_transports 默认当前连接用户）"),
    objectName: z.string().optional().describe("对象名称（get_object_transport 必填）"),
    objectType: z.string().optional(),
    connectionId: connectionIdSchema,
  }),
  async execute(args: {
    action: string
    transportNumber?: string
    userName?: string
    objectName?: string
    objectType?: string
    connectionId?: string
  }): Promise<string> {
    try {
      const connId = await resolveConnectionId(args.connectionId)
      const client = await getClient(connId)

      switch (args.action) {
        case "list_user_transports": {
          const user = args.userName ?? client.username
          const data = await client.userTransports(user, true)
          const targets = [...(data?.workbench ?? []), ...(data?.customizing ?? [])]
          const lines = [`用户 ${user} 的传输请求:`, ""]
          for (const t of targets) {
            lines.push(`📍 ${t["tm:name"]} ${t["tm:desc"] ?? ""}`)
            for (const group of ["modifiable", "released"] as const) {
              for (const req of t[group] ?? []) {
                lines.push(`  ${group === "modifiable" ? "✏️" : "📦"} ${req["tm:number"]} [${req["tm:status"] ?? "?"}] ${req["tm:desc"] ?? ""}`)
                for (const task of req.tasks ?? []) {
                  lines.push(`     └─ ${task["tm:number"]} [${task["tm:status"] ?? "?"}] ${task["tm:desc"] ?? ""}`)
                }
              }
            }
          }
          return lines.join("\n")
        }
        case "get_transport_details": {
          if (!args.transportNumber) return "get_transport_details 需要 transportNumber 参数。"
          const details = await client.transportDetails(args.transportNumber)
          const lines = [
            `传输 ${args.transportNumber}: ${details["tm:desc"] ?? ""}`,
            `状态: ${details["tm:status"] ?? "?"} | 负责人: ${details["tm:owner"] ?? "?"}`,
            "",
            `对象列表（${details.objects?.length ?? 0} 个）:`,
          ]
          for (const o of (details.objects ?? []).slice(0, 100)) {
            const cast = o as unknown as Record<string, unknown>
            const objName = String(cast["tm:obj_name"] ?? cast.objName ?? "?")
            const objType = String(cast["tm:obj_type"] ?? cast.objType ?? "?")
            lines.push(`  - ${objType} ${objName}`)
          }
          return lines.join("\n")
        }
        case "get_object_transport": {
          if (!args.objectName) return "get_object_transport 需要 objectName 参数。"
          const { findObject } = await import("./shared.js")
          const obj = await findObject(connId, args.objectName, args.objectType)
          if (!obj) return `未找到对象 ${args.objectName}。`
          const info = await client.transportInfo(obj["adtcore:uri"])
          const lines = [`对象 ${obj["adtcore:type"]} ${obj["adtcore:name"]} 的传输信息:`, ""]
          if (info?.TRANSPORTS) {
            for (const t of info.TRANSPORTS) {
              lines.push(`- ${t.TRKORR} [${t.TRSTATUS ?? "?"}] ${t.AS4TEXT ?? ""}`)
            }
          } else {
            lines.push("（无传输信息，对象可能无需传输）")
          }
          return lines.join("\n")
        }
        default:
          return `未知操作: ${args.action}`
      }
    } catch (err) {
      return toToolError(err)
    }
  },
}

// ─── manage_text_elements ───────────────────────────────────────────────────
export const textElementsTool = {
  name: "manage_text_elements",
  title: "Manage Text Elements",
  description:
    "读取或修改对象的文本元素（text elements）：标题/文本符号（symbols）、选择文本（selections）、表头（headings）。" +
    "读取所有系统均支持；修改（update）需关闭只读模式，提供 elements 列表 [{id,text}]。\n" +
    "⚠️ 规则：symbols 的 id 为 3 字符（源码 TEXT-001 对应 id='001'）；工具自动补 maxLength（SAP 文本符号必须声明长度，缺失报 DS512）；" +
    "写入后自动激活。headings 的 id 如 listHeader/columnHeader_1；selections 的 id 为参数名（如 P_COMP）。",
  inputSchema: z.object({
    action: z.enum(["read", "update"]).describe("read=读取文本元素; update=修改（需 readOnly=false）"),
    objectName: z.string().describe("对象名称"),
    objectType: z.string().describe("对象类型，如 PROG、CLAS、FUGR"),
    category: z.enum(["symbols", "selections", "headings"]).optional().describe("文本元素类别；update 时必填"),
    elements: z
      .array(z.object({ id: z.string().describe("符号 ID，如 TEXT-001"), text: z.string().describe("文本内容") }))
      .optional()
      .describe("update 时必填：要写入的文本元素列表"),
    connectionId: connectionIdSchema,
  }),
  async execute(args: {
    action: string
    objectName: string
    objectType: string
    category?: string
    elements?: Array<{ id: string; text: string }>
    connectionId?: string
  }): Promise<string> {
    try {
      const connId = await resolveConnectionId(args.connectionId)
      const client = await getClient(connId)
      const { textElementsUrl } = await import("abap-adt-api")

      const url = textElementsUrl(args.objectType, args.objectName)
      if (args.action === "read") {
        const categories = args.category ? [args.category] : ["symbols", "selections", "headings"]
        const lines = [`文本元素 for ${args.objectType} ${args.objectName}:`, ""]
        for (const cat of categories) {
          const result = await client.getTextElements(url, cat as never)
          const elements = result?.textElements ?? []
          lines.push(`【${cat}】(${elements.length} 个)`)
          if (elements.length === 0) {
            lines.push("  (空)")
            continue
          }
          for (const e of elements) {
            lines.push(`  ${e.id}: ${e.text}`)
          }
          lines.push("")
        }
        return lines.join("\n")
      }

      // ---- update：lock(textelements URL, MODIFY) → setTextElements → unlock → activate ----
      if (!args.category) return "update 需要指定 category（symbols/selections/headings）。"
      if (!args.elements || args.elements.length === 0) {
        return "update 需要提供 elements 列表，如 [{id:'001', text:'场景'}]（id 为 3 字符符号键）。"
      }
      // symbols 必须带 @MaxLength（SAP 校验，缺失报 DS512 文本池不一致）
      const elements = args.elements.map((e) =>
        args.category === "symbols"
          ? { ...e, maxLength: Math.max(30, e.text.length) }
          : e
      ) as never
      const oldState = client.stateful
      client.stateful = session_types.stateful
      try {
        // 文本元素锁：锁 textelements URL（accessMode=MODIFY），而非对象 URI
        const lock = await client.lock(url, "MODIFY")
        try {
          const lockInfo = lock as { CORRNR?: string; IS_LOCAL?: string }
          const transport = lockInfo.IS_LOCAL === "X" ? undefined : lockInfo.CORRNR
          await client.setTextElements(url, args.category as never, elements, lock.LOCK_HANDLE, transport)
        } finally {
          await client.unLock(url, lock.LOCK_HANDLE).catch(() => undefined)
        }
        // 文本元素写入后需激活（等价 abap_fs 的 activate(objectName, url)）
        await client.activate(args.objectName.toUpperCase(), url)
      } finally {
        client.stateful = oldState
      }
      return (
        `✅ 文本元素已写入并激活 ${args.objectType} ${args.objectName}（${args.category}，${args.elements.length} 个）:\n` +
        args.elements.map((e) => `  ${e.id}: ${e.text}`).join("\n")
      )
    } catch (err) {
      return toToolError(err)
    }
  },
}
