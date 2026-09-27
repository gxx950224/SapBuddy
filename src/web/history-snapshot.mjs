// Called synchronously alongside the SSE sequence so history and live output share a boundary.
export function historySnapshot(entries, liveAssistant, limit = 20, fromTurn = null) {
  const messages = entries.map(entry => entry.message).filter(m => ["user", "assistant", "toolResult"].includes(m?.role))
  const turns = messages.flatMap((m, index) => m.role === "user" &&
    (typeof m.content === "string" ? m.content.length : m.content?.some(c => c.text || c.type === "image")) ? [index] : [])
  const userOffset = fromTurn == null ? Math.max(0, turns.length - limit) : Math.max(0, Math.min(fromTurn, Math.max(0, turns.length - 1)))
  const recent = messages.slice(userOffset ? turns[userOffset] : 0)
  if (liveAssistant) {
    const index = recent.findIndex(m => m.role === "assistant" && m.timestamp === liveAssistant.timestamp)
    if (index >= 0) recent[index] = liveAssistant
    else recent.push(liveAssistant)
  }
  return { messages: recent, userOffset, before: userOffset || null }
}
