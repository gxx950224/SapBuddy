/**
 * 程序文本元素(text pool)按语言翻译工具
 *
 * SAP text pool 通过 READ TEXTPOOL / INSERT TEXTPOOL 语句按语言读写。
 * 本工具生成可执行类在 SAP 内执行：
 *  - list 模式：读取目标语言现有 text pool（输出 ID|KEY|文本，供核对真实 key/文本）
 *  - copy 模式：把源语言 text pool 复制为指定目标语言
 *  - set 模式：按 [{key,text}] 写入目标语言（key: T=标题/描述, I=文本符号 TEXT-xxx, S=选择文本）
 *  - delete 模式：按 deleteKeys 删除条目
 * 程序描述(SE38标题)即 text pool 的 KEY='T' 条目。
 */
import { z } from "zod"
import { randomUUID } from "node:crypto"
import { session_types, objectPath } from "abap-adt-api"
import { getClient } from "../adtManager.js"
import { resolveConnectionId, toToolError, connectionIdSchema } from "./shared.js"
import { resolveLanguageSpec, emitLangResolution, LANG_KEY_HELP } from "./languageKeys.js"

const abapStr = (s: string) => `'${s.replace(/'/g, "''")}'`

/** SAP 选择文本要求文字从第 9 列开始（前面必须空 8 格），否则 ADT/SE38 从第 9 列读取时会看不到；
 *  文本符号（ID=I）与标题无此要求。先去除文字已有前导空格再补足 8 格，保证重复写入幂等。 */
const padSelectionText = (text: string) => " ".repeat(8) + text.trimStart()

/** 文本符号键：1~3 位字母/数字（如 001、E01、TXT）都是文本符号（ID='I'）；
 *  其余（含下划线的选择参数名、更长标识等）视为选择文本（ID='S'）。
 *  ⚠️ 曾只认 3 位纯数字（/^\d{3}$/），导致 E01/S01/I01 这类带字母的符号被误写成选择文本（ID='S'）。 */
export const isTextSymbolKey = (key: string) => /^[A-Z0-9]{1,3}$/.test(key.toUpperCase())

