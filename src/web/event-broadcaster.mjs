/** Coalesce snapshots before serialization; terminal/tool events retain exact ordering. */
export class EventBroadcaster {
  pending = null
  timer = null
  constructor(send, { intervalMs = 40 } = {}) { this.send = send; this.intervalMs = intervalMs }
  publish(payload) {
    if (payload.event?.type !== "message_update") { this.flush(); this.send(payload); return }
    const previous = this.pending
    if (previous && (previous.sessionFile !== payload.sessionFile || previous.event.message?.timestamp !== payload.event.message?.timestamp)) this.flush()
    this.pending = payload
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.intervalMs)
  }
  flush() {
    clearTimeout(this.timer)
    this.timer = null
    const pending = this.pending
    this.pending = null
    if (pending) this.send(pending)
  }
  dispose() { clearTimeout(this.timer); this.timer = null; this.pending = null }
}

export function sendSse(clients, data, maxBufferedBytes = 4 * 1024 * 1024) {
  for (const res of clients) {
    if (res.destroyed || res.writableEnded || res.writableLength > maxBufferedBytes) {
      clients.delete(res)
      if (!res.destroyed) res.destroy() // EventSource reconnects using the history snapshot.
      continue
    }
    try { res.write(data) } catch { clients.delete(res); res.destroy() }
  }
}
