/**
 * SapBuddy SAP 工具 Pi 扩展（文件扩展）
 * 加载期直接注册 42 个 SAP 工具 + 打印启动图标
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { registerSapTools } from "./register.js"
import { SAPBUDDY_BANNER } from "./banner.js"

export default function (pi: ExtensionAPI): void {
  // 启动图标（pi CLI 顶部信息区显示）
  console.log(SAPBUDDY_BANNER)
  console.log("  SapBuddy · SAP ABAP AI 全能助手 · 42 个 SAP 工具")
  try {
    const n = registerSapTools(pi)
    console.log(`  [sapbuddy] 已注册 ${n} 个 SAP 工具`)
  } catch (e) {
    console.log(`  [sapbuddy] 工具注册失败: ${e instanceof Error ? e.message : e}`)
  }
}
