/** 写前守卫与交互式工具共用同一套配置和 T000 客户端类别判断。 */
import { assertDevClient } from "../adtManager.js"
import { getConfig } from "../config.js"
import { BotGateError } from "./gates.js"

export async function assertBotWriteAllowed(connectionId: string): Promise<void> {
  if (getConfig().security?.readOnly !== false) {
    throw new BotGateError(
      "readonly",
      "安全拦截：connections.json 的 security.readOnly 未显式设为 false，bot session 拒绝写入和激活。",
    )
  }
  try {
    await assertDevClient(connectionId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new BotGateError("dev_client", message)
  }
}
