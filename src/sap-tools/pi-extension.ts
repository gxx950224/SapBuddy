/**
 * SapBuddy SAP 工具 Pi 扩展（文件扩展）
 * 加载期直接注册 42 个 SAP 工具（不能依赖 session_start，需在工厂执行时注册）
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { registerSapTools } from "./register.js"

export default function (pi: ExtensionAPI): void {
  try {
    const n = registerSapTools(pi)
    console.log(`[sapbuddy] 已注册 ${n} 个 SAP 工具`)
  } catch (e) {
    console.log(`[sapbuddy] 工具注册失败: ${e instanceof Error ? e.message : e}`)
  }
}
