/**
 * 屏幕文字多语言翻译工具
 *
 * 背景：SAP 屏幕文字（屏幕标题/字段标签）没有 ADT 写接口，需直接改系统表：
 *  - D020S 屏幕定义（PROG,DNUM 等）
 *  - D020T 屏幕标题翻译（PROG,DYNR,LANG,DTXT，DTXT 最长 60 字符）
 *  - D021T 屏幕字段/元素文本翻译（PROG,DYNR,LANG,FLDN,DTXT，DTXT 最长 132 字符）
 * 这些表客户端无关（跨客户端）；语言键 1=中文简体 M=繁体 等，越南语 VI 的特殊键从 T002 反查。
 * 注意：直接改系统表不会自动创建传输请求条目，如需进传输请手工插入（同 SAPLZBCG014 的处理）。
 * 本工具生成可执行类在 SAP 内解析语言键 + MODIFY D021T/D020T，写入后自检：重读目标语言行核对，
 * 对不上报错回滚，不假装成功。
 * 模式：
 *  - list：列出程序全部屏幕的标题(D020T)与字段(D021T)文本（供定位 dynr/fldn，可指定语言）
 *  - set：按 fields[{dynr,fldn,text}]（字段标签）与/或 titles[{dynr,text}]（屏幕标题）写入翻译
 */
import { z } from "zod"
import { randomUUID } from "node:crypto"
import { session_types, objectPath } from "abap-adt-api"
import { getClient } from "../adtManager.js"
import { resolveConnectionId, toToolError, connectionIdSchema } from "./shared.js"
import { resolveLanguageSpec, emitLangResolution, LANG_KEY_HELP, abapStr, LangResolve } from "./languageKeys.js"

/** 屏幕号校验：1~4 位数字（SAP 屏幕号如 2100/9999） */
const isValidDynr = (s: string) => /^\d{1,4}$/.test(s)

/** 组装：程序名解析 + 语言键解析 + 确认有屏幕（两模式共用开头） */
function emitProgAndLang(cand1: string, cand2: string, langVar: string, spec: LangResolve) {
  const L: string[] = []
  L.push(...emitLangResolution(langVar, spec))
  L.push(`    lv_prog = ${abapStr(cand1)}.`)
  L.push("    SELECT COUNT(*) FROM d020s INTO @lv_n WHERE prog = @lv_prog.")
  L.push(`    IF lv_n = 0 AND ${abapStr(cand1)} <> ${abapStr(cand2)}.`)
  L.push(`      lv_prog = ${abapStr(cand2)}.`)
  L.push("      SELECT COUNT(*) FROM d020s INTO @lv_n WHERE prog = @lv_prog.")
  L.push("    ENDIF.")
  L.push("    IF lv_n = 0.")
  L.push("      out->write( 'NOSCREENS' ). RETURN.")
  L.push("    ENDIF.")
  L.push("    out->write( 'PROG|' && lv_prog && '|' && |{ lv_n }| ).")
  return L
}

