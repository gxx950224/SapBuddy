import { AsyncLocalStorage } from "node:async_hooks"

export interface ToolFailure { code: string; retryable: boolean; message: string }
const execution = new AsyncLocalStorage<{ signal: AbortSignal; failures: ToolFailure[] }>()
export function executionSignal(): AbortSignal | undefined { return execution.getStore()?.signal }
export function checkCancelled(): void { executionSignal()?.throwIfAborted() }
/** Only for shared initialization, never for a running write or its lock ownership. */
export function waitForReady<T>(ready: Promise<T>): Promise<T> {
  const signal = executionSignal()
  signal?.throwIfAborted()
  if (!signal) return ready
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason) }
    signal.addEventListener("abort", abort, { once: true })
    ready.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}
export function classifyFailure(error: unknown): ToolFailure {
  const message = error instanceof Error ? error.message : String(error)
  const status = Number((error as { status?: number })?.status)
  const code = /abort|cancel|取消|停止/i.test(message) ? "CANCELLED"
    : /timeout|timedout|超时/i.test(message) ? "TIMEOUT"
    : status === 401 || status === 403 || /无权限|permission|unauthorized|forbidden/i.test(message) ? "PERMISSION"
    : status === 404 || /未找到|不存在|not found/i.test(message) ? "NOT_FOUND"
    : /ECONN|ENOTFOUND|EPIPE|socket|network|fetch failed|连接失败|TLS|CERT_/i.test(message) || status >= 500 ? "CONNECTION"
    : /参数|invalid|无效/i.test(message) ? "INVALID_ARGUMENT" : "TOOL_ERROR"
  return { code, retryable: code === "CONNECTION" || code === "TIMEOUT", message: message.replace(/<stack>[\s\S]*?<\/stack>/gi, "[堆栈已省略]").slice(0, 600) }
}
export function recordFailure(error: unknown): ToolFailure {
  const failure = classifyFailure(error)
  execution.getStore()?.failures.push(failure)
  return failure
}
/** One deadline across lock acquisition, login and all requests. Never detach a running write. */
export async function runToolExecution<T>(signal: AbortSignal | undefined, fn: () => Promise<T>, timeoutMs = 120_000) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error("工具执行超时")), timeoutMs)
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  const state = { signal: combined, failures: [] as ToolFailure[] }
  try {
    return await execution.run(state, async () => {
      checkCancelled()
      const value = await fn()
      checkCancelled()
      return { value, failures: state.failures }
    })
  } finally { clearTimeout(timeout) }
}
/** Unlock/logout cleanup has its own short deadline even after the user's cancellation. */
export function runCleanup<T>(fn: () => Promise<T>): Promise<T> {
  return runToolExecution(undefined, fn, 10_000).then(r => r.value)
}
