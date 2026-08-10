/**
 * 消息类(SE91/T100)按语言翻译工具
 *
 * 背景：SAP ADT 写接口无法写入非原始语言的翻译文本（同 DDIC 文本的限制）。
 * 消息类每条消息的短文本存在表 T100（ARBGB=消息类, MSGNR=消息号, SPRSL=语言键, TEXT=短文本, 最长 72 字符）。
 * 本工具生成可执行类在 SAP 内直接 INSERT/MODIFY T100，支持任意目标语言：
 *  - copy 模式：把源语言消息文本复制为指定目标语言（messageClass 可带 % 通配批量）
 *  - set 模式：按 [{msgNumber, text}] 直接写入指定语言的翻译文本
 * 写入后自检：重读目标语言行核对文本，对不上报错回滚，不假装成功。
 */
import { z } from "zod"
import { randomUUID } from "node:crypto"
import { session_types, objectPath } from "abap-adt-api"
import { getClient } from "../adtManager.js"
import { resolveConnectionId, toToolError, connectionIdSchema } from "./shared.js"
import { resolveLanguageSpec, emitLangResolution, LANG_KEY_HELP } from "./languageKeys.js"

const abapStr = (s: string) => `'${s.replace(/'/g, "''")}'`

/** 消息号归一化：1~3 位数字补零为 3 位（SE91 消息号 000~999），非法返回 null */
export const normalizeMsgNumber = (n: string): string | null => {
  const s = n.trim()
  if (/^\d{1,3}$/.test(s)) return s.padStart(3, "0")
  return null
}

/** 消息类名校验：ARBGB 最长 20 字符，大写字母/数字/下划线；copy 模式允许 % _ 通配 */
export const isValidMsgClass = (n: string, wildcard = false) => {
  const re = wildcard ? /^[A-Z0-9_%*]{1,20}$/ : /^[A-Z0-9_]{1,20}$/
  return re.test(n.toUpperCase())
}