/** 生成 list 模式类源码：列出全部屏幕标题(D020T)与字段(D021T) */
export function buildListSource(className: string, cand1: string, cand2: string, lang: string): string {
  const spec = resolveLanguageSpec(lang) ?? { kind: "literal", char: "1" }
  const L: string[] = []
  L.push("  METHOD if_oo_adt_classrun~main.")
  L.push("    DATA: lv_prog TYPE d020s-prog, lv_n TYPE i, lv_lang TYPE spras,")
  L.push("          ls_d TYPE d020s, lt_d TYPE TABLE OF d020s,")
  L.push("          ls_t TYPE d020t, lt_t TYPE TABLE OF d020t,")
  L.push("          ls_i TYPE d021t, lt_i TYPE TABLE OF d021t.")
  L.push(...emitProgAndLang(cand1, cand2, "lv_lang", spec))
  L.push("    SELECT * FROM d020s INTO TABLE @lt_d WHERE prog = @lv_prog ORDER BY dnum.")
  L.push("    LOOP AT lt_d INTO ls_d.")
  L.push("      SELECT * FROM d020t INTO TABLE @lt_t WHERE prog = @lv_prog AND dynr = @ls_d-dnum AND lang = @lv_lang.")
  L.push("      LOOP AT lt_t INTO ls_t.")
  L.push("        out->write( 'TITLE|' && ls_t-dynr && '|' && ls_t-dtxt ).")
  L.push("      ENDLOOP.")
  L.push("      SELECT * FROM d021t INTO TABLE @lt_i WHERE prog = @lv_prog AND dynr = @ls_d-dnum AND lang = @lv_lang.")
  L.push("      LOOP AT lt_i INTO ls_i.")
  L.push("        out->write( 'FIELD|' && ls_i-dynr && '|' && ls_i-fldn && '|' && ls_i-dtxt ).")
  L.push("      ENDLOOP.")
  L.push("    ENDLOOP.")
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

/** 生成 set 模式类源码：写入 D021T 字段标签 + D020T 屏幕标题，写入后自检 */
export function buildSetSource(
  className: string,
  cand1: string,
  cand2: string,
  tgtLang: string,
  fields: Array<{ dynr: string; fldn: string; text: string }>,
  titles: Array<{ dynr: string; text: string }>
): string {
  const spec = resolveLanguageSpec(tgtLang) ?? { kind: "literal", char: tgtLang }
  const L: string[] = []
  L.push("  METHOD if_oo_adt_classrun~main.")
  L.push("    DATA: lv_prog TYPE d020s-prog, lv_n TYPE i, lv_tgt TYPE spras, lv_chk TYPE string, lv_ex TYPE string,")
  L.push("          lv_err TYPE i, lv_w TYPE i, ls_i TYPE d021t, ls_t TYPE d020t.")
  L.push(...emitProgAndLang(cand1, cand2, "lv_tgt", spec))
  for (const f of fields) {
    // 先确认字段在目标程序里真实存在，防止把不存在的 fldn 写进 D021T 制造脏数据（客户端常见误操作）
    L.push("    CLEAR lv_ex.")
    L.push(`    SELECT SINGLE fldn FROM d021t INTO @lv_ex WHERE prog = @lv_prog AND dynr = ${abapStr(f.dynr)} AND fldn = ${abapStr(f.fldn)}.`)
    L.push(`    IF sy-subrc <> 0. lv_err = lv_err + 1. out->write( 'NOFIELD:${f.dynr}/${f.fldn}' ).`)
    L.push("    ELSE.")
    L.push("      CLEAR ls_i.")
    L.push(`      ls_i-prog = lv_prog. ls_i-dynr = ${abapStr(f.dynr)}. ls_i-lang = lv_tgt. ls_i-fldn = ${abapStr(f.fldn)}. ls_i-dtxt = ${abapStr(f.text)}.`)
    L.push("      MODIFY d021t FROM ls_i.")
    L.push("      IF sy-subrc = 0. lv_w = lv_w + 1. ELSE. lv_err = lv_err + 1. ENDIF.")
    L.push("    ENDIF.")
  }
  for (const t of titles) {
    // 先确认屏幕号在 D020S 里存在，防止写入不存在的屏幕标题
    L.push("    CLEAR lv_ex.")
    L.push(`    SELECT SINGLE dnum FROM d020s INTO @lv_ex WHERE prog = @lv_prog AND dnum = ${abapStr(t.dynr)}.`)
    L.push(`    IF sy-subrc <> 0. lv_err = lv_err + 1. out->write( 'NOSCREEN:${t.dynr}' ).`)
    L.push("    ELSE.")
    L.push("      CLEAR ls_t.")
    L.push(`      ls_t-prog = lv_prog. ls_t-dynr = ${abapStr(t.dynr)}. ls_t-lang = lv_tgt. ls_t-dtxt = ${abapStr(t.text)}.`)
    L.push("      MODIFY d020t FROM ls_t.")
    L.push("      IF sy-subrc = 0. lv_w = lv_w + 1. ELSE. lv_err = lv_err + 1. ENDIF.")
    L.push("    ENDIF.")
  }
  for (const f of fields) {
    L.push("    CLEAR lv_chk.")
    L.push(`    SELECT SINGLE dtxt FROM d021t INTO @lv_chk WHERE prog = @lv_prog AND dynr = ${abapStr(f.dynr)} AND lang = @lv_tgt AND fldn = ${abapStr(f.fldn)}.`)
    L.push(`    IF sy-subrc <> 0 OR lv_chk <> ${abapStr(f.text)}. lv_err = lv_err + 1.`)
    L.push(`      out->write( 'SELFCHECK-FAIL:${f.dynr}/${f.fldn}' ). ENDIF.`)
  }
  for (const t of titles) {
    L.push("    CLEAR lv_chk.")
    L.push(`    SELECT SINGLE dtxt FROM d020t INTO @lv_chk WHERE prog = @lv_prog AND dynr = ${abapStr(t.dynr)} AND lang = @lv_tgt.`)
    L.push(`    IF sy-subrc <> 0 OR lv_chk <> ${abapStr(t.text)}. lv_err = lv_err + 1.`)
    L.push(`      out->write( 'SELFCHECK-FAIL:TITLE:${t.dynr}' ). ENDIF.`)
  }
  L.push("    IF lv_err = 0.")
  L.push("      COMMIT WORK.")
  L.push(`      out->write( |SELFCHECK-OK 写入 { lv_w } 条| ).`)
  L.push("    ELSE.")
  L.push("      ROLLBACK WORK.")
  L.push("      out->write( 'SELFCHECK-FAIL' ).")
  L.push("    ENDIF.")
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

export const translateScreenTextTool = {
  name: "translate_screen_text",
  write: true,
  title: "Translate Screen Text (D020T/D021T)",
  description:
    "屏幕文字翻译工具：用户说「翻译/多语言/加英文/加越南语/屏幕文字/屏幕标题/字段标签/界面显示文字/屏幕上的字」时用。\n" +
    "【翻译对象】屏幕画面上的标题（表 D020T，最长 60 字符）和字段标签（表 D021T，最长 132 字符）。这是画面显示的字，不是程序代码里的文本。\n" +
    "【先分清对象再选工具】程序代码里的文本符号/选择文本→用 translate_text_pool；SE91 消息类提示文案→用 translate_message_class；本工具只处理屏幕画面上的字。\n" +
    "【必须先查后写】先用 list 模式把程序全部屏幕的标题/字段拉出来（得到真实 dynr 屏幕号和 fldn 字段名），再 set 写入。不要猜字段名——写入不存在的字段/屏幕会报错不落库。\n" +
    "【两种模式】list=列出程序全部屏幕文字（可指定语言读）；set=按 fields[{dynr,fldn,text}] 写字段标签、titles[{dynr,text}] 写屏幕标题。\n" +
    "【程序名】通常 SAPL 开头（如 SAPLZBCG004A）；传函数组名（如 ZBCG004A）会自动补 SAPL 前缀。\n" +
    "【重要】直接改系统表不会自动创建传输请求条目，如需要进传输请求请手工插入（同 SAPLZBCG014 的处理）。\n" +
    LANG_KEY_HELP +
    "写入后自动读回核对，对不上回滚不落库。",
  inputSchema: z.object({
    mode: z.enum(["list", "set"]).describe("list=列出程序全部屏幕的标题(D020T)与字段(D021T)文本，供定位 dynr/fldn；set=写入指定语言的屏幕文字翻译"),
    objectName: z.string().describe("SAP 程序名（屏幕所在的主程序，通常 SAPL 开头，如 SAPLZBCG004A；传函数组名如 ZBCG004A 也会自动补 SAPL 前缀）"),
    targetLanguage: z.string().describe("list 模式=要读的语言；set 模式=要写入的目标语言。标准键（E/D/1/M/J/K 等）、ISO 代码（EN/DE/ZH/VI 等）或中文名（英文/德文/中文/越南 等）。越南语请用 VI 或「越南」，工具从 T002 反查真实语言键"),
    fields: z
      .array(z.object({
        dynr: z.string().describe("屏幕号，如 '2100'"),
        fldn: z.string().describe("字段名（D021T 字段标签），如 'T1_2100'；先用 list 获取真实字段名"),
        text: z.string().describe("翻译文本（最长 132 字符）"),
      }))
      .optional()
      .describe("set 模式：要写入的字段标签翻译"),
    titles: z
      .array(z.object({
        dynr: z.string().describe("屏幕号，如 '2100'"),
        text: z.string().describe("屏幕标题翻译（最长 60 字符）"),
      }))
      .optional()
      .describe("set 模式：要写入的屏幕标题翻译（D020T）"),
    connectionId: connectionIdSchema,
  }),
  async execute(args: {
    mode: string
    objectName: string
    targetLanguage: string
    fields?: Array<{ dynr: string; fldn: string; text: string }>
    titles?: Array<{ dynr: string; text: string }>
    connectionId?: string
  }): Promise<string> {
    try {
      const connId = await resolveConnectionId(args.connectionId)
      const client = await getClient(connId)
      const mode = args.mode
      const objName = (args.objectName ?? "").trim()
      const tgt = args.targetLanguage

      if (!objName) return "需要 objectName 参数（SAP 程序名，如 SAPLZBCG004A）。"
      if (!/^[A-Za-z][A-Za-z0-9_]{1,29}$/.test(objName)) {
        return `⛔ 无效的程序名: ${objName}（最长 30 字符，仅字母/数字/下划线）。`
      }
      const upper = objName.toUpperCase()
      const cand1 = upper
      const cand2 = upper.startsWith("SAPL") ? upper : `SAPL${upper}`
      const spec = resolveLanguageSpec(tgt)
      if (!spec) return `⛔ 无法识别的语言: "${tgt}"。${LANG_KEY_HELP}`

      let fields: Array<{ dynr: string; fldn: string; text: string }> = []
      let titles: Array<{ dynr: string; text: string }> = []
      if (mode === "set") {
        fields = (args.fields ?? []).map((f) => ({
          dynr: String(f.dynr ?? "").trim(),
          fldn: String(f.fldn ?? "").trim(),
          text: String(f.text ?? ""),
        }))
        titles = (args.titles ?? []).map((t) => ({
          dynr: String(t.dynr ?? "").trim(),
          text: String(t.text ?? ""),
        }))
        if (fields.length + titles.length === 0) {
          return "set 模式需要 fields（[{dynr,fldn,text}]）或 titles（[{dynr,text}]）。"
        }
        for (const f of fields) {
          if (!isValidDynr(f.dynr)) return `⛔ 无效的屏幕号 dynr: "${f.dynr}"（应为 1~4 位数字，如 '2100'）。`
          if (!/^[A-Za-z0-9_]+$/.test(f.fldn)) return `⛔ 无效的字段名 fldn: "${f.fldn}"（如 T1_2100）。`
          if (!f.text || f.text.length > 132) {
            return `⛔ 字段 ${f.dynr}/${f.fldn} 的文本为空或超过 132 字符（D021T 上限）：${f.text.length} 字符。`
          }
        }
        for (const t of titles) {
          if (!isValidDynr(t.dynr)) return `⛔ 无效的屏幕号 dynr: "${t.dynr}"（应为 1~4 位数字，如 '2100'）。`
          if (!t.text || t.text.length > 60) {
            return `⛔ 屏幕 ${t.dynr} 标题为空或超过 60 字符（D020T 上限）：${t.text.length} 字符。`
          }
        }
      } else if (mode !== "list") {
        return "mode 只能是 list 或 set。"
      }

      const suffix = randomUUID().slice(0, 4).toUpperCase()
      const className = `ZCL_SCRTR${suffix}`
      const uri = `/sap/bc/adt/oo/classes/${className.toLowerCase()}`
      const sourceUri = `${uri}/source/main`

      const source =
        mode === "list"
          ? buildListSource(className, cand1, cand2, tgt)
          : buildSetSource(className, cand1, cand2, tgt, fields, titles)

      await client.createObject({
        objtype: "CLAS/OC",
        name: className,
        parentName: "$TMP",
        description: "屏幕文字翻译(临时)",
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

      if (mode === "list") {
        if (/NOSCREENS/.test(result)) {
          return (
            `未找到 ${cand1}${cand2 !== cand1 ? " 或 " + cand2 : ""} 的屏幕定义(D020S)。` +
            `请确认传入的是 SAP 主程序名（SAPL 开头，如 SAPLZBCG004A），而非 Excel 表名/函数组名。`
          )
        }
        const progLine = result.split("\n").find((l) => l.startsWith("PROG|")) ?? "PROG||"
        const prog = progLine.split("|")[1] ?? cand1
        const n = progLine.split("|")[2] ?? ""
        const body = result.split("\n").filter((l) => /^(FIELD|TITLE)\|/.test(l)).join("\n")
        return (
          `✅ 程序 ${prog} 共 ${n} 个屏幕，语言「${tgt}」的屏幕文字如下（TITLE=屏幕标题 D020T，FIELD=字段标签 D021T）：\n` +
          (body || "（该语言暂无屏幕文字）")
        )
      }

      if (/SELFCHECK-FAIL/i.test(result)) {
        return `❌ 屏幕文字写入后自检未通过（${cand1}，语言 ${tgt}），已回滚不落库：\n${result}`
      }
      if (/^Error:/i.test(result)) {
        return `❌ 屏幕文字翻译失败（${cand1}，语言 ${tgt}）：${result}`
      }
      return (
        `✅ 已写入屏幕文字：${fields.length} 条字段标签 + ${titles.length} 条屏幕标题（程序 ${cand1}，语言 ${tgt}）：\n` +
        result +
        `\n\n注意：直接改系统表不会自动创建传输请求条目，如需进传输请求请手工插入（同 SAPLZBCG014 的处理）。`
      )
    } catch (err) {
      return toToolError(err)
    }
  },
}
