/**
 * 会话录制/回放客户端（真机录、离线回放）
 *
 * makeRecordingClient(real, outPath)：包一层真实 ADT 客户端，把每次方法调用
 * （方法名 + 参数 + 结果/错误）追加成 JSONL 写到 outPath，供后续离线回放。
 *
 * makeCassetteClient(cassettePath)：读 JSONL 录制文件，返回一个 Proxy 客户端。
 * 按「方法名+参数」精确匹配回放录制的结果；没录到的调用抛 [cassette] 缺失错误，
 * 让测试作者立刻知道是"没录这段"，而不是悄悄静默。
 *
 * login() 在回放时恒为 no-op（录制时实际登录动作与要测的调用无关）。
 * 同一行记录的 args 用稳定序列化（对象键排序）做键，保证录制/回放两侧参数等价匹配。
 */
import { readFileSync, createWriteStream, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"

/** 稳定序列化：对象键排序，undefined 有固定表示，函数/循环引用兜底 —— 录制与回放用同一套 */
function stableStringify(value, seen = new Set()) {
  if (value === undefined) return '"__undefined__"'
  if (typeof value === "number" || typeof value === "boolean" || value === null) return JSON.stringify(value)
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "bigint") return JSON.stringify(String(value))
  if (typeof value === "function") return '"__function__"'
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v, seen)).join(",")}]`
  if (typeof value === "object") {
    if (seen.has(value)) return '"__circular__"'
    seen.add(value)
    const keys = Object.keys(value).sort()
    const out = `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k], seen)}`).join(",")}}`
    seen.delete(value)
    return out
  }
  return JSON.stringify(String(value))
}

/** 方法+参数 → 匹配键 */
export function argsKey(method, args) {
  return `${method}(${stableStringify(args ?? [])})`
}

/** 只记录可被回放的调用：跳过内部 setter/getter 与 login（回放侧 login 是 no-op） */
const SKIP_METHODS = new Set(["login", "dropSession", "setCookie", "setCsrfToken", "log"])

/** 包一层真实客户端，把方法调用记录到 JSONL（追加模式） */
export function makeRecordingClient(real, outPath) {
  mkdirSync(dirname(outPath), { recursive: true })
  const stream = createWriteStream(outPath, { flags: "a" })
  const write = (line) => stream.write(JSON.stringify(line) + "\n")

  return new Proxy(real, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== "function") return value
      return async (...args) => {
        const m = String(prop)
        let result
        try {
          result = await value.apply(target, args)
        } catch (err) {
          if (!SKIP_METHODS.has(m)) write({ m, args, error: String(err && err.message) })
          throw err
        }
        if (!SKIP_METHODS.has(m)) write({ m, args, result })
        return result
      }
    },
  })
}

/** 读取 JSONL 录制文件，返回一个按「方法+参数」回放的 Proxy 客户端 */
export function makeCassetteClient(cassettePath) {
  const entries = readFileSync(cassettePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  if (entries.length === 0) throw new Error(`[cassette] 录制文件为空: ${cassettePath}`)

  const byKey = new Map()
  for (const e of entries) {
    const key = argsKey(e.m, e.args)
    if (byKey.has(key)) continue // 同键多次：保留第一条（典型重试场景录的是首次结果）
    byKey.set(key, e)
  }

  const replay = (m, args) => {
    const entry = byKey.get(argsKey(m, args))
    if (!entry) {
      throw new Error(`[cassette] 缺少录制条目: ${argsKey(m, args)}（请先对真实 SAP 录制该调用）`)
    }
    if ("error" in entry) throw new Error(entry.error)
    return entry.result
  }

  return new Proxy(
    {},
    {
      get(_target, prop, _receiver) {
        if (prop === "login") return async () => undefined
        if (prop === "dropSession") return async () => undefined
        // Promise 协议会检查 then/catch/finally 判断 thenable；若按普通方法回放会被 Promise 合并调用
        if (prop === "then" || prop === "catch" || prop === "finally") return undefined
        if (typeof prop === "symbol") return undefined
        const m = String(prop)
        return async (...args) => replay(m, args)
      },
    }
  )
}

/** 记录脚本共用：把真实客户端包成录制客户端 */
export function withRecorder(real, outPath) {
  return makeRecordingClient(real, outPath)
}
