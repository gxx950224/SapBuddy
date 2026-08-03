/** 工具组：传输请求与文本元素（manage_transport_requests、manage_text_elements） */
import { z } from "zod"
import { session_types } from "abap-adt-api"
import { getClient } from "../adtManager.js"
import { requireObject, resolveConnectionId, toToolError, escapeXmlAttr, connectionIdSchema } from "./shared.js"

// ─── manage_transport_requests ──────────────────────────────────────────────
export const transportTool = {
  name: "manage_transport_requests",
  title: "Manage Transport Requests",
  write: true,
  description:
    "查询和管理传输请求（CTS）：列出用户的传输请求/任务、查看请求详情（对象列表）、按传输号查详情、修改请求描述、释放请求。用于了解变更内容和发布准备。\n" +
    "状态码：D=可修改(Modifiable)、R=已发布(Released)；释放请求前必须先释放其所有任务。",
  inputSchema: z.object({
    action: z
      .enum(["list_user_transports", "get_transport_details", "get_object_transport", "update_description", "release"])
      .describe("操作：list_user_transports=列出用户的请求; get_transport_details=按请求号查详情; get_object_transport=查对象所在请求; update_description=修改请求描述; release=释放请求（均需人工确认）"),
    transportNumber: z.string().optional().describe("传输请求/任务号，如 DEVK900001（get_transport_details/update_description 必填）"),
    description: z.string().optional().describe("新描述文本（update_description 必填）"),
    userName: z.string().optional().describe("用户名（list_user_transports 默认当前连接用户）"),
    objectName: z.string().optional().describe("对象名称（get_object_transport 必填）"),
    objectType: z.string().optional(),
    connectionId: connectionIdSchema,
  }),
  async execute(args: {
    action: string
    transportNumber?: string
    description?: string
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
                const st = req["tm:status"] === "D" ? "可修改" : req["tm:status"] === "R" ? "已发布" : (req["tm:status"] ?? "?")
                lines.push(`  ${group === "modifiable" ? "✏️" : "📦"} ${req["tm:number"]} [${st}] ${req["tm:desc"] ?? ""}`)
                for (const task of req.tasks ?? []) {
                  const tst = task["tm:status"] === "D" ? "可修改" : task["tm:status"] === "R" ? "已发布" : (task["tm:status"] ?? "?")
                  lines.push(`     └─ ${task["tm:number"]} [${tst}] ${task["tm:desc"] ?? ""}`)
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
            `状态: ${details["tm:status"] === "D" ? "可修改" : details["tm:status"] === "R" ? "已发布" : (details["tm:status"] ?? "?")} | 负责人: ${details["tm:owner"] ?? "?"}`,
            "",
            `对象列表（${details.objects?.length ?? 0} 个）:`,   ]
          for (const o of (details.objects ?? []).slice(0, 100)) {
            const cast = o as unknown as Record<string, unknown>
            const objName = String(cast["tm:obj_name"] ?? cast.objName ?? "?")
            const objType = String(cast["tm:obj_type"] ?? cast.objType ?? "?")
            lines.push(`  - ${objType} ${objName}`)
          }
          // ADT 对象列表可能为空（与 E071 不一致）→ 补底表查询更准确
          if ((details.objects ?? []).length === 0) {
            try {
              const q = await client.runQuery(`SELECT PGMID, OBJECT, OBJ_NAME FROM E071 WHERE TRKORR = '${String(args.transportNumber).replace(/'/g, "''")}'`, 100, true)
              const rows = q?.values ?? []
              if (rows.length) {
                lines[3] = `对象列表（${rows.length} 个，E071）:`
                for (const r of rows) lines.push(`  - ${r.OBJECT} ${r.OBJ_NAME}`)
              } else {
                lines.push("  （ADT 与 E071 均无对象记录）")
              }
            } catch {
              lines.push("  （E071 查询失败）")
            }
          }
          return lines.join("\n")
        }
        case "get_object_transport": {
          if (!args.objectName) return "get_object_transport 需要 objectName 参数。"
          const { findObject } = await import("./shared.js")
          const obj = await findObject(connId, args.objectName, args.objectType)
          if (!obj) return `未找到对象 ${args.objectName}。`
          const lines = [`对象 ${obj["adtcore:type"]} ${obj["adtcore:name"]} 的传输信息（含底表 E070/E071）:`, ""]
          try {
            // 1) ADT transportInfo
            const info = await client.transportInfo(obj["adtcore:uri"])
            if (info?.TRANSPORTS?.length) {
              for (const t of info.TRANSPORTS) {
                const st = t.TRSTATUS === "D" ? "可修改" : t.TRSTATUS === "R" ? "已发布" : (t.TRSTATUS ?? "?")
                lines.push(`- ${t.TRKORR} [${st}] ${t.AS4TEXT ?? ""}`)
              }
            }
            // 2) SQL 查 E071 关联请求 + E070 状态（更准确：含任务/父请求/目标系统，ADT 可能漏）
            const name = String(args.objectName || "").toUpperCase().replace(/'/g, "''")
            const q1 = await client.runQuery(`SELECT DISTINCT TRKORR FROM E071 WHERE OBJ_NAME = '${name}'`, 50, true)
            const trkorrs = [...new Set((q1?.values ?? []).map((r) => String(r.TRKORR ?? "").trim()).filter(Boolean))]
            if (trkorrs.length) {
              if (lines.length > 2) lines.push("")
              const q2 = `SELECT TRKORR, STRKORR, TARSYSTEM, TRSTATUS, AS4USER FROM E070 WHERE TRKORR IN ('${trkorrs.join("','")}')`
              const st = await client.runQuery(q2, 100, true)
              for (const r of st?.values ?? []) {
                const code = String(r.TRSTATUS ?? "")
                const stt = code === "D" ? "可修改" : code === "R" ? "已发布" : code
                lines.push(`- ${r.TRKORR} [${stt}] 目标:${r.TARSYSTEM ?? ""} 父:${r.STRKORR ?? "-"} 负责人:${r.AS4USER ?? ""}`)
              }
            }
            if (lines.length <= 2) lines.push("（无传输信息，对象可能无需传输）")
          } catch (e) {
            lines.push(`（底表查询失败: ${e instanceof Error ? e.message.slice(0, 80) : e}）`)
          }
          return lines.join("\n")
        }
        case "update_description": {
          if (!args.transportNumber) return "update_description 需要 transportNumber 参数。"
          if (!args.description) return "update_description 需要 description（新描述）参数。"
          // 读详情拿请求属性，再 PUT 完整 tm:request（实测 ADT 支持，未释放请求可改描述）
          const details = await client.transportDetails(args.transportNumber)
          const d = details as unknown as Record<string, string>
          const esc = escapeXmlAttr(String(args.description))
          const body = `<?xml version="1.0" encoding="ASCII"?><tm:root xmlns:tm="http://www.sap.com/cts/adt/tm"><tm:request tm:number="${args.transportNumber}" tm:owner="${d["tm:owner"] ?? ""}" tm:desc="${esc}" tm:type="${d["tm:type"] ?? "K"}" tm:status="${d["tm:status"] ?? "D"}" tm:target="${d["tm:target"] ?? ""}"/></tm:root>`
          await client.httpClient.request(`/sap/bc/adt/cts/transportrequests/${args.transportNumber}`, {
            method: "PUT",
            headers: {
              Accept: "application/vnd.sap.adt.transportorganizer.v1+xml",
              "Content-Type": "application/vnd.sap.adt.transportorganizer.v1+xml",
            },
            body,
          })
          return `✅ 传输请求 ${args.transportNumber} 描述已改为: ${args.description}`
        }
        case "release": {
          if (!args.transportNumber) return "release 需要 transportNumber 参数。"
          const lines = [`传输请求 ${args.transportNumber} 释放:`]
          // SAP 规则：释放请求前必须先释放其所有任务（subtasks）
          const details = await client.transportDetails(args.transportNumber)
          const tasks = (details.tasks ?? []).map((t) => (t as unknown as Record<string, string>)["tm:number"]).filter(Boolean)
          for (const t of tasks) {
            try {
              const tr = await client.transportRelease(t)
              lines.push(`  ✅ 任务 ${t}: ${tr?.[0]?.["chkrun:status"] ?? "released"}`)
            } catch (e) {
              lines.push(`  ⚠️ 任务 ${t} 释放失败: ${e instanceof Error ? e.message.slice(0, 100) : e}`)
            }
          }
          const reports = await client.transportRelease(args.transportNumber)
          for (const r of reports ?? []) {
            lines.push(`  ${r["chkrun:status"] === "released" ? "✅" : "❌"} ${r["chkrun:statusText"] ?? ""}`)
            for (const m of r.messages ?? []) {
              lines.push(`    [${String(m?.["chkrun:type"] ?? "")}] ${String(m?.["chkrun:shortText"] ?? "").slice(0, 150)}`)
            }
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
  write: true,
  title: "Manage Text Elements",
  description:
    "读取或修改对象的文本元素（text elements）：标题/文本符号（symbols）、选择文本（selections）、表头（headings）。" +
    "读取所有系统均支持；修改（update）需关闭只读模式，提供 elements 列表 [{id,text}]。\n" +
    "⚠️ 写的是对象主语言文本（通常英文）：要写中文/翻译必须先用本工具写英文主语言，再用 translate_text_pool 写中文翻译；直接写中文会被代码级拦截。" +
    "⚠️ 规则：symbols 的 id 为 3 字符（源码 TEXT-001 对应 id='001'）；工具自动补 maxLength（SAP 文本符号必须声明长度，缺失报 DS512）；" +
    "写入后自动激活。headings 的 id 如 listHeader/columnHeader_1；selections 的 id 为参数名（如 P_COMP）。" +
    "写前建议先 read 现有文本元素（避免重复符号）；修改时用 transportNumber 指定传输请求号。",
  inputSchema: z.object({
    action: z.enum(["read", "update"]).describe("read=读取文本元素; update=修改（需 readOnly=false）"),
    objectName: z.string().describe("对象名称"),
    objectType: z.string().describe("对象类型，如 PROG、CLAS、FUGR"),
    category: z.enum(["symbols", "selections", "headings"]).optional().describe("文本元素类别；update 时必填"),
    elements: z
      .array(z.object({ id: z.string().describe("符号 ID：symbols 用 3 字符键（'001' 对应源码 TEXT-001）；selections 用参数名（如 P_COMP）；headings 用 listHeader 等"), text: z.string().describe("文本内容") }))
      .optional()
      .describe("update 时必填：要写入的文本元素列表"),
    transportNumber: z.string().optional().describe("传输请求号（如 DEVK900001）。写文本元素时指定请求号；省略则用对象现有请求"),
    connectionId: connectionIdSchema,
  }),
  async execute(args: {
    action: string
    objectName: string
    objectType: string
    category?: string
    elements?: Array<{ id: string; text: string }>
    transportNumber?: string
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
      // ⛔ 代码级强制：文本元素写入的是对象主语言文本。直接写中文会把中文写进主语言位置，
      // 导致文本池语言不一致（维护时提示"显示不一致"、出现 I 前缀重复符号）。
      // 正确流程：① manage_text_elements 写英文主语言 → ② translate_text_pool(mode=set, targetLanguage='1') 写中文翻译。
      const cn = args.elements.find((e) => /[一-鿿]/.test(e.text))
      if (cn) {
        return (
          `⛔ 文本元素主语言禁止直接写中文（代码级强制，未写入）：${cn.id} = ${cn.text}\n` +
          `manage_text_elements 写的是对象主语言文本（通常英文），直接写中文会导致文本池语言不一致（显示不一致/重复符号）。\n` +
          `正确流程：\n` +
          `  ① 用 manage_text_elements（本工具）先写英文主语言文本：elements=[{id:'${cn.id}', text:'<英文>'}]\n` +
          `  ② 再用 translate_text_pool（mode='set', targetLanguage='1'）写中文翻译：texts=[{key:'${cn.id}', text:'${cn.text}'}]\n` +
          `  ③ 传输请求号：用 transportNumber 参数指定（如 manage_text_elements/translate_text_pool 都传）。\n` +
          `若对象主语言确实为中文（罕见），请用 translate_text_pool(targetLanguage='1') 直接写入。`
        )
      }
      // symbols 必须带 @MaxLength（SAP 校验，缺失报 DS512 文本池不一致）
      // ⚠️ ADT setTextElements 是全量替换语义：先读取现有 symbols 合并（新条目覆盖/新增，旧条目保留），
      // 避免只传新增条目导致原有 TEXT-001/002/003 等被删除
      let elements: unknown[] = args.elements
      if (args.category === "symbols") {
        try {
          const existing = await client.getTextElements(url, "symbols" as never)
          const merged = new Map<string, string>()
          for (const el of existing?.textElements ?? []) merged.set(el.id, el.text)
          for (const el of args.elements) merged.set(el.id, el.text)
          elements = [...merged.entries()].map(([id, text]) => ({ id, text, maxLength: Math.max(30, text.length) }))
        } catch {
          // 读取失败则仅用传入列表（不阻塞写入）
          elements = args.elements.map((e) => ({ ...e, maxLength: Math.max(30, e.text.length) }))
        }
      }
      const oldState = client.stateful
      client.stateful = session_types.stateful
      try {
        // 文本元素锁：锁 textelements URL（accessMode=MODIFY），而非对象 URI
        const lock = await client.lock(url, "MODIFY")
        try {
          const lockInfo = lock as { CORRNR?: string; IS_LOCAL?: string }
          // 传输请求号：优先用用户指定的 transportNumber；否则取对象现有请求（本地修改 CORRNR 可能为空）
          const transport = args.transportNumber ?? lockInfo.CORRNR
          await client.setTextElements(url, args.category as never, elements as never, lock.LOCK_HANDLE, transport)
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
