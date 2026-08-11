/** 工具组：搜索/导航扩展（search_abap_object_lines、get_batch_lines、get_object_by_uri、get_abap_object_workspace_uri、get_abap_object_url） */
import { z } from "zod"
import { getClient } from "../adtManager.js"
import {
  findObject,
  normalizeFunctionGroupIncludeUri,
  readSourceSmart,
  requireObject,
  resolveConnectionId,
  sliceLines,
  toToolError,
  connectionIdSchema,
  objectTypeSchema,
} from "./shared.js"

// ─── search_abap_object_lines ───────────────────────────────────────────────
export const searchObjectLinesTool = {
  name: "search_abap_object_lines",
  title: "Search ABAP Object Lines",
  description:
    "在 ABAP 对象源码内搜索文本（支持正则），返回命中的行号、匹配行及上下文。可用于列出类的方法（搜 METHOD）、查找变量引用、定位错误行等。",
  inputSchema: z.object({
    objectName: z.string().describe("对象名称，如 ZCL_MY_CLASS"),
    searchTerm: z.string().describe("要搜索的文本，如 METHOD、data、ZVAR_。isRegexp=true 时为正则"),
    contextLines: z.number().int().min(0).max(20).optional().describe("匹配行前后上下文行数，默认 3"),
    isRegexp: z.boolean().optional().describe("searchTerm 是否为正则，默认 false（大小写不敏感包含匹配）"),
    maxMatches: z.number().int().min(1).max(500).optional().describe("最大返回匹配数，默认 100"),
    objectType: objectTypeSchema,
    connectionId: connectionIdSchema,
  }),
  async execute(args: {
    objectName: string
    searchTerm: string
    contextLines?: number
    isRegexp?: boolean
    maxMatches?: number
    objectType?: string
    connectionId?: string
  }): Promise<string> {
    try {
      const connId = await resolveConnectionId(args.connectionId)
      const obj = await requireObject(connId, args.objectName, args.objectType)
      const client = await getClient(connId)
      const source = await readSourceSmart(client, obj["adtcore:type"], obj["adtcore:uri"])
      const lines = source.split("\n")
      const context = args.contextLines ?? 3
      const max = args.maxMatches ?? 100
      const regex = args.isRegexp ? new RegExp(args.searchTerm, "i") : null

      const hits: string[] = []
      for (let i = 0; i < lines.length && hits.length < max; i++) {
        const line = lines[i]
        const matched = regex ? regex.test(line) : line.toUpperCase().includes(args.searchTerm.toUpperCase())
        if (!matched) continue
        const start = Math.max(0, i - context)
        const end = Math.min(lines.length - 1, i + context)
        hits.push(`--- 第 ${i + 1} 行 ---`)
        for (let j = start; j <= end; j++) {
          hits.push(`${String(j + 1).padStart(6)}| ${lines[j]}`)
        }
      }

      if (hits.length === 0) {
        return `在 ${args.objectName} 中未找到 "${args.searchTerm}"${args.isRegexp ? "（正则）" : ""}。` +
          `可尝试：更短的关键词、或改用 isRegexp=true。`
      }
      const limited = hits.length >= max ? `（达到上限 ${max}，建议细化搜索词）` : ""
      return `在 ${args.objectName}（${lines.length} 行）中找到 ${hits.filter((h) => h.startsWith("---")).length} 处匹配${limited}:\n\n${hits.join("\n")}`
    } catch (err) {
      return toToolError(err)
    }
  },
}

