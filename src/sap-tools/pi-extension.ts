/**
 * SapBuddy SAP 工具 Pi 扩展（文件扩展，session_start 时注册 42 个 SAP 工具）
 * 通过 DefaultResourceLoader 的 additionalExtensionPaths 加载
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { registerSapTools } from "./register.js"

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    try {
      const n = registerSapTools(pi)
      console.log(`[sapbuddy] 已注册 ${n} 个 SAP 工具`)
    } catch (e) {
      console.log(`[sapbuddy] 工具注册失败: ${e instanceof Error ? e.message : e}`)
    }
  })
}
