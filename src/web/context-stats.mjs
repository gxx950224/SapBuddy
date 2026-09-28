/** Runtime prompt/tool definitions, not the full contents of every installed skill. */
export class ContextStats {
  cache = null
  get(session, estimateMessage, now = Date.now()) {
    const messages = session?.agent?.state?.messages || []
    const prompt = session?.systemPrompt || ""
    const names = session?.getActiveToolNames?.() || []
    const signature = `${messages.length}:${session?.model?.contextWindow}:${names.join(",")}`
    const old = this.cache
    if (old && old.session === session && old.prompt === prompt && old.signature === signature && now - old.ts < 3000) return old.body
    const estimateText = text => text ? estimateMessage({ role: "user", content: [{ type: "text", text }] }) : 0
    const definitions = (session?.getAllTools?.() || []).filter(t => names.includes(t.name))
    const schemaTokens = group => estimateText(group.length ? JSON.stringify(group.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }))) : "")
    const tools = schemaTokens(definitions.filter(t => !t.name.startsWith("mcp_")))
    const mcp = schemaTokens(definitions.filter(t => t.name.startsWith("mcp_")))
    const systemPrompt = estimateText(prompt)
    // Restore the detailed UI without counting unloaded skill bodies or reading files per hover.
    let remainder = prompt
    const parts = { agents: 0, systemMd: 0, memory: 0, skills: 0 }
    const take = (key, text) => {
      if (!text || !remainder.includes(text)) return
      parts[key] += estimateText(text)
      remainder = remainder.replace(text, "")
    }
    for (const match of prompt.matchAll(/<project_instructions path="[^"]*[\\/]AGENTS\.md">[\s\S]*?<\/project_instructions>/gi)) take("agents", match[0])
    const loader = session?.resourceLoader
    const sources = loader?.getAppendSystemPromptSources?.() || []
    const appended = loader?.getAppendSystemPrompt?.() || []
    sources.forEach((source, i) => {
      if (/[\\/]SYSTEM\.md$/i.test(source.path)) take("systemMd", appended[i])
      if (/[\\/]Memory\.md$/i.test(source.path)) take("memory", appended[i])
    })
    const skillSection = remainder.match(/<available_skills>[\s\S]*?<\/available_skills>/)
    if (skillSection) take("skills", skillSection[0])
    const builtinNames = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"])
    const extensions = schemaTokens(definitions.filter(t => !t.name.startsWith("mcp_") && !builtinNames.has(t.name)))
    const piAgent = Math.max(0, systemPrompt - Object.values(parts).reduce((sum, n) => sum + n, 0)) + tools - extensions
    const conversation = messages.reduce((sum, m) => sum + estimateMessage(m), 0)
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
    let reported = false, reportedCost = false
    for (const m of messages) {
      if (!m.usage) continue
      reported = true
      for (const key of ["input", "output", "cacheRead", "cacheWrite"]) usage[key] += Number(m.usage[key]) || 0
      if (Object.values(session?.model?.cost || {}).some(value => Number(value) > 0) && typeof m.usage.cost?.total === "number") { usage.cost += m.usage.cost.total; reportedCost = true }
    }
    const max = session?.model?.contextWindow || 0
    const total = systemPrompt + tools + mcp + conversation
    const body = { success: true, data: {
      source: "estimate", ready: !!session, systemPrompt, tools, mcp, conversation, total, max,
      ...parts, piAgent, extensions, autoCompactPct: 80,
      pct: max ? Math.round(total / max * 100) : 0, remaining: Math.max(0, max - total),
      usage: reported ? { ...usage, cost: reportedCost ? usage.cost : null } : null,
      messageCount: messages.length, activeTools: definitions.length,
    } }
    this.cache = { session, prompt, signature, ts: now, body }
    return body
  }
}