// ─── get_batch_lines ────────────────────────────────────────────────────────
export const getBatchLinesTool = {
  name: "get_batch_lines",
  title: "Get Batch Lines",
  description:
    "一次调用读取多个 ABAP 对象的源码（并行获取）。每个请求可指定对象名和可选行区间。比逐个调用 get_abap_object_lines 更高效。",
  inputSchema: z.object({
    requests: z
      .array(
        z.object({
          objectName: z.string().describe("对象名称"),
          objectType: z.string().optional().describe("对象类型，推荐提供以精确定位"),
          startLine: z.number().int().min(1).optional(),
          lineCount: z.number().int().min(1).optional(),
        })
      )
      .min(1)
      .max(10)
      .describe("要读取的对象列表（最多 10 个）"),
    connectionId: connectionIdSchema,
  }),
  async execute(args: { requests: Array<{ objectName: string; objectType?: string; startLine?: number; lineCount?: number }>; connectionId?: string }): Promise<string> {
    try {
      const connId = await resolveConnectionId(args.connectionId)
      const results = await Promise.all(
        args.requests.map(async (req) => {
          try {
            const obj = await requireObject(connId, req.objectName, req.objectType)
            const client = await getClient(connId)
            const source = await readSourceSmart(client, obj["adtcore:type"], obj["adtcore:uri"])
            const { header, content } = sliceLines(source, req.startLine, req.lineCount)
            return `===== ${obj["adtcore:type"]} ${obj["adtcore:name"]}（${header}）=====\n${content}`
          } catch (err) {
            return `===== ${req.objectName} =====\n读取失败: ${err instanceof Error ? err.message : err}`
          }
        })
      )
      return results.join("\n\n")
    } catch (err) {
      return toToolError(err)
    }
  },
}

// ─── get_object_by_uri ──────────────────────────────────────────────────────
export const getObjectByUriTool = {
  name: "get_object_by_uri",
  title: "Get Object By URI",
  description:
    "通过 ADT URI 直接访问对象源码（URI 可从 get_abap_object_workspace_uri、search_abap_objects 或 find_where_used 的结果中获得）。适用于已持有 URI 的调用链，避免重复搜索。",
  inputSchema: z.object({
    uri: z.string().describe("ADT 对象 URI，如 /sap/bc/adt/oo/classes/zcl_my_class/source/main"),
    startLine: z.number().int().min(1).optional(),
    lineCount: z.number().int().min(1).optional(),
    connectionId: connectionIdSchema,
  }),
  async execute(args: { uri: string; startLine?: number; lineCount?: number; connectionId?: string }): Promise<string> {
    try {
      const connId = await resolveConnectionId(args.connectionId)
      // ⛔ URI 格式校验：必须是 ADT 对象 URI（/sap/bc/adt/...）。
      // ① get_abap_object_workspace_uri 返回的「工作区 URI」（adt://...）是 ADT 树定位路径、不是可读源码地址，直接拒绝；
      // ② 拒绝路径穿越（..）、查询串、锚点与空白——防止任意 URI 直读绕过对象解析（读源码只走对象 URI 通道）。
      const uri = (args.uri ?? "").trim()
      if (!/^\/sap\/bc\/adt\/[a-z0-9/._-]+$/i.test(uri) || uri.includes("..")) {
        return (
          `⛔ 无效的 ADT 对象 URI: "${args.uri}"（应形如 /sap/bc/adt/oo/classes/zcl_xxx/source/main）。\n` +
          `请用 get_abap_object_workspace_uri 返回的「ADT 对象 URI」行，不要用 adt:// 工作区 URI。`
        )
      }
      const client = await getClient(connId)
      const source = await readSourceSmart(client, undefined, uri)
      const { header, content } = sliceLines(source, args.startLine, args.lineCount)
      // 可识别的对象名（末段前含类型目录的 URI）：非 Z*/Y* 对象仅作只读参考，写操作会被写门禁拦截
      const lastSeg = uri.split("/").filter(Boolean).pop() ?? ""
      const note = lastSeg !== "main" && /^[A-Za-z][A-Za-z0-9_]*$/.test(lastSeg) && !/^[ZY]/i.test(lastSeg)
        ? `\n（${lastSeg} 为 SAP 标准对象，只读参考；写操作会被拦截）`
        : ""
      return `URI ${uri} 的源码（${header}）:\n\n${content}${note}`
    } catch (err) {
      return toToolError(err)
    }
  },
}

