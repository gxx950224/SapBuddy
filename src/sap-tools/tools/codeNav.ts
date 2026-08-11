/**
 * 代码导航工具组（只读）：
 * - find_code_definition：定位某个标识符（变量/方法/类/表）的定义处，并回读定义处代码
 * - get_class_hierarchy：查一个类的父类/子类继承结构
 * - get_abap_documentation：查询 ABAP 元素（关键字/类/方法等）的帮助文档
 *
 * ADT 位置型接口（findDefinition/typeHierarchy/abapDocumentation）用的是 1 基的行/列，
 * 且要求把对象当前源码作为请求体一起发给服务器。AI 读完源码后给"行号 + 标识符文字"
 * 即可，工具自己在那一行展开 token 计算起止列，避免 AI 手动数列号。
 */
import { z } from "zod"
import { getClient } from "../adtManager.js"
import {
  requireObject,
  readSourceSmart,
  readSourceByUri,
  resolveConnectionId,
  toToolError,
  connectionIdSchema,
  objectTypeSchema,
} from "./shared.js"

/** 在指定行（1 基）里找 token（不区分大小写），返回 1 基起止列 */
function findTokenOnLine(source: string, line: number, token: string): { start: number; end: number; text: string } | undefined {
  const lines = source.split("\n")
  if (line < 1 || line > lines.length) return undefined
  const text = lines[line - 1] ?? ""
  const idx = text.toUpperCase().indexOf(token.toUpperCase())
  if (idx < 0) return undefined
  return { start: idx + 1, end: idx + token.length, text: text.slice(idx, idx + token.length) }
}

/** 在指定行（1 基）+ 列（1 基）处向两边展开成一个标识符 token */
function expandTokenAtCol(source: string, line: number, col: number): { start: number; end: number; text: string } | undefined {
  const lines = source.split("\n")
  if (line < 1 || line > lines.length) return undefined
  const text = lines[line - 1] ?? ""
  if (col < 1 || col > text.length + 1) return undefined
  const idx = col - 1
  let start = idx
  while (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1] ?? "")) start--
  let end = idx
  while (end < text.length && /[A-Za-z0-9_]/.test(text[end] ?? "")) end++
  if (start === end) return undefined
  return { start: start + 1, end, text: text.slice(start, end) }
}

/** 校验行号/token/列，归一化出 token 位置；返回 undefined 时由调用方给出可读错误 */
function resolveTokenPosition(source: string, line: number, token?: string, column?: number) {
  if (token && String(token).trim()) {
    return findTokenOnLine(source, line, String(token).trim())
  }
  if (column !== undefined) {
    return expandTokenAtCol(source, line, column)
  }
  return undefined
}

// ─── find_code_definition ────────────────────────────────────────────────────
export const findCodeDefinitionTool = {
  name: "find_code_definition",
  title: "Find Code Definition",
  description:
    "定位 ABAP 代码中某个标识符（变量、方法、类、函数、表字段等）的定义处：返回定义所在的对象、行号，并附上定义处那一行代码。" +
    "用于理解变量从哪来、方法实现在哪、字段定义在哪。先 get_abap_object_lines 读源码拿到行号，再传行号 + 标识符文字。",
  inputSchema: z.object({
    objectName: z.string().describe("要分析的源码对象名称，如 ZCL_MY_CLASS"),
    objectType: objectTypeSchema,
    line: z.number().int().min(1).describe("标识符所在行号（1 基，来自 get_abap_object_lines 输出）"),
    token: z
      .string()
      .optional()
      .describe("该行上的标识符文字（如方法名、变量名）。与 column 二选一，优先用 token"),
    column: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("标识符所在列号（1 基）。不传 token 时用此列自动展开。二选一，token 优先"),
    showSource: z.boolean().optional().describe("是否附上定义处源码行，默认 true"),
    connectionId: connectionIdSchema,
  }),
  async execute(args: {
    objectName: string
    objectType?: string
    line: number
    token?: string
    column?: number
    showSource?: boolean
    connectionId?: string
  }): Promise<string> {
    try {
      const connId = await resolveConnectionId(args.connectionId)
      const obj = await requireObject(connId, args.objectName, args.objectType)
      const client = await getClient(connId)
      const source = await readSourceSmart(client, obj["adtcore:type"], obj["adtcore:uri"])
      const pos = resolveTokenPosition(source, args.line, args.token, args.column)
      if (!pos) {
        return (
          `在 ${obj["adtcore:type"]} ${args.objectName} 第 ${args.line} 行找不到标识符` +
          (args.token ? `「${args.token}」` : `（列 ${args.column}）`) +
          `。请核对行号和标识符（第 ${args.line} 行内容: ${(source.split("\n")[args.line - 1] ?? "").trim().slice(0, 80) || "(空)"}）。`
        )
      }
      const def = await client.findDefinition(obj["adtcore:uri"], source, args.line, pos.start, pos.end, false)
      const lines = [`定义位置: ${def.url.replace(/^\/sap\/bc\/adt\//, "")} 第 ${def.line} 行`, `标识符: ${pos.text}`]
      if (args.showSource !== false && def.line > 0) {
        try {
          const defSource = await readSourceByUri(client, def.url, undefined)
          const defLine = (defSource.split("\n")[def.line - 1] ?? "").trim()
          if (defLine) lines.push(`定义处代码: ${defLine.slice(0, 200)}`)
        } catch {
          /* 定义对象无源码（如 DDIC 元数据）时省略 */
        }
      }
      return lines.join("\n")
    } catch (err) {
      return toToolError(err)
    }
  },
}

