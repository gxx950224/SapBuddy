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
              const q2 = `SELECT TRKORR, STRKORR, TARSYSTEM, TRSTATUS, AS4USER FROM E070 WHERE TRKORR IN (${trkorrs.map((t) => `'${t.replace(/'/g, "''")}'`).join(",")})`
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
          // ⛔ 所有拼进 XML 属性的值一律转义（含 transportNumber/owner/type/status/target），
          // 防止请求号或详情文本含引号/& 等字符时注入额外 XML 属性。
          const esc = (v: unknown) => escapeXmlAttr(String(v ?? ""))
          const body = `<?xml version="1.0" encoding="ASCII"?><tm:root xmlns:tm="http://www.sap.com/cts/adt/tm"><tm:request tm:number="${esc(args.transportNumber)}" tm:owner="${esc(d["tm:owner"])}" tm:desc="${esc(args.description)}" tm:type="${esc(d["tm:type"])}" tm:status="${esc(d["tm:status"])}" tm:target="${esc(d["tm:target"])}"/></tm:root>`
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
    "读取与写入对象的文本元素（text elements）：标题/文本符号（symbols）、选择文本（selections）、表头（headings）。" +
    "**新增/修改文本元素用 action='update'**（写入自动把程序对象 R3TR PROG（含文本池）挂载进传输请求，传 transportNumber 或沿用对象现有请求——这是把文本池随程序对象带进请求的正确方式）。" +
    "写入使用 ADT 通道、自动处理合并（新条目覆盖/新增、旧条目保留）与激活。写中文需先经用户确认（传 allowChinese=true）。" +
    "仅当需要**翻译**（写非主语言的翻译文本）时才改用 translate_text_pool；translate_text_pool 直接写数据库、不自己挂载对象。" +
    "读取规则：symbols 的 id 为 3 字符（源码 TEXT-001 对应 id='001'）；selections 的 id 为参数名（如 P_COMP）；headings 的 id 如 listHeader/columnHeader_1。",
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
    allowChinese: z
      .boolean()
      .optional()
      .describe("确认写入中文文本元素。默认禁止；用户明确要求写中文时传 true。会把中文写入对象语言位置，可能影响文本池语言一致性"),
    connectionId: connectionIdSchema,
  }),
  async execute(args: {
    action: string
    objectName: string
    objectType: string
    category?: string
    elements?: Array<{ id: string; text: string }>
    transportNumber?: string
    allowChinese?: boolean
    connectionId?: string
  }): Promise<string> {
    try {
      const connId = await resolveConnectionId(args.connectionId)
      const client = await getClient(connId)
      const { textElementsUrl } = await import("abap-adt-api")

      // ⛔ 函数组主程序归一化：SAPL* 主程序（如 SAPLZBCG004AA）走 PROG 路径会报 CUA 错误
      // （"系统XX不是中央用户管理的一部分"）；必须按函数组（FUGR）读取，名称去掉 SAPL 前缀。
      let objName = args.objectName
      let objType = args.objectType
      const upperName = objName.toUpperCase()
      if (upperName.startsWith("SAPL") && /^SAPL[A-Z0-9_]{0,20}$/.test(upperName)) {
        objName = upperName.slice(4)
        objType = "FUGR"
      }

      const url = textElementsUrl(objType, objName)
      if (args.action === "read") {
        const categories = args.category ? [args.category] : ["symbols", "selections", "headings"]
        const lines = [`文本元素 for ${objType} ${objName}:`, ""]
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
      // ⚠️ 文本元素写入的是对象语言位置的文本。写中文可能把中文写进主语言位置，导致文本池语言不一致
      // （维护时提示"显示不一致"、出现 I 前缀重复符号）。不再代码级强拦，改为提示用户确认是否调整：
      // 用户明确要求写中文 → 传 allowChinese=true；要求改英文 → 把 elements 里中文换成英文。
      const cn = args.elements.find((e) => /[一-鿿]/.test(e.text))
      if (cn && !args.allowChinese) {
        const cnList = args.elements.filter((e) => /[一-鿿]/.test(e.text)).map((e) => `  ${e.id}: ${e.text}`).join("\n")
        return (
          `⚠️ 检测到文本元素含中文（未写入）：\n${cnList}\n` +
          `manage_text_elements 写入的是对象语言位置的文本。若对象主语言不是中文，把中文写进主语言位置会导致文本池语言不一致（显示不一致/重复符号）。\n` +
          `请选择：\n` +
          `  ① 继续写中文 → 以 allowChinese=true 重新调用本工具（适用于对象主语言确为中文，或你确认要这么写）。\n` +
          `  ② 调整成英文 → 把 elements 里中文换成英文后重新调用。\n` +
          `  ③ 若是翻译（写非主语言的中文译文）→ 改用 translate_text_pool（mode='set', targetLanguage='1'）写入；请先用本工具写主语言文本元素以把对象挂载进传输请求。`
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
          // 读取失败必须中止：setTextElements 是全量替换语义，若退化为"只写传入列表"会把
          // 原有 TEXT-001/002 等符号全部清空还报成功（数据丢失伪装成功）。宁可让用户重试。
          throw new Error(
            `读取现有文本元素失败，已中止写入（避免全量覆盖清空原有符号）。` +
            `请检查连接/权限后重试，或先用 action="read" 确认当前文本元素内容。`
          )
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
        await client.activate(objName.toUpperCase(), url)
      } finally {
        client.stateful = oldState
      }
      return (
        `✅ 文本元素已写入并激活 ${objType} ${objName}（${args.category}，${args.elements.length} 个）:\n` +
        args.elements.map((e) => `  ${e.id}: ${e.text}`).join("\n")
      )
    } catch (err) {
      return toToolError(err)
    }
  },
}