// ─── get_abap_object_workspace_uri ──────────────────────────────────────────
export const getWorkspaceUriTool = {
  name: "get_abap_object_workspace_uri",
  title: "Get ABAP Object Workspace URI",
  description:
    "返回对象的 ADT 对象 URI（/sap/bc/adt/...，用作 replace_string_in_abap_object 的 fileUri）。工作区 URI（adt://...）只是 ADT 树里的定位路径、不是可读写源码的地址——请用返回结果里的「ADT 对象 URI」行，不要用工作区 URI（写工具虽会自动转换，但直接用 ADT 对象 URI 最稳妥）。",
  inputSchema: z.object({
    objectName: z.string().describe("对象名称"),
    objectType: objectTypeSchema,
    connectionId: connectionIdSchema,
  }),
  async execute(args: { objectName: string; objectType?: string; connectionId?: string }): Promise<string> {
    try {
      const connId = await resolveConnectionId(args.connectionId)
      const obj = await requireObject(connId, args.objectName, args.objectType)
      const client = await getClient(connId)
      // 函数组内部程序（FUGR/F、FUGR/I）的 findObjectPath 走不到对象、只到连接根（返回 adt://dev/），
      // 且经通用通道解析时 URI 是只读的 /programs/includes/…… 直接改为可写的 /functions/groups/<fg>/includes/<inc>
      // 函数模块（FUGR/FF）的 findObjectPath 会截断 URI 成 /.../source/mai（尾部被吃掉），
      // 直接用它自身的 /functions/groups/<fg>/fmodules/<fm> 通道（/source/main 是合成视图，接口参数只能从这里写）
      let path: string
      if (obj["adtcore:type"] === "FUGR/FF") {
        path = obj["adtcore:uri"]
      } else if (obj["adtcore:type"] === "FUGR/F" || obj["adtcore:type"] === "FUGR/I") {
        path = (await normalizeFunctionGroupIncludeUri(connId, obj["adtcore:uri"])) ?? obj["adtcore:uri"]
      } else {
        const steps = await client.findObjectPath(obj["adtcore:uri"])
        path = steps.map((s) => s["adtcore:name"]).join("/")
      }
      // 对象 URI 自带前导 /，直接拼接避免出现 adt://dev//sap 双斜杠
      const ws = path.startsWith("/") ? `adt://${connId}${path}` : `adt://${connId}/${path}`
      return `ADT 对象 URI: ${obj["adtcore:uri"]}\n类型: ${obj["adtcore:type"]}\n工作区 URI（仅 ADT 树定位，写源码勿用，工具会自动转换）: ${ws}`
    } catch (err) {
      return toToolError(err)
    }
  },
}

// ─── get_abap_object_url (WebGUI) ───────────────────────────────────────────
export const getObjectUrlTool = {
  name: "get_abap_object_url",
  title: "Get ABAP Object URL",
  description:
    "生成对象在 SAP GUI WebGUI 中的访问 URL（可用于浏览器自动化或人工核对）。基于系统地址与对象 URI 构造。",
  inputSchema: z.object({
    objectName: z.string().describe("对象名称"),
    objectType: objectTypeSchema,
    connectionId: connectionIdSchema,
  }),
  async execute(args: { objectName: string; objectType?: string; connectionId?: string }): Promise<string> {
    try {
      const connId = await resolveConnectionId(args.connectionId)
      const obj = await requireObject(connId, args.objectName, args.objectType)
      const { getConnection } = await import("../adtManager.js")
      const conf = getConnection(connId)
      const base = conf.url.replace(/\/+$/, "")
      const url = `${base}${obj["adtcore:uri"]}`
      return (
        `对象: ${obj["adtcore:type"]} ${obj["adtcore:name"]}\n` +
        `WebGUI/ADT URL: ${url}\n` +
        `说明: 此 URL 指向 ADT 服务端点，浏览器访问需具备 ICF 权限（/sap/bc/adt）。`
      )
    } catch (err) {
      return toToolError(err)
    }
  },
}
