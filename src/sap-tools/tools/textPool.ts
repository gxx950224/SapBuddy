/**
 * 程序文本元素(text pool)按语言翻译工具
 *
 * SAP text pool 通过 READ TEXTPOOL / INSERT TEXTPOOL 语句按语言读写。
 * 本工具生成可执行类在 SAP 内执行：
 *  - copy 模式：把源语言 text pool 复制为指定目标语言
 *  - set 模式：按 [{key,text}] 写入目标语言（key: T=标题/描述, I=文本符号 TEXT-xxx, S=选择文本）
 * 程序描述(SE38标题)即 text pool 的 KEY='T' 条目。
 */
import { z } from "zod"
import { randomUUID } from "node:crypto"
import { session_types, objectPath } from "abap-adt-api"
import { getClient } from "../adtManager.js"
import { resolveConnectionId, toToolError, connectionIdSchema } from "./shared.js"

const abapStr = (s: string) => `'${s.replace(/'/g, "''")}'`

/** 生成可执行类源码 */
function generateClassSource(className: string, mode: "copy" | "set", opts: {
  prog: string
  srcLang?: string
  tgtLang: string
  texts?: Array<{ key: string; text: string }>
}): string {
  const progUpper = opts.prog.toUpperCase()
  const L: string[] = []
  L.push("  METHOD if_oo_adt_classrun~main.")
  // READ/INSERT TEXTPOOL 要求行结构与 text pool 兼容：用系统类型 TABLE OF textpool；
  // INSERT TEXTPOOL ... FROM 接收整个内表（不是逐行）；计数用字符串模板（CONCATENATE 不接受数字）
  L.push("    DATA: lt_tp TYPE TABLE OF textpool, ls_tp LIKE LINE OF lt_tp, lv_ins TYPE i, lv_upd TYPE i.")

  if (mode === "copy") {
    L.push(`    READ TEXTPOOL ${abapStr(progUpper)} INTO lt_tp LANGUAGE ${abapStr(opts.srcLang ?? "1")}.`)
    L.push(`    INSERT TEXTPOOL ${abapStr(progUpper)} FROM lt_tp LANGUAGE ${abapStr(opts.tgtLang)}.`)
    L.push("    DATA(lv_msg) = |copied { lines( lt_tp ) } entries|.")
    L.push("    out->write( lv_msg ).")
  } else {
    L.push(`    READ TEXTPOOL ${abapStr(progUpper)} INTO lt_tp LANGUAGE ${abapStr(opts.tgtLang)}.`)
    for (const t of opts.texts ?? []) {
      const key = t.key.toUpperCase()
      L.push(`    READ TABLE lt_tp INTO ls_tp WITH KEY key = ${abapStr(key)}.`)
      L.push("    IF sy-subrc = 0.")
      L.push(`      ls_tp-entry = ${abapStr(t.text)}. MODIFY lt_tp FROM ls_tp INDEX sy-tabix. lv_upd = lv_upd + 1.`)
      L.push("    ELSE.")
      L.push(`      CLEAR ls_tp. ls_tp-key = ${abapStr(key)}. ls_tp-entry = ${abapStr(t.text)}. APPEND ls_tp TO lt_tp. lv_ins = lv_ins + 1.`)
      L.push("    ENDIF.")
    }
    L.push(`    INSERT TEXTPOOL ${abapStr(progUpper)} FROM lt_tp LANGUAGE ${abapStr(opts.tgtLang)}.`)
    L.push("    DATA(lv_msg2) = |added { lv_ins } updated { lv_upd }|.")
    L.push("    out->write( lv_msg2 ).")
  }
  L.push("    COMMIT WORK.")
  L.push("  ENDMETHOD.")

  return (
    `CLASS ${className} DEFINITION\n` +
    `  PUBLIC\n` +
    `  CREATE PUBLIC .\n\n` +
    `  PUBLIC SECTION.\n` +
    `    INTERFACES if_oo_adt_classrun.\n` +
    `  PROTECTED SECTION.\n` +
    `  PRIVATE SECTION.\n` +
    `ENDCLASS.\n\n` +
    `CLASS ${className} IMPLEMENTATION.\n` +
    L.join("\n") +
    `\nENDCLASS.`
  )
}

