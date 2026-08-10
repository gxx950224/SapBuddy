/** 工具注册表：导出全部 43 个工具（直接作为 pi customTools 注册） */
import { z } from "zod"
import { connectedSystemsTool } from "./connectedSystems.js"
import { searchObjectsTool } from "./searchObjects.js"
import { getObjectLinesTool } from "./getObjectLines.js"
import { getObjectInfoTool } from "./getObjectInfo.js"
import { whereUsedTool } from "./whereUsed.js"
import { searchObjectLinesTool, getBatchLinesTool, getObjectByUriTool, getWorkspaceUriTool, getObjectUrlTool } from "./navigation.js"
import { createObjectTool, activateTool, replaceStringTool, diagnosticsTool, createTestIncludeTool, updateDescriptionTool } from "./writeTools.js"
import { runUnitTestsTool, atcTool, atcDecorationsTool, dataQueryTool, sqlSyntaxTool } from "./quality.js"
import { transportTool, textElementsTool } from "./transportText.js"
import { createMermaidTool, validateMermaidTool, mermaidDocTool, detectMermaidTool } from "./mermaid.js"
import { dumpAnalysisTool, traceAnalysisTool, versionHistoryTool } from "./runtime.js"
import { sapSystemInfoTool, adtDiscoveryTool, documentationTool, debugTools } from "./system.js"
import { fixDdicTextTool } from "./ddicText.js"
import { updateDomainTool } from "./domainProps.js"
import { translateTextPoolTool } from "./textPool.js"
import { translateMessageClassTool } from "./messageClassText.js"

export interface ToolDef {
  name: string
  title: string
  description: string
  /** zod schema 实例 */
  inputSchema: z.ZodType
  execute(args: Record<string, unknown>): Promise<string>
  /** 写操作标记：只读模式下被拒绝 */
  write?: boolean
}

export const tools: ToolDef[] = [
  // 基础（5）
  connectedSystemsTool,
  searchObjectsTool,
  getObjectLinesTool,
  getObjectInfoTool,
  whereUsedTool,
  // 搜索/导航（5）
  searchObjectLinesTool,
  getBatchLinesTool,
  getObjectByUriTool,
  getWorkspaceUriTool,
  getObjectUrlTool,
  // 写操作（6）
  createObjectTool,
  activateTool,
  replaceStringTool,
  diagnosticsTool,
  createTestIncludeTool,
  updateDescriptionTool,
  // 质量/测试/数据（5）
  runUnitTestsTool,
  atcTool,
  atcDecorationsTool,
  dataQueryTool,
  sqlSyntaxTool,
  // 传输/文本（2）
  transportTool,
  textElementsTool,
  // Mermaid（4）
  createMermaidTool,
  validateMermaidTool,
  mermaidDocTool,
  detectMermaidTool,
  // 运行时分析（3）
  dumpAnalysisTool,
  traceAnalysisTool,
  versionHistoryTool,
  // 系统/文档（3）
  sapSystemInfoTool,
  adtDiscoveryTool,
  documentationTool,
  // DDIC 文本修复（1）
  fixDdicTextTool,
  // 域属性（1）
  updateDomainTool,
  // 文本池翻译（1）
  translateTextPoolTool,
  // 消息类翻译（1）
  translateMessageClassTool,
  // 调试（6，降级说明）
  ...debugTools,
] as unknown as ToolDef[]
