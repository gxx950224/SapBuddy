/**
 * 通用 DDIC 文本写入工具：数据元素(DD04T)/域(DD01T) 的描述+标签写入指定语言
 *
 * 背景：SAP ADT 的 setDataElementProperties/setDomainProperties 只能写语言 E 条目（SAP 端 SBD 限制）。
 * 本工具通过生成可执行类 + ADT runClass 在 SAP 内直接 INSERT/MODIFY 文本表，支持任意语言。
 *
 * 两种模式：
 *  1. copy 模式：把源语言(默认 E)的文本复制为指定目标语言（prefix 指定对象范围）
 *  2. set 模式：直接指定 [{name, text}] 写入指定语言的描述+标签
 */
import { z } from "zod"
import { randomUUID } from "node:crypto"
import { getClient } from "../adtManager.js"
import { resolveConnectionId, toToolError, connectionIdSchema } from "./shared.js"

/** ABAP 字符串字面量转义（单引号翻倍） */
const abapStr = (s: string) => `'${s.replace(/'/g, "''")}'`

/** 生成可执行类源码（if_oo_adt_classrun），内嵌参数 */
function generateClassSource(
  className: string,
  mode: "copy" | "set",
  opts: {
    srcLang?: string
    tgtLang: string
    prefix?: string
    texts?: Array<{ name: string; text: string }>
    types: Array<"data_element" | "domain">
  }
): string {
  const main = new Array<string>()

  main.push("  METHOD if_oo_adt_classrun~main.")
  main.push(`    DATA: lv_ins TYPE i, lv_upd TYPE i.`)
  main.push("    COMMIT WORK.")
  main.push(`    out->write( |开始处理: 目标语言 ${opts.tgtLang}| ).`)

  const handleDd04t = (lines: string[], insVar: string, updVar: string) => {
    lines.push(`    DATA: lt_dd04t TYPE TABLE OF dd04t, ls_dd04t TYPE dd04t, lv_chk TYPE rollname.`)
    if (mode === "copy") {
      lines.push(`    SELECT * FROM dd04t INTO TABLE @lt_dd04t WHERE rollname LIKE ${abapStr(`${opts.prefix ?? ""}%`)} AND ddlanguage = ${abapStr(opts.srcLang!)}.`)
      lines.push(`    LOOP AT lt_dd04t INTO ls_dd04t.`)
      lines.push(`      ls_dd04t-ddlanguage = ${abapStr(opts.tgtLang)}.`)
      lines.push(`      CLEAR lv_chk. SELECT SINGLE rollname FROM dd04t INTO @lv_chk WHERE rollname = @ls_dd04t-rollname AND ddlanguage = ${abapStr(opts.tgtLang)}.`)
      lines.push(`      IF sy-subrc = 0. MODIFY dd04t FROM ls_dd04t. IF sy-subrc = 0. ${updVar} = ${updVar} + 1. ENDIF.`)
      lines.push(`      ELSE. INSERT dd04t FROM ls_dd04t. IF sy-subrc = 0. ${insVar} = ${insVar} + 1. ENDIF. ENDIF.`)
      lines.push(`    ENDLOOP.`)
    } else {
      for (const t of opts.texts ?? []) {
        lines.push(`    CLEAR ls_dd04t.`)
        lines.push(`    ls_dd04t-rollname = ${abapStr(t.name.toUpperCase())}. ls_dd04t-ddlanguage = ${abapStr(opts.tgtLang)}.`)
        lines.push(`    ls_dd04t-ddtext = ${abapStr(t.text)}. ls_dd04t-scrtext_s = ${abapStr(t.text)}. ls_dd04t-scrtext_m = ${abapStr(t.text)}. ls_dd04t-scrtext_l = ${abapStr(t.text)}.`)
        lines.push(`    CLEAR lv_chk. SELECT SINGLE rollname FROM dd04t INTO @lv_chk WHERE rollname = @ls_dd04t-rollname AND ddlanguage = ${abapStr(opts.tgtLang)}.`)
        lines.push(`    IF sy-subrc = 0. MODIFY dd04t FROM ls_dd04t. IF sy-subrc = 0. ${updVar} = ${updVar} + 1. ENDIF.`)
        lines.push(`    ELSE. INSERT dd04t FROM ls_dd04t. IF sy-subrc = 0. ${insVar} = ${insVar} + 1. ENDIF. ENDIF.`)
      }
    }
  }

  const handleDd01t = (lines: string[], insVar: string, updVar: string) => {
    lines.push(`    DATA: lt_dd01t TYPE TABLE OF dd01t, ls_dd01t TYPE dd01t, lv_chk2 TYPE domname.`)
    if (mode === "copy") {
      lines.push(`    SELECT * FROM dd01t INTO TABLE @lt_dd01t WHERE domname LIKE ${abapStr(`${opts.prefix ?? ""}%`)} AND ddlanguage = ${abapStr(opts.srcLang!)}.`)
      lines.push(`    LOOP AT lt_dd01t INTO ls_dd01t.`)
      lines.push(`      ls_dd01t-ddlanguage = ${abapStr(opts.tgtLang)}.`)
      lines.push(`      CLEAR lv_chk2. SELECT SINGLE domname FROM dd01t INTO @lv_chk2 WHERE domname = @ls_dd01t-domname AND ddlanguage = ${abapStr(opts.tgtLang)}.`)
      lines.push(`      IF sy-subrc = 0. MODIFY dd01t FROM ls_dd01t. IF sy-subrc = 0. ${updVar} = ${updVar} + 1. ENDIF.`)
      lines.push(`      ELSE. INSERT dd01t FROM ls_dd01t. IF sy-subrc = 0. ${insVar} = ${insVar} + 1. ENDIF. ENDIF.`)
      lines.push(`    ENDLOOP.`)
    } else {
      for (const t of opts.texts ?? []) {
        lines.push(`    CLEAR ls_dd01t.`)
        lines.push(`    ls_dd01t-domname = ${abapStr(t.name.toUpperCase())}. ls_dd01t-ddlanguage = ${abapStr(opts.tgtLang)}.`)
        lines.push(`    ls_dd01t-ddtext = ${abapStr(t.text)}.`)
        lines.push(`    CLEAR lv_chk2. SELECT SINGLE domname FROM dd01t INTO @lv_chk2 WHERE domname = @ls_dd01t-domname AND ddlanguage = ${abapStr(opts.tgtLang)}.`)
        lines.push(`    IF sy-subrc = 0. MODIFY dd01t FROM ls_dd01t. IF sy-subrc = 0. ${updVar} = ${updVar} + 1. ENDIF.`)
        lines.push(`    ELSE. INSERT dd01t FROM ls_dd01t. IF sy-subrc = 0. ${insVar} = ${insVar} + 1. ENDIF. ENDIF.`)
      }
    }
  }

  if (opts.types.includes("data_element")) {
    handleDd04t(main, "lv_ins", "lv_upd")
    main.push(`    out->write( |数据元素: 新增 { lv_ins } 更新 { lv_upd }| ).`)
  }
  if (opts.types.includes("domain")) {
    main.push("    CLEAR lv_ins. CLEAR lv_upd.")
    handleDd01t(main, "lv_ins", "lv_upd")
    main.push(`    out->write( |域: 新增 { lv_ins } 更新 { lv_upd }| ).`)
  }
  main.push("    COMMIT WORK.")
  main.push("  ENDMETHOD.")

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
    main.join("\n") +
    `\nENDCLASS.`
  )
}

