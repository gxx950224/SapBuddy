/**
 * SapBuddy SAP 工具 Pi 扩展（文件扩展）
 * 加载期注册 48 个 SAP 工具 + MCP 外部工具 + 打印启动图标
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createRequire } from "node:module"
import { registerSapTools, installWriteGate, handleUserMessage } from "./register.js"
import { SAPBUDDY_BANNER } from "./banner.js"

const require = createRequire(import.meta.url)
const SAPBUDDY_VERSION: string = require("../../package.json").version

export default async function (pi: ExtensionAPI): Promise<void> {
  // 启动图标：仅进程首次加载打印一次。reload 时扩展重载会再次执行本函数，
  // 若重复打印，TUI 已绘制，多行 ASCII 图标会被界面重绘覆盖只剩一行（残缺）。
  if (!(globalThis as any).__sapbuddy_banner_shown) {
    ;(globalThis as any).__sapbuddy_banner_shown = true
    console.log(SAPBUDDY_BANNER)
    console.log(`  SapBuddy · SAP ABAP AI 全能助手 · 48 个 SAP 工具 · author:guoxiaoxi · 版本:${SAPBUDDY_VERSION}`)
  }
  try {
    registerSapTools(pi)
  } catch (e) {
    console.log(`  [sapbuddy] 工具注册失败: ${e instanceof Error ? e.message : e}`)
  }
  // MCP 外部工具：与 Web/单次提问一致（读取 .SapBuddy/mcp.json → 注册 mcp_<server>_ 工具）
  try {
    const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
    const { registerMcpTools } = await import(pathToFileURL(path.join(ROOT, "src", "sap-tools", "mcp-register.mjs")).href)
    await registerMcpTools(pi)
  } catch (e) {
    console.log(`  [sapbuddy] MCP 工具注册失败: ${e instanceof Error ? e.message : e}`)
  }
  // 写操作人工确认：CLI/TUI 模式原生弹窗
  try {
    installWriteGate(pi)
  } catch (e) {
    console.log(`  [sapbuddy] 写操作拦截器安装失败: ${e instanceof Error ? e.message : e}`)
  }
  // 授权窗口：确认词/拒绝词统一处理（与 Web 同规则，扩展层强制）
  try {
    pi.on("before_agent_start" as never, (event: { prompt?: string }) => {
      try {
        handleUserMessage(event?.prompt || "")
      } catch { /* 忽略 */ }
    })
  } catch (e) {
    console.log(`  [sapbuddy] 授权窗口钩子安装失败: ${e instanceof Error ? e.message : e}`)
  }
}