/** 查 E071 里程序对象（R3TR PROG <prog>）所在的传输请求号列表 */
async function programTransportTrkorrs(client: { runQuery: Function }, prog: string): Promise<string[]> {
  const esc = prog.replace(/'/g, "''")
  const q = await client.runQuery(
    `SELECT DISTINCT TRKORR FROM E071 WHERE PGMID = 'R3TR' AND OBJECT = 'PROG' AND OBJ_NAME = '${esc}'`,
    50,
    true,
  )
  const rows = (q?.values ?? []) as Array<Record<string, unknown>>
  return [...new Set(rows.map((r) => String(r.TRKORR ?? "").trim()).filter(Boolean))]
}

/**
 * 检测程序对象（R3TR PROG <prog>）在传输请求里的情况，返回给用户的提示文本。
 * 文本池是挂在程序对象上传输的——翻译能否随请求走，就看程序对象在不在（可修改）请求里。
 * 用户指定了 transportNumber 时优先判断该请求；否则看程序对象在所有请求里的状态。
 */
async function detectProgramTransport(client: { runQuery: Function }, prog: string, transportNumber?: string): Promise<string> {
  const escProg = prog.replace(/'/g, "''")
  const trkorrs = await programTransportTrkorrs(client, prog)

  if (transportNumber) {
    const t = transportNumber.toUpperCase().replace(/'/g, "''")
    const inReqQ = await client.runQuery(
      `SELECT TRKORR FROM E071 WHERE PGMID = 'R3TR' AND OBJECT = 'PROG' AND OBJ_NAME = '${escProg}' AND TRKORR = '${t}'`,
      5,
      true,
    )
    const inReq = ((inReqQ?.values ?? []) as Array<unknown>).length > 0
    return inReq
      ? `✅ 程序对象（R3TR PROG ${prog}）在你指定的请求 ${transportNumber} 里，本次翻译会随程序对象一起传输。`
      : `⚠️ 你指定的请求 ${transportNumber} 里没有程序对象（R3TR PROG ${prog}）。文本池是随程序对象走的——请先用 manage_text_elements 写主语言文本元素把程序挂进该请求，或换成包含该程序对象的请求。`
  }

  if (trkorrs.length === 0) {
    return `⚠️ 程序对象（R3TR PROG ${prog}）未在任何传输请求里。文本池是随程序对象走的——请先用 manage_text_elements 写主语言文本元素把程序挂进请求，或传 transportNumber 指定请求号；否则翻译不会随请求传输。`
  }

  const st = await client.runQuery(
    `SELECT TRKORR, TRSTATUS FROM E070 WHERE TRKORR IN (${trkorrs.map((t) => `'${t.replace(/'/g, "''")}'`).join(",")})`,
    100,
    true,
  )
  const statusMap = new Map<string, string>(((st?.values ?? []) as Array<Record<string, unknown>>).map((r) => [String(r.TRKORR), String(r.TRSTATUS)]))
  const modifiable = trkorrs.filter((t) => statusMap.get(t) === "D")
  const released = trkorrs.filter((t) => statusMap.get(t) === "R")

  if (modifiable.length > 0) {
    return `✅ 程序对象（R3TR PROG ${prog}）已在可修改传输请求 ${modifiable.join(", ")} 中，本次翻译会跟程序对象一起传输。`
  }
  return `⚠️ 程序对象（R3TR PROG ${prog}）只在已释放的请求（${released.join(", ") || "无"}）里，没有可修改请求。文本池是随程序对象走的——请把程序放进一个可修改请求（用 manage_text_elements 激活，或传 transportNumber 指定），否则翻译不会随请求传输。`
}

/** 生成可执行类源码 */
export function generateClassSource(className: string, mode: "copy" | "set" | "delete" | "list", opts: {
  prog: string
  srcLang?: string
  tgtLang: string
  texts?: Array<{ key: string; text: string }>
  deleteKeys?: string[]
}): string {
  const progUpper = opts.prog.toUpperCase()
  const L: string[] = []
  L.push("  METHOD if_oo_adt_classrun~main.")
  // READ/INSERT TEXTPOOL 要求行结构与 text pool 兼容：用系统类型 TABLE OF textpool；
  // INSERT TEXTPOOL ... FROM 接收整个内表（不是逐行）；计数用字符串模板（CONCATENATE 不接受数字）
  L.push("    DATA: lt_tp TYPE TABLE OF textpool, ls_tp LIKE LINE OF lt_tp, lv_ins TYPE i, lv_upd TYPE i,")
  L.push("          lt_chk TYPE TABLE OF textpool, ls_chk LIKE LINE OF lt_chk, lv_err TYPE i,")
  L.push("          lv_tgt TYPE spras, lv_src TYPE spras.")
  // 语言键先在 SAP 内解析（VI 等特殊键从 T002 反查真实值），避免把乱码字符嵌进源码
  const tgtSpec = resolveLanguageSpec(opts.tgtLang) ?? { kind: "literal", char: opts.tgtLang }
  const srcSpec = resolveLanguageSpec(opts.srcLang) ?? { kind: "literal", char: opts.srcLang ?? "1" }

  if (mode === "copy") {
    L.push(...emitLangResolution("lv_src", srcSpec))
    L.push(...emitLangResolution("lv_tgt", tgtSpec))
    L.push(`    READ TEXTPOOL ${abapStr(progUpper)} INTO lt_tp LANGUAGE lv_src.`)
    L.push(`    INSERT TEXTPOOL ${abapStr(progUpper)} FROM lt_tp LANGUAGE lv_tgt.`)
    L.push("    DATA(lv_msg) = |copied { lines( lt_tp ) } entries|.")
    L.push("    out->write( lv_msg ).")
    L.push(`    READ TEXTPOOL ${abapStr(progUpper)} INTO lt_chk LANGUAGE lv_tgt.`)
    L.push("    IF lines( lt_chk ) <> lines( lt_tp ). lv_err = lv_err + 1. out->write( 'SELFCHECK-FAIL:copy-count' ). ENDIF.")
  } else if (mode === "set") {
    L.push(...emitLangResolution("lv_tgt", tgtSpec))
    L.push(`    READ TEXTPOOL ${abapStr(progUpper)} INTO lt_tp LANGUAGE lv_tgt.`)
    for (const t of opts.texts ?? []) {
      const key = t.key.toUpperCase()
      if (key === "T") {
        // 标题：text pool 里标题键是空串 ''，id='R'；垃圾键 'T' 需先删（曾导致标题重复）。
        // 先判存在性计数，再删旧行、追加 ID 正确的干净行（避免垃圾 ID 行被保留）。
        L.push("    READ TABLE lt_tp TRANSPORTING NO FIELDS WITH KEY key = ''.")
        L.push("    IF sy-subrc = 0. lv_upd = lv_upd + 1. ELSE. lv_ins = lv_ins + 1. ENDIF.")
        L.push(`    DELETE lt_tp WHERE key = ${abapStr(key)} OR key = ''.`)
        L.push(`    CLEAR ls_tp. ls_tp-id = ${abapStr("R")}. ls_tp-key = ''. ls_tp-entry = ${abapStr(t.text)}. APPEND ls_tp TO lt_tp.`)
      } else {
        // 符号(1~3位字母/数字) id='I'；选择文本(参数名) id='S'，且自动补 8 前导空格（SAP 要求从第 9 列读）。
        // ⛔ 必须显式设 id：曾漏设导致新写符号 id 为空，SAP 界面/ADT 只认 id='I' 的才是文本符号，
        //    结果写入成功但界面看不到。先删同键旧行（含垃圾 id 行）再追加，保证 ID 正确且不重复。
        const isSelection = !isTextSymbolKey(key)
        const entryText = isSelection ? padSelectionText(t.text) : t.text
        const id = isSelection ? "S" : "I"
        L.push(`    READ TABLE lt_tp TRANSPORTING NO FIELDS WITH KEY key = ${abapStr(key)}.`)
        L.push("    IF sy-subrc = 0. lv_upd = lv_upd + 1. ELSE. lv_ins = lv_ins + 1. ENDIF.")
        L.push(`    DELETE lt_tp WHERE key = ${abapStr(key)}.`)
        L.push(`    CLEAR ls_tp. ls_tp-id = ${abapStr(id)}. ls_tp-key = ${abapStr(key)}. ls_tp-entry = ${abapStr(entryText)}. APPEND ls_tp TO lt_tp.`)
      }
    }
    L.push(`    INSERT TEXTPOOL ${abapStr(progUpper)} FROM lt_tp LANGUAGE lv_tgt.`)
    // 写入后自检：重读目标语言池，逐条核对 key/ID/文本；对不上说明写入格式有问题（如漏 ID），
    // 界面/ADT 读不到，必须报错回滚而不是假装成功
    L.push(`    READ TEXTPOOL ${abapStr(progUpper)} INTO lt_chk LANGUAGE lv_tgt.`)
    L.push("    DATA(lv_msg2) = |added { lv_ins } updated { lv_upd }|.")
    L.push("    out->write( lv_msg2 ).")
    for (const t of opts.texts ?? []) {
      const key = t.key.toUpperCase()
      if (key === "T") {
        L.push("    READ TABLE lt_chk INTO ls_chk WITH KEY key = ''.")
        L.push(`    IF sy-subrc <> 0 OR ls_chk-id <> ${abapStr("R")} OR ls_chk-entry <> ${abapStr(t.text)}. lv_err = lv_err + 1.`)
        L.push("      out->write( 'SELFCHECK-FAIL:T' ). ENDIF.")
      } else {
        const isSelection = !isTextSymbolKey(key)
        const entryText = isSelection ? padSelectionText(t.text) : t.text
        const id = isSelection ? "S" : "I"
        L.push(`    READ TABLE lt_chk INTO ls_chk WITH KEY key = ${abapStr(key)}.`)
        L.push(`    IF sy-subrc <> 0 OR ls_chk-id <> ${abapStr(id)} OR ls_chk-entry <> ${abapStr(entryText)}. lv_err = lv_err + 1.`)
        L.push(`      out->write( 'SELFCHECK-FAIL:${key}' ). ENDIF.`)
      }
    }
  } else if (mode === "delete") {
    // delete 模式：读目标语言池 → 按 deleteKeys 逐键删除（删同键所有 ID 行）→ 写回 → 自检键已消失
    L.push(...emitLangResolution("lv_tgt", tgtSpec))
    L.push(`    READ TEXTPOOL ${abapStr(progUpper)} INTO lt_tp LANGUAGE lv_tgt.`)
    L.push("    DATA(lv_del) = 0.")
    for (const k of opts.deleteKeys ?? []) {
      L.push(`    READ TABLE lt_tp TRANSPORTING NO FIELDS WITH KEY key = ${abapStr(k)}.`)
      L.push("    IF sy-subrc = 0.")
      L.push(`      DELETE lt_tp WHERE key = ${abapStr(k)}.`)
      L.push("      lv_del = lv_del + 1.")
      L.push("    ENDIF.")
    }
    L.push(`    INSERT TEXTPOOL ${abapStr(progUpper)} FROM lt_tp LANGUAGE lv_tgt.`)
    L.push("    out->write( |deleted { lv_del }| ).")
    L.push(`    READ TEXTPOOL ${abapStr(progUpper)} INTO lt_chk LANGUAGE lv_tgt.`)
    for (const k of opts.deleteKeys ?? []) {
      L.push(`    READ TABLE lt_chk TRANSPORTING NO FIELDS WITH KEY key = ${abapStr(k)}.`)
      L.push(`    IF sy-subrc = 0. lv_err = lv_err + 1. out->write( 'SELFCHECK-FAIL:${k}' ). ENDIF.`)
    }
  } else if (mode === "list") {
    // list 模式：只读目标语言现有 text pool，输出 ID|KEY|文本，供核对真实 key/文本（不写入、不提交）
    L.push(...emitLangResolution("lv_tgt", tgtSpec))
    L.push(`    READ TEXTPOOL ${abapStr(progUpper)} INTO lt_tp LANGUAGE lv_tgt.`)
    L.push("    LOOP AT lt_tp INTO ls_tp.")
    L.push("      out->write( ls_tp-id && '|' && ls_tp-key && '|' && ls_tp-entry ).")
    L.push("    ENDLOOP.")
    L.push("    out->write( |TOTAL| && ':' && |{ lines( lt_tp ) }| ).")
  }
  // list 模式纯读取，不做提交/回滚；其余模式自检通过才提交落库，失败回滚（INSERT TEXTPOOL 在 DB LUW 中，ROLLBACK 可撤销）
  if (mode !== "list") {
    L.push("    IF lv_err = 0.")
    L.push("      COMMIT WORK.")
    L.push("      out->write( 'SELFCHECK-OK' ).")
    L.push("    ELSE.")
    L.push("      ROLLBACK WORK.")
    L.push("      out->write( 'SELFCHECK-FAIL' ).")
    L.push("    ENDIF.")
  }
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
    "程序文本元素(text pool)翻译工具：用户说「翻译/多语言/加英文/加越南语/文本池/文本符号/选择文本/程序描述/程序标题」时用。\n" +
    "【翻译对象】SE38 程序代码里的文本：文本符号 TEXT-xxx（如 TEXT-001）、选择文本（参数名，如 S_CARRID）、程序描述/标题（key='T'）。\n" +
    "【先分清对象再选工具】屏幕画面上的标题/字段标签→用 translate_screen_text；SE91 消息类提示文案→用 translate_message_class；本工具只处理程序代码里的文本元素。\n" +
    "【四种模式】list=读取目标语言现有文本池（输出 ID|KEY|文本，供核对真实 key，不做任何写入）；copy=把源语言 text pool 整体复制成目标语言（sourceLanguage 默认 '1'）；set=按 [{key,text}] 覆盖/新增；delete=按 deleteKeys 删除条目。\n" +
    "【key 怎么填】'T'=程序描述；文本符号=1~3 位字母或数字（'001'/'E01'，对应源码 TEXT-001/TEXT-E01，不要带 TEXT- 前缀，不要把类型字母 I/S 当 key 传）；选择文本=参数名（如 'S_CARRID'，通常含下划线）。\n" +
    "选择文本自动补前导空格（SAP 要求文字从第 9 列开始），三类文本都写正确类型 ID（I/R/S）——漏 ID 会导致界面/ADT 读不到写入内容。\n" +
    LANG_KEY_HELP +
    "写入后自动读回核对，对不上回滚不落库。\n" +
    "【仅用于翻译】本工具只写指定语言的翻译文本；新增/修改主语言文本元素请用 manage_text_elements。\n" +
    "【文本池随程序对象走】程序/报表的文本池是挂在程序对象（R3TR PROG <程序名>）上一起传输的。本工具直接写文本池（INSERT TEXTPOOL）、不自己挂载对象——请先确认程序已在某个可修改传输请求里（manage_text_elements 写入会把它挂进去），或传 transportNumber 让本工具检测该请求，否则翻译不会随请求传输。",
  inputSchema: z.object({
    objectName: z.string().describe("程序名，如 ZAIR004"),
    mode: z.enum(["list", "copy", "set", "delete"]).describe("list=读取现有文本池核对真实 key(不写入); copy=复制源语言 text pool; set=按 key 覆盖/新增; delete=按 deleteKeys 删除条目"),
    targetLanguage: z.string().describe("目标语言：标准键（E/D/1/M/J/K 等）、ISO 代码（EN/DE/ZH/VI 等）或中文名（英文/德文/中文/越南 等）。越南语请用 VI 或「越南」"),
    sourceLanguage: z.string().optional().describe("copy 模式：源语言，默认 '1'（主语言），同上格式"),
    texts: z
      .array(z.object({ key: z.string().describe("text pool key: T=描述/标题, I=符号(001/E01), S=选择文本(P_COMP)"), text: z.string().describe("文本内容") }))
      .optional()
      .describe("set 模式：要写入的条目"),
    deleteKeys: z.array(z.string()).optional().describe("delete 模式：要删除的文本池键（如 'E01'、'IE01'；按原样匹配，删同键所有条目）"),
    transportNumber: z.string().optional().describe("传输请求号（可选，如 DEVK900001）。用于检测程序对象（R3TR PROG <程序名>）是否已在该请求里；不在则该翻译不一定随请求传输"),
    connectionId: connectionIdSchema,
  }),
  async execute(args: {
    objectName: string
    mode: string
    targetLanguage: string
    sourceLanguage?: string
    texts?: Array<{ key: string; text: string }>
    deleteKeys?: string[]
    transportNumber?: string
    connectionId?: string
  }): Promise<string> {
    try {
      const connId = await resolveConnectionId(args.connectionId)
      const client = await getClient(connId)
      const tgt = args.targetLanguage
      const src = args.sourceLanguage ?? "1"
      const prog = args.objectName.toUpperCase()

      // 文本池随程序对象（R3TR PROG <prog>）一起传输。写模式（set/copy/delete）前检测程序对象
      // 是否已在某个可修改传输请求里（E071 有 R3TR PROG 条目 + E070 状态 D），据此判断翻译能否随请求传；
      // list 模式纯读不涉及。本工具直接写文本池、不自己挂载对象，程序不在请求里则翻译有丢失风险。
      let programReqInfo = ""
      if (args.mode !== "list") {
        try {
          programReqInfo = await detectProgramTransport(client, prog, args.transportNumber)
        } catch {
          programReqInfo = ""
        }
      }

      if (!resolveLanguageSpec(tgt)) return `⛔ 无法识别的目标语言: "${tgt}"。${LANG_KEY_HELP}`
      if (!resolveLanguageSpec(src)) return `⛔ 无法识别的源语言: "${src}"。${LANG_KEY_HELP}`

      if (args.mode === "set" && (!args.texts || args.texts.length === 0)) {
        return "set 模式需要 texts 参数（[{key, text}]，key: T/符号编号/选择参数名）。"
      }
      if (args.mode === "delete" && (!args.deleteKeys || args.deleteKeys.length === 0)) {
        return "delete 模式需要 deleteKeys 参数（要删除的文本池键列表，如 ['E01']）。"
      }
      // delete 键按原样大写（不做 Ixxx 归一化——'IE01' 是池里的真实键，删的就是它本身，不是 E01）
      if (args.mode === "delete" && args.deleteKeys) {
        args.deleteKeys = args.deleteKeys.map((k) => k.trim().toUpperCase()).filter(Boolean)
        const badDel = args.deleteKeys.filter((k) => {
          if (k === "T" || k === "I" || k === "S") return true
          if (isTextSymbolKey(k)) return false
          if (/^[A-Z][A-Z0-9_]{0,19}$/.test(k)) return false
          return true
        })
        if (badDel.length > 0) {
          return `⛔ 无效的删除键: ${badDel.join(", ")}。未删除任何内容。` +
            `正确格式：文本符号键（如 'E01'、'001'）或选择文本参数名（如 'S_CARRID'）。`
        }
      }
      // ⛔ key 校验+归一化：防止把类型字母(I/S)或内部存储键(I001)当文本池键传入写出垃圾条目（曾导致中文写错键位）
      if (args.mode === "set" && args.texts) {
        args.texts = args.texts.map((t) => {
          const upper = t.key.trim().toUpperCase()
          const m = upper.match(/^I([A-Z0-9]{3})$/)
          return m ? { ...t, key: m[1] } : { ...t, key: upper }
        })
        const bad = args.texts.filter((t) => {
          const k = t.key
          if (k === "T") return false
          if (k === "I" || k === "S") return true
          if (isTextSymbolKey(k)) return false
          if (/^[A-Z][A-Z0-9_]{0,19}$/.test(k)) return false
          return true
        })
        if (bad.length > 0) {
          return (
            `⛔ 无效的文本键: ${bad.map((b) => b.key).join(", ")}。未写入任何内容。\n` +
            `正确格式：'T'=标题；文本符号=1~3位字母/数字（如 '001'、'E01' 对应 TEXT-001/TEXT-E01）；选择文本=参数名（如 'S_CARRID'）。不要把类型字母 I/S 当 key 传。`
          )
        }
      }

      const suffix = randomUUID().slice(0, 4).toUpperCase()
      const className = `ZCL_TPTRAN${suffix}`
      const uri = `/sap/bc/adt/oo/classes/${className.toLowerCase()}`
      const sourceUri = `${uri}/source/main`

      const source = generateClassSource(className, args.mode as "copy" | "set" | "delete" | "list", {
        prog,
        srcLang: src,
        tgtLang: tgt,
        texts: args.texts,
        deleteKeys: args.deleteKeys,
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

      const oldState2 = client.stateful
      client.stateful = session_types.stateful
      try {
        const lock2 = await client.lock(uri).catch(() => undefined)
        if (lock2) {
          await client.deleteObject(uri, lock2.LOCK_HANDLE, undefined).catch(() => undefined)
          await client.unLock(uri, lock2.LOCK_HANDLE).catch(() => undefined)
        }
      } catch { /* 清理失败不影响结果 */ } finally {
        client.stateful = oldState2
      }

      if (/SELFCHECK-FAIL/i.test(result)) {
        return `❌ 程序 ${prog} 文本元素写入后自检未通过（目标语言 ${tgt}），已回滚不落库：\n${result}`
      }
      if (/^Error:/i.test(result)) {
        return `❌ 程序 ${prog} 文本元素写入失败（目标语言 ${tgt}）：${result}`
      }
      if (args.mode === "list") {
        return `📖 程序 ${prog} 的文本池（目标语言 ${tgt}）如下（ID|KEY|文本；I=文本符号 TEXT-xxx, S=选择文本, R=标题）：\n${result}`
      }
      const mountNote = programReqInfo ? `\n\n${programReqInfo}` : ""
      return (
        `✅ 程序 ${prog} 文本元素已写入（目标语言 ${tgt}${args.mode === "copy" ? `，源语言 ${src}` : ""}）:\n` +
        result +
        mountNote
      )
    } catch (err) {
      return toToolError(err)
    }
  },
}