export const fixDdicTextTool = {
  name: "fix_ddic_text",
  title: "Fix DDIC Text (Language)",
  description:
    "批量写入/修复 DDIC 对象（数据元素 DD04T、域 DD01T）的描述与字段标签到指定语言。" +
    "两种模式：copy（把源语言文本复制为指定目标语言，用 prefix 指定对象范围）或 set（直接提供 [{name,text}]）。" +
    "解决 SAP ADT 写 API 无法写入非英语语言文本的问题（自动生成可执行类在 SAP 内执行，运行后清理）。\n" +
    "语言键：1=中文简体, M=繁体中文, E=英文, D=德文, 7=马来语 等（DD04T/DD01T 的 DDLANGUAGE 值）。",
  inputSchema: z.object({
    mode: z.enum(["copy", "set"]).describe("copy=复制源语言文本到目标语言; set=直接指定翻译文本"),
    targetLanguage: z.string().describe("目标语言键（如 '1' 中文简体、'M' 繁体、'E' 英文）"),
    sourceLanguage: z.string().optional().describe("copy 模式：源语言键，默认 'E'"),
    prefix: z.string().optional().describe("copy 模式：对象名前缀，如 'ZE_AI004' 或 'ZD_AI004'（支持 % 通配）"),
    texts: z
      .array(z.object({ name: z.string().describe("数据元素/域对象名，如 ZE_AI004_DOCDATE"), text: z.string().describe("描述/标签文本") }))
      .optional()
      .describe("set 模式：要写入的对象与文本列表"),
    types: z
      .array(z.enum(["data_element", "domain"]))
      .optional()
      .describe("处理对象类型，默认 ['data_element','domain']"),
    connectionId: connectionIdSchema,
  }),
  async execute(args: {
    mode: string
    targetLanguage: string
    sourceLanguage?: string
    prefix?: string
    texts?: Array<{ name: string; text: string }>
    types?: Array<"data_element" | "domain">
    connectionId?: string
  }): Promise<string> {
    try {
      const connId = await resolveConnectionId(args.connectionId)
      const client = await getClient(connId)
      const tgt = args.targetLanguage
      const src = args.sourceLanguage ?? "E"
      const types = args.types?.length ? args.types : (["data_element", "domain"] as const)

      // 校验参数
      if (args.mode === "copy" && !args.prefix) return "copy 模式需要 prefix 参数（对象名前缀）。"
      if (args.mode === "set" && (!args.texts || args.texts.length === 0)) {
        return "set 模式需要 texts 参数（[{name, text}]）。"
      }
      if (args.mode === "set" && args.texts) {
        const bad = args.texts.filter((t) => !/^[A-Z0-9_/]{1,30}$/.test(t.name.toUpperCase()))
        if (bad.length > 0) return `非法的对象名: ${bad.map((b) => b.name).join(", ")}（仅字母数字下划线）`
      }

      // 动态类名（固定名 + 进程随机后缀避免并发冲突）
      const suffix = randomUUID().slice(0, 4).toUpperCase()
      const className = `ZCL_DDICTXT${suffix}`

      // 生成源码并写入
      const source = generateClassSource(className, args.mode as "copy" | "set", {
        srcLang: src,
        tgtLang: tgt,
        prefix: args.prefix,
        texts: args.texts,
        types: types as Array<"data_element" | "domain">,
      })

      const uri = `/sap/bc/adt/oo/classes/${className.toLowerCase()}`
      const sourceUri = `${uri}/source/main`
      const { objectPath } = await import("abap-adt-api")

      // 创建类
      await client.createObject({
        objtype: "CLAS/OC",
        name: className,
        parentName: "$TMP",
        description: "DDIC 文本语言修复(临时)",
        parentPath: objectPath("CLAS/OC", className, "$TMP"),
      })

      // 写入源码（lock → setObjectSource → unlock，用 source/main URI）
      const { session_types } = await import("abap-adt-api")
      const oldState = client.stateful
      client.stateful = session_types.stateful
      try {
        const lock = await client.lock(sourceUri)
        try {
          await client.setObjectSource(sourceUri, source, lock.LOCK_HANDLE, undefined)
        } finally {
          await client.unLock(sourceUri, lock.LOCK_HANDLE).catch(() => undefined)
        }
      } finally {
        client.stateful = oldState
      }

      // 激活 + 运行
      const act = await client.activate(className, uri)
      if (!act.success) {
        return `激活失败: ${act.messages?.map((m) => m.shortText).join("; ").slice(0, 200)}`
      }
      const result = await client.runClass(className)

      // 清理临时类
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

      return (
        `✅ DDIC 文本已写入（目标语言 ${tgt}${args.mode === "copy" ? `，源语言 ${src}，前缀 ${args.prefix}` : ""}）:\n` +
        result
      )
    } catch (err) {
      return toToolError(err)
    }
  },
}
