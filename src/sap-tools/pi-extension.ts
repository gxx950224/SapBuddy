/**
 * SapBuddy SAP 工具 Pi 扩展（文件扩展）
 * 加载期直接注册 42 个 SAP 工具 + 打印启动图标
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { registerSapTools, installWriteGate, handleUserMessage } from "./register.js"
import { SAPBUDDY_BANNER } from "./banner.js"

export default function (pi: ExtensionAPI): void {
  // 启动图标（pi CLI 顶部信息区显示）
  console.log(SAPBUDDY_BANNER)
  console.log("  SapBuddy · SAP ABAP AI 全能助手 · 42 个 SAP 工具")
  try {
    registerSapTools(pi)
  } catch (e) {
    console.log(`  [sapbuddy] 工具注册失败: ${e instanceof Error ? e.message : e}`)
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
