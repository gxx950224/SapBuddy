import { createHash } from "node:crypto"
import type { ActivationResult, ADTClient } from "abap-adt-api"
import { getOptimalObjectURI, sanitizeErrMsg } from "./shared.js"

export interface ActivationStage {
  name: string
  success: boolean
  messages: ActivationResult["messages"]
}
export interface ActivationReport extends ActivationResult {
  stages: ActivationStage[]
  verification?: "matched" | "mismatch" | "unavailable" | "not_applicable"
  sourceHash?: string
}

/** Preserve the origin of errors; an inactive object or error cannot be a successful stage. */
export function mergeActivationResults(results: ActivationResult[], names: string[]): ActivationReport {
  const stages = results.flatMap((r, i) => (r as ActivationReport).stages ?? [{
    name: names[i],
    success: r.success && !(r.messages ?? []).some(m => /^(E|A|X)$/i.test(m.type)) && !(r.inactive ?? []).length,
    messages: r.messages ?? [],
  }])
  const inactive = [...new Map(results.flatMap(r => r.inactive ?? []).map(r => [
    `${r.object?.["adtcore:type"]}|${r.object?.["adtcore:uri"] ?? r.object?.["adtcore:name"]}`, r,
  ])).values()]
  return { success: stages.every(s => s.success), stages, messages: results.flatMap(r => r.messages ?? []), inactive }
}

function failedStage(name: string, message: string): ActivationReport {
  return mergeActivationResults([{
    success: false, inactive: [],
    messages: [{ objDescr: "", type: "E", line: 0, href: "", forceSupported: false, shortText: message }],
  }], [name])
}

// Only normalize transport formatting, never whitespace inside ABAP literals or identifiers.
const sourceHash = (source: string) => createHash("sha256")
  .update(source.replace(/\r\n/g, "\n").replace(/\n+$/, ""))
  .digest("hex")

/** Called inside the existing connection write mutex: check -> activate -> read active source. */
export async function verifyActivation(
  client: Pick<ADTClient, "getObjectSource" | "syntaxCheck">,
  obj: { "adtcore:uri": string; "adtcore:type"?: string },
  activate: () => Promise<ActivationReport>,
): Promise<ActivationReport> {
  const type = obj["adtcore:type"] ?? ""
  if (!/^(PROG\/[PI]|CLAS\/OC|INTF\/OI|FUGR\/(FF|I))$/.test(type)) {
    return { ...await activate(), verification: "not_applicable" }
  }
  const uri = getOptimalObjectURI(type, obj["adtcore:uri"])
  let source: string
  let syntax: ActivationReport
  try {
    try {
      source = await client.getObjectSource(uri, { version: "inactive" })
    } catch (err) {
      // Only an absent inactive version permits falling back to the active version.
      const responseError = err as { status?: number; response?: { status?: number } }
      if (Number(responseError.status ?? responseError.response?.status) !== 404) throw err
      source = await client.getObjectSource(uri, { version: "active" })
    }
    const checks = await client.syntaxCheck(uri, uri, source)
    const errors = (checks ?? []).filter(c => /^(E|A|X)$/i.test(c.severity))
    if (errors.length) return failedStage("激活前语法检查", errors.slice(0, 20).map(c => `行 ${c.line}: ${c.text}`).join("；"))
    syntax = mergeActivationResults([{
      success: true, inactive: [],
      messages: (checks ?? []).map(c => ({ objDescr: "", type: c.severity, line: c.line, href: "", forceSupported: false, shortText: c.text })),
    }], ["激活前语法检查"])
  } catch (err) {
    return failedStage("激活前语法检查", `无法确认待激活源码或语法结果，未执行激活：${sanitizeErrMsg(err)}`)
  }
  const expected = sourceHash(source)
  const result = mergeActivationResults([syntax, await activate()], [])
  if (!result.success) return { ...result, sourceHash: expected }
  try {
    const active = await client.getObjectSource(uri, { version: "active" })
    if (sourceHash(active) !== expected) {
      return { ...mergeActivationResults([result, failedStage("激活版本核验", "active 源码与激活前核对的源码不一致，本次修改未确认生效。")], []), verification: "mismatch", sourceHash: expected }
    }
    return { ...result, verification: "matched", sourceHash: expected }
  } catch (err) {
    return { ...mergeActivationResults([result, failedStage("激活版本核验", `激活请求已返回，但无法读取 active 源码，结果未确认：${sanitizeErrMsg(err)}`)], []), verification: "unavailable", sourceHash: expected }
  }
}