// ─── get_class_hierarchy ─────────────────────────────────────────────────────
export const getClassHierarchyTool = {
  name: "get_class_hierarchy",
  title: "Get Class Hierarchy",
  description:
    "查看一个类的继承结构：父类/接口（superTypes）或子类（subTypes）。用于理解类之间的关系、判断重写来源。" +
    "输入类名（如 ZCL_MY_CLASS）即可。",
  inputSchema: z.object({
    objectName: z.string().describe("类名，如 ZCL_MY_CLASS"),
    objectType: objectTypeSchema,
    superTypes: z.boolean().optional().describe("true=查父类/接口链，false=查子类。默认 true"),
    connectionId: connectionIdSchema,
  }),
  async execute(args: { objectName: string; objectType?: string; superTypes?: boolean; connectionId?: string }): Promise<string> {
    try {
      const connId = await resolveConnectionId(args.connectionId)
      const obj = await requireObject(connId, args.objectName, args.objectType ?? "CLAS")
      const client = await getClient(connId)
      const source = await readSourceSmart(client, obj["adtcore:type"], obj["adtcore:uri"])
      // 定位 CLASS <名字> DEFINITION 声明行与类名所在列（源码常以版权注释开头，不能写死第 1 行第 1 列；
      // typeHierarchy 的光标必须落在类名上才解析得出继承链）
      const srcLines = source.split("\n")
      const declIdx = srcLines.findIndex((l) => /^\s*CLASS\s+[a-z0-9_]+\s+DEFINITION\b/i.test(l))
      const line = (declIdx >= 0 ? declIdx : 0) + 1
      const declLine = srcLines[declIdx >= 0 ? declIdx : 0] ?? ""
      const m = /^\s*class\s+([a-z0-9_]+)/i.exec(declLine)
      const col = m && m[1] ? declLine.indexOf(m[1]) + 1 : 1
      const nodes = await client.typeHierarchy(obj["adtcore:uri"], source, line, col, args.superTypes !== false)
      if (!nodes || nodes.length === 0) {
        return `${args.superTypes === false ? "子类" : "父类/接口"}链为空：${args.objectName} 可能没有${args.superTypes === false ? "子类" : "继承的父类/接口"}。`
      }
      const mode = args.superTypes === false ? "子类（subTypes）" : "父类/接口（superTypes）"
      const lines = [`${args.objectName} 的${mode}:`, ""]
      for (const n of nodes) {
        const def = n.hasDefOrImpl ? "" : "（仅声明/无实现）"
        lines.push(`- ${n.name}  [${n.type}]${n.description ? ` ${n.description}` : ""}${def}`)
      }
      return lines.join("\n")
    } catch (err) {
      return toToolError(err)
    }
  },
}

// ─── get_abap_documentation ──────────────────────────────────────────────────
export const getAbapDocumentationTool = {
  name: "get_abap_documentation",
  title: "Get ABAP Documentation",
  description:
    "查询 ABAP 元素（关键字、语句、类、方法、函数等）的官方帮助文档说明。给源码对象 + 行号 + 标识符，" +
    "返回该元素在光标处的说明。用于理解某段代码用到的语句/关键字/接口的用法。",
  inputSchema: z.object({
    objectName: z.string().describe("源码对象名称，如 ZCL_MY_CLASS、ZREPORT"),
    objectType: objectTypeSchema,
    line: z.number().int().min(1).describe("标识符所在行号（1 基）"),
    token: z
      .string()
      .optional()
      .describe("该行上的标识符/关键字（如 MESSAGE、CALL METHOD）。与 column 二选一，token 优先"),
    column: z.number().int().min(1).optional().describe("标识符所在列号（1 基）。不传 token 时用此列展开"),
    language: z.string().optional().describe("文档语言代码（如 EN、ZH），默认 EN"),
    connectionId: connectionIdSchema,
  }),
  async execute(args: {
    objectName: string
    objectType?: string
    line: number
    token?: string
    column?: number
    language?: string
    connectionId?: string
  }): Promise<string> {
    try {
      const connId = await resolveConnectionId(args.connectionId)
      const obj = await requireObject(connId, args.objectName, args.objectType)
      const client = await getClient(connId)
      const source = await readSourceSmart(client, obj["adtcore:type"], obj["adtcore:uri"])
      const pos = resolveTokenPosition(source, args.line, args.token, args.column)
      if (!pos) {
        return (
          `在 ${obj["adtcore:type"]} ${args.objectName} 第 ${args.line} 行找不到标识符` +
          (args.token ? `「${args.token}」` : `（列 ${args.column}）`) +
          `。请核对行号和标识符。`
        )
      }
      const doc = await client.abapDocumentation(obj["adtcore:uri"], source, args.line, pos.start, args.language ?? "EN")
      const clean = String(doc ?? "")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&nbsp;|&ensp;|&emsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\s+/g, " ")
        .trim()
      if (!clean) return `「${pos.text}」没有可用的 ABAP 帮助文档（可能非文档化元素）。`
      return `「${pos.text}」的 ABAP 帮助文档:\n${clean.slice(0, 3000)}`
    } catch (err) {
      return toToolError(err)
    }
  },
}
