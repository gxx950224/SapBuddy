/**
 * 任务级共享传输请求：一个需求（一次写授权）内的多个对象尽量放同一个请求，
 * 避免"一个对象建一个请求"（用户痛点）。
 *
 * 规则：
 * - $TMP 对象不建请求（工具层判断）。
 * - 用户指定 requestNumber → 用用户指定的，并作为本需求共享请求。
 * - 否则本需求内第一个需要请求的对象自动新建一个，后续对象复用（按 连接+开发包 记住）。
 * - 新需求开始（用户批准写操作）或取消（拒绝）时重置，让新需求用新请求。
 */
const active = new Map<string, string>()

function key(connId: string, devClass: string): string {
  return `${connId.toLowerCase()}|${String(devClass || "").toUpperCase()}`
}

/** 取本需求当前共享请求号（可能没有） */
export function getActiveRequest(connId: string, devClass: string): string | undefined {
  return active.get(key(connId, devClass))
}

/** 记住本需求共享请求号（用户指定或自动新建后调用） */
export function setActiveRequest(connId: string, devClass: string, requestNumber: string): void {
  if (requestNumber) active.set(key(connId, devClass), requestNumber)
}

/** 新需求开始（用户批准写操作）或取消（拒绝）时重置 */
export function resetActiveRequests(): void {
  active.clear()
}