/** 生成可执行类源码 */
export function generateClassSource(className: string, mode: "copy" | "set", opts: {
  messageClass: string
  srcLang?: string
  tgtLang: string
  texts?: Array<{ msgNumber: string; text: string }>
}): string {
  const cls = opts.messageClass.toUpperCase()
  const tgt = opts.tgtLang
  const L: string[] = []
  L.push("  METHOD if_oo_adt_classrun~main.")
  L.push("    DATA: ls_t100 TYPE t100, lv_arbgb TYPE arbgb,")
  L.push("          lv_ins TYPE i, lv_upd TYPE i, lv_err TYPE i, lv_tgt TYPE spras, lv_src TYPE spras.")
  // 语言键先在 SAP 内解析（VI 等特殊键从 T002 反查真实值），避免把乱码字符嵌进源码
  const tgtSpec = resolveLanguageSpec(opts.tgtLang) ?? { kind: "literal", char: opts.tgtLang }
  const srcSpec = resolveLanguageSpec(opts.srcLang) ?? { kind: "literal", char: opts.srcLang ?? "E" }
  L.push(...emitLangResolution("lv_tgt", tgtSpec))
  L.push("    COMMIT WORK.")
  L.push(`    out->write( |开始处理: 目标语言 ${tgt}| ).`)

  if (mode === "copy") {
    const src = opts.srcLang ?? "E"
    L.push(...emitLangResolution("lv_src", srcSpec))
    L.push("    DATA: lt_src TYPE TABLE OF t100, ls_src TYPE t100.")
    L.push(`    SELECT * FROM t100 INTO TABLE @lt_src WHERE arbgb LIKE ${abapStr(cls)} AND sprsl = @lv_src.`)
    L.push("    LOOP AT lt_src INTO ls_src.")
    L.push("      ls_t100 = ls_src.")
    L.push("      ls_t100-sprsl = lv_tgt.")
    L.push("      CLEAR lv_arbgb.")
    L.push("      SELECT SINGLE arbgb FROM t100 INTO @lv_arbgb WHERE arbgb = @ls_t100-arbgb AND msgnr = @ls_t100-msgnr AND sprsl = @lv_tgt.")
    L.push("      IF sy-subrc = 0.")
    L.push("        MODIFY t100 FROM ls_t100. IF sy-subrc = 0. lv_upd = lv_upd + 1. ENDIF.")
    L.push("      ELSE.")
    L.push("        INSERT t100 FROM ls_t100. IF sy-subrc = 0. lv_ins = lv_ins + 1. ENDIF.")
    L.push("      ENDIF.")
    L.push("    ENDLOOP.")
    L.push(`    out->write( |复制完成: 新增 { lv_ins } 更新 { lv_upd }（源语言 ${src}）| ).`)
    // 自检：逐个重读源消息的目标语言行，核对文本一致；对不上说明写入未生效，必须回滚
    L.push("    LOOP AT lt_src INTO ls_src.")
    L.push("      CLEAR ls_t100.")
    L.push("      SELECT SINGLE * FROM t100 INTO @ls_t100 WHERE arbgb = @ls_src-arbgb AND msgnr = @ls_src-msgnr AND sprsl = @lv_tgt.")
    L.push("      IF sy-subrc <> 0 OR ls_t100-text <> ls_src-text. lv_err = lv_err + 1.")
    L.push("        out->write( |SELFCHECK-FAIL:{ ls_src-msgnr }| ). ENDIF.")
    L.push("    ENDLOOP.")
  } else {
    L.push("    CLEAR lv_arbgb.")
    for (const t of opts.texts ?? []) {
      const num = t.msgNumber
      L.push("    CLEAR ls_t100.")
      L.push(`    ls_t100-arbgb = ${abapStr(cls)}. ls_t100-msgnr = ${abapStr(num)}. ls_t100-sprsl = lv_tgt. ls_t100-text = ${abapStr(t.text)}.`)
      L.push("    CLEAR lv_arbgb.")
      L.push("      SELECT SINGLE arbgb FROM t100 INTO @lv_arbgb WHERE arbgb = @ls_t100-arbgb AND msgnr = @ls_t100-msgnr AND sprsl = @lv_tgt.")
      L.push("    IF sy-subrc = 0.")
      L.push("      MODIFY t100 FROM ls_t100. IF sy-subrc = 0. lv_upd = lv_upd + 1. ENDIF.")
      L.push("    ELSE.")
      L.push("      INSERT t100 FROM ls_t100. IF sy-subrc = 0. lv_ins = lv_ins + 1. ENDIF.")
      L.push("    ENDIF.")
    }
    L.push(`    out->write( |写入完成: 新增 { lv_ins } 更新 { lv_upd }| ).`)
    // 自检：重读每条消息的目标语言行，核对文本
    for (const t of opts.texts ?? []) {
      const num = t.msgNumber
      L.push("    CLEAR ls_t100.")
      L.push(`    SELECT SINGLE * FROM t100 INTO @ls_t100 WHERE arbgb = ${abapStr(cls)} AND msgnr = ${abapStr(num)} AND sprsl = @lv_tgt.`)
      L.push(`    IF sy-subrc <> 0 OR ls_t100-text <> ${abapStr(t.text)}. lv_err = lv_err + 1.`)
      L.push(`      out->write( 'SELFCHECK-FAIL:${num}' ). ENDIF.`)
    }
  }
  L.push("    IF lv_err = 0.")
  L.push("      COMMIT WORK.")
  L.push("      out->write( 'SELFCHECK-OK' ).")
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

export const translateMessageClassTool = {
  name: "translate_message_class",
  write: true,
  title: "Translate Message Class (SE91/T100)",
  description:
    "消息类多语言翻译工具：用户要求翻译/多语言/消息类文本/消息文案/加英文/越南语时可用。" +
    "按指定语言写入/翻译消息类(SE91)的短文本，文本存在表 T100（每条消息按 消息类+消息号+语言 分行，短文本最长 72 字符）。" +
    "两种模式：copy（把源语言消息文本整体复制为指定目标语言，messageClass 可带 % 通配批量处理）、" +
    "set（按 [{msgNumber, text}] 直接写入翻译文本）。" +
    "msgNumber 是消息号（如 '001'，输入 1/01 会自动补全为 3 位）。" +
    LANG_KEY_HELP +
    "写入后自动读回核对，文本对不上会回滚不落库。",
  inputSchema: z.object({
    messageClass: z.string().describe("消息类名，如 ZFI001（ARBGB）。copy 模式可带 % 通配（如 'ZFI%'）批量复制"),
    mode: z.enum(["copy", "set"]).describe("copy=把源语言消息文本复制到目标语言; set=按消息号直接写入翻译文本"),
    targetLanguage: z.string().describe("目标语言：标准键（E/D/1/M/J/K 等）、ISO 代码（EN/DE/ZH/VI 等）或中文名（英文/德文/中文/越南 等）。越南语请用 VI 或「越南」，注意 V 是瑞典语"),
    sourceLanguage: z.string().optional().describe("copy 模式：源语言，默认 'E'，同上格式"),
    messages: z
      .array(z.object({ msgNumber: z.string().describe("消息号（3 位，如 '001'；输入 1/01 自动补全）"), text: z.string().describe("消息文本（最多 72 字符）") }))
      .optional()
      .describe("set 模式：要写入的消息"),
    connectionId: connectionIdSchema,
  }),
  async execute(args: {
    messageClass: string
    mode: string
    targetLanguage: string
    sourceLanguage?: string
    messages?: Array<{ msgNumber: string; text: string }>
    connectionId?: string
  }): Promise<string> {
    try {
      const connId = await resolveConnectionId(args.connectionId)
      const client = await getClient(connId)
      const tgt = args.targetLanguage
      const cls = (args.messageClass ?? "").trim().toUpperCase()

      if (!cls) return "需要 messageClass 参数（消息类名，如 ZFI001）。"
      if (!resolveLanguageSpec(tgt)) return `⛔ 无法识别的目标语言: "${tgt}"。${LANG_KEY_HELP}`
      if (args.sourceLanguage && !resolveLanguageSpec(args.sourceLanguage)) {
        return `⛔ 无法识别的源语言: "${args.sourceLanguage}"。${LANG_KEY_HELP}`
      }
      if (!isValidMsgClass(cls, args.mode === "copy")) {
        return `⛔ 无效的消息类名: ${cls}（最长 20 字符，仅字母/数字/下划线${args.mode === "copy" ? "，copy 模式可用 % 通配" : ""}）。`
      }
      if (args.mode === "copy") {
        if (!args.targetLanguage) return "需要 targetLanguage 参数（目标语言键）。"
      } else if (args.mode === "set") {
        if (!args.messages || args.messages.length === 0) return "set 模式需要 messages 参数（[{msgNumber, text}]）。"
        const normalized: Array<{ msgNumber: string; text: string }> = []
        for (const m of args.messages) {
          const num = normalizeMsgNumber(m.msgNumber)
          if (!num) return `⛔ 无效的消息号: ${m.msgNumber}（应为 3 位数字，如 '001'）。`
          if (!m.text || m.text.length > 72) {
            return `⛔ 消息 ${num} 的文本为空或超过 72 字符（T100 短文本上限）：${(m.text ?? "").length} 字符。`
          }
          normalized.push({ msgNumber: num, text: m.text })
        }
        args.messages = normalized
      } else {
        return "mode 只能是 copy 或 set。"
      }

      const suffix = randomUUID().slice(0, 4).toUpperCase()
      const className = `ZCL_MSAGTR${suffix}`
      const uri = `/sap/bc/adt/oo/classes/${className.toLowerCase()}`
      const sourceUri = `${uri}/source/main`

      const source = generateClassSource(className, args.mode as "copy" | "set", {
        messageClass: cls,
        srcLang: args.sourceLanguage,
        tgtLang: tgt,
        texts: args.messages,
      })

      await client.createObject({
        objtype: "CLAS/OC",
        name: className,
        parentName: "$TMP",
        description: "消息类文本翻译(临时)",
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
        return `❌ 消息类 ${cls} 翻译后自检未通过（目标语言 ${tgt}），已回滚不落库：\n${result}`
      }
      if (/^Error:/i.test(result)) {
        return `❌ 消息类 ${cls} 翻译失败（目标语言 ${tgt}）：${result}`
      }
      return (
        `✅ 消息类 ${cls} 已翻译（目标语言 ${tgt}${args.mode === "copy" ? `，源语言 ${args.sourceLanguage ?? "E"}` : ""}）:\n` +
        result
      )
    } catch (err) {
      return toToolError(err)
    }
  },
}