export const translateTextPoolTool = {
  name: "translate_text_pool",
  write: true,
  title: "Translate Text Pool (Program Text Elements)",
  description:
    "程序文本池多语言翻译工具：用户要求翻译/多语言/文本池/加英文/复制语言/中文文本时用本工具。" +
    "中文文本元素（如符号/选择文本的简体中文）一律用本工具写入（targetLanguage='1'），不要用 manage_text_elements 直接写中文。" +
    "按指定语言翻译/写入程序文本元素（text pool）：文本符号 TEXT-xxx、选择文本、程序描述（标题，KEY='T'）。" +
    "两种模式：copy（把源语言 text pool 整体复制为目标语言）或 set（按 [{key,text}] 覆盖/新增指定条目）。" +
    "key: T=程序描述/标题, I=文本符号(如 '001' 对应 TEXT-001), S=选择文本(如 'P_COMP')。" +
    "语言键: 1=中文简体, M=繁体, E=英文, D=德文 等。写入后自动激活；文本池随传输请求传输（无需 SE63）。",
  inputSchema: z.object({
    objectName: z.string().describe("程序名，如 ZAIR004"),
    mode: z.enum(["copy", "set"]).describe("copy=复制源语言 text pool; set=按 key 覆盖/新增"),
    targetLanguage: z.string().describe("目标语言键（如 'E'、'1'、'M'）"),
    sourceLanguage: z.string().optional().describe("copy 模式：源语言键，默认 '1'（主语言）"),
    texts: z
      .array(z.object({ key: z.string().describe("text pool key: T=描述/标题, I=符号(001), S=选择文本(P_COMP)"), text: z.string().describe("文本内容") }))
      .optional()
      .describe("set 模式：要写入的条目"),
    connectionId: connectionIdSchema,
  }),
  async execute(args: {
    objectName: string
    mode: string
    targetLanguage: string
    sourceLanguage?: string
    texts?: Array<{ key: string; text: string }>
    connectionId?: string
  }): Promise<string> {
    try {
      const connId = await resolveConnectionId(args.connectionId)
      const client = await getClient(connId)
      const tgt = args.targetLanguage
      const src = args.sourceLanguage ?? "1"
      const prog = args.objectName.toUpperCase()

      if (args.mode === "set" && (!args.texts || args.texts.length === 0)) {
        return "set 模式需要 texts 参数（[{key, text}]，key: T/I/S）。"
      }

      const suffix = randomUUID().slice(0, 4).toUpperCase()
      const className = `ZCL_TPTRAN${suffix}`
      const uri = `/sap/bc/adt/oo/classes/${className.toLowerCase()}`
      const sourceUri = `${uri}/source/main`

      const source = generateClassSource(className, args.mode as "copy" | "set", {
        prog,
        srcLang: src,
        tgtLang: tgt,
        texts: args.texts,
      })

      await client.createObject({
        objtype: "CLAS/OC",
        name: className,
        parentName: "$TMP",
        description: "text pool 翻译(临时)",
        parentPath: objectPath("CLAS/OC", className, "$TMP"),
      })

      client.stateful = session_types.stateful
      try {
        const lock = await client.lock(sourceUri)
        try {
          await client.setObjectSource(sourceUri, source, lock.LOCK_HANDLE, undefined)
        } finally {
          await client.unLock(sourceUri, lock.LOCK_HANDLE).catch(() => undefined)
        }
      } finally {
        // 必须切回 stateless：若客户端还留在旧的 stateful 会话，该会话 RTTI 过时，
        // 激活/运行 classrun 会误报 "does not implement if_oo_adt_classrun~main"
        client.stateful = session_types.stateless
      }

      const act = await client.activate(className, uri)
      if (!act.success) {
        return `激活失败: ${act.messages?.map((m) => m.shortText).join("; ").slice(0, 200)}`
      }
      const result = String(await client.runClass(className)).trim()

      try {
        const oldState2 = client.stateful
        client.stateful = session_types.stateful
        const lock2 = await client.lock(uri).catch(() => undefined)
        if (lock2) {
          await client.deleteObject(uri, lock2.LOCK_HANDLE, undefined).catch(() => undefined)
          await client.unLock(uri, lock2.LOCK_HANDLE).catch(() => undefined)
        }
        client.stateful = oldState2
      } catch { /* 清理失败不影响结果 */ }

      if (/^Error:/i.test(result)) {
        return `❌ 程序 ${prog} 文本元素写入失败（目标语言 ${tgt}）：${result}`
      }
      return (
        `✅ 程序 ${prog} 文本元素已写入（目标语言 ${tgt}${args.mode === "copy" ? `，源语言 ${src}` : ""}）:\n` +
        result
      )
    } catch (err) {
      return toToolError(err)
    }
  },
}
