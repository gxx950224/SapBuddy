/**
 * 域属性更新工具：修改域的符号(sign)、区分大小写(lowercase)、转换例程、输出长度等
 * 通过 getDomainProperties 读现有属性 → 合并修改 → setDomainProperties → 激活
 */
import { z } from "zod"
import { session_types } from "abap-adt-api"
import { getClient } from "../adtManager.js"
import { resolveConnectionId, toToolError, connectionIdSchema } from "./shared.js"

export const updateDomainTool = {
  name: "update_domain_properties",
  write: true,
  title: "Update Domain Properties",
  description:
    "修改 ABAP 域的属性：符号（sign，数值域允许正负号）、区分大小写（lowercase，字符域允许小写）、转换例程（conversionExit）、输出长度等。" +
    "未指定的属性保持不变（先读现有属性再合并）。修改后自动激活。",
  inputSchema: z.object({
    domainName: z.string().describe("域名，如 ZD_AI004_SCENARIO"),
    sign: z.boolean().optional().describe("允许符号（正负号），适用于数值域（DEC/CURR/QUAN/INT）"),
    lowercase: z.boolean().optional().describe("区分大小写（允许小写字母），适用于字符域（CHAR）"),
    conversionExit: z.string().optional().describe("转换例程，如 ALPHA、NUMCV 等（空字符串清除）"),
    outputLength: z.number().int().min(1).max(31).optional().describe("输出长度"),
    connectionId: connectionIdSchema,
  }),
  async execute(args: {
    domainName: string
    sign?: boolean
    lowercase?: boolean
    conversionExit?: string
    outputLength?: number
    connectionId?: string
  }): Promise<string> {
    try {
      const connId = await resolveConnectionId(args.connectionId)
      const client = await getClient(connId)
      const name = args.domainName.toUpperCase()
      const url = `/sap/bc/adt/ddic/domains/${name.toLowerCase()}`

      // 读现有属性
      const current = await client.getDomainProperties(url)
      const type = current.properties.typeInformation
      const output = current.properties.outputInformation

      // 合并修改
      const newOutput = {
        length: args.outputLength ?? output.length,
        style: output.style ?? "",
        conversionExit: args.conversionExit !== undefined ? args.conversionExit : (output.conversionExit ?? ""),
        signExists: args.sign ?? output.signExists,
        lowercase: args.lowercase ?? output.lowercase,
        ampmFormat: output.ampmFormat ?? false,
      }

      // 合理性提示
      const notes: string[] = []
      if (args.sign !== undefined && !/^(DEC|CURR|QUAN|INT|FLTP)$/.test(type.datatype)) {
        notes.push(`⚠️ 域类型 ${type.datatype} 不是数值类型，符号属性可能不生效（仅 DEC/CURR/QUAN/INT/FLTP 有意义）`)
      }
      if (args.lowercase !== undefined && !/^(CHAR|LCHR|LANG|SSTR)$/.test(type.datatype)) {
        notes.push(`⚠️ 域类型 ${type.datatype} 不是字符类型，区分大小写可能不生效（仅 CHAR/LCHR/LANG 有意义）`)
      }

      const oldState = client.stateful
      client.stateful = session_types.stateful
      try {
        const lock = await client.lock(url)
        try {
          const lockInfo = lock as { CORRNR?: string; IS_LOCAL?: string }
          const transport = lockInfo.IS_LOCAL === "X" ? undefined : lockInfo.CORRNR
          await client.setDomainProperties(
            url,
            {
              typeInformation: type,
              outputInformation: newOutput,
            },
            {
              name,
              description: current.metaData.description ?? "",
              language: "ZH",
              masterLanguage: "ZH",
              masterSystem: "DS4",
              responsible: "BC01",
              packageName: "$TMP",
            },
            lock.LOCK_HANDLE,
            transport
          )
        } finally {
          await client.unLock(url, lock.LOCK_HANDLE).catch(() => undefined)
        }
      } finally {
        client.stateful = oldState
      }

      await client.activate(name, url)

      return (
        `✅ 域 ${name} 属性已更新并激活:\n` +
        `  类型: ${type.datatype}(${type.length}${type.decimals ? "," + type.decimals : ""})\n` +
        `  符号: ${newOutput.signExists ? "允许(±)" : "不允许"}\n` +
        `  区分大小写: ${newOutput.lowercase ? "是(允许小写)" : "否(强制大写)"}\n` +
        `  转换例程: ${newOutput.conversionExit || "(无)"}\n` +
        `  输出长度: ${newOutput.length}` +
        (notes.length > 0 ? `\n${notes.join("\n")}` : "")
      )
    } catch (err) {
      return toToolError(err)
    }
  },
}
