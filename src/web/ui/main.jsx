import React, { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import "./styles.css"
import { ThinkingTrace, TraceIcon, toolPresentation } from "./ProcessTrace.jsx"

const App = window.SapBuddy
const listeners = new Set()
const bodyRefs = new Map()
let sequence = 0
let messageSequence = 0
let toolOwners = new Map()
let messageItems = new Map()
let activeAssistantId = null
let activeMessageKey = null
let pendingPublishFrame = 0
let selectedApprovalId = null
let historyMore = null
let waiting = null
let streaming = false
let compressing = false
let stopping = false
let historyStatus = ""
let historyRetry = null
let snapshot = { items: [], historyMore, waiting, streaming, compressing, revision: 0 }

function publish() {
  if (pendingPublishFrame) {
    cancelAnimationFrame(pendingPublishFrame)
    pendingPublishFrame = 0
  }
  snapshot = { items: messageItems, historyMore, historyStatus, historyRetry, waiting, streaming, compressing, stopping, revision: snapshot.revision + 1 }
  for (const listener of listeners) listener()
}

function publishNextFrame() {
  if (pendingPublishFrame) return
  pendingPublishFrame = requestAnimationFrame(() => {
    pendingPublishFrame = 0
    snapshot = { items: messageItems, historyMore, historyStatus, historyRetry, waiting, streaming, compressing, stopping, revision: snapshot.revision + 1 }
    for (const listener of listeners) listener()
  })
}

function updateItem(id, updater) {
  const old = messageItems.get(id)
  if (!old) return
  const next = updater(old)
  if (next === old) return
  const updated = new Map(messageItems)
  updated.set(id, next)
  messageItems = updated
  publish()
}

function newId(prefix) {
  sequence += 1
  return `${prefix}-${Date.now()}-${sequence}`
}

function normalizeParts(content) {
  if (typeof content === "string") return [{ type: "text", text: content }]
  return Array.isArray(content) ? content : []
}

function textFromParts(parts) {
  return parts.filter((p) => p?.type === "text").map((p) => p.text || "").join("")
}

function sameContent(left, right) {
  if (left.length !== right.length) return false
  return left.every((part, index) => {
    const next = right[index]
    if (part === next) return true
    if (!part || !next || part.type !== next.type) return false
    if (part.type === "text") return part.text === next.text
    if (part.type === "thinking") return part.thinking === next.thinking
    if (part.type === "toolCall") {
      return part.id === next.id && part.name === next.name && JSON.stringify(part.arguments) === JSON.stringify(next.arguments)
    }
    if (part.type === "image") return part.mimeType === next.mimeType && part.data === next.data
    return false
  })
}

function simplifyAttachmentText(text) {
  if (!text || !text.includes("【用户附带的文件")) return String(text || "")
  const idx = text.indexOf("【用户附带的文件")
  const prefix = text.slice(0, idx).trimEnd()
  const names = text.slice(idx).split("\n")
    .filter((line) => line.trim().startsWith("- "))
    .map((line) => line.replace(/^- /, "").split(" → ")[0])
    .filter(Boolean)
  return [prefix, ...names].filter(Boolean).join("\n")
}

function parseAttachments(text) {
  if (!text || !text.includes("【用户附带的文件")) return []
  return text.slice(text.indexOf("【用户附带的文件")).split("\n").flatMap((line) => {
    const entry = line.trim().replace(/^- /, "")
    const [name, ...location] = entry.split(" → ")
    return line.trim().startsWith("- ") && name && location.length ? [{ name: name.trim(), path: location.join(" → ").trim() }] : []
  })
}

function visibleUser(message) {
  const parts = normalizeParts(message.content)
  return !!textFromParts(parts).trim() || parts.some((p) => p?.type === "image" && p.data && p.mimeType)
}

function normalizeHistory(messages, userOffset = 0, live = false) {
  const result = []
  const byId = new Map()
  const owners = new Map()
  let visibleUserIndex = userOffset
  let currentUserId = null
  let currentAssistant = null
  let previousAssistant = false

  function push(item) {
    result.push(item)
    byId.set(item.id, item)
    return item
  }

  for (const raw of messages || []) {
    if (raw?.role === "user") {
      previousAssistant = false
      if (!visibleUser(raw)) continue
      for (const entry of result) if (entry.kind === "approval" && entry.approvalType === "question") entry.status = "complete"
      const parts = normalizeParts(raw.content)
      const text = textFromParts(parts)
      const item = push({
        id: `user:${raw.id || raw.timestamp || "unknown"}:${visibleUserIndex}`,
        kind: "user", role: "user", userIndex: visibleUserIndex++, timestamp: raw.timestamp,
        text: simplifyAttachmentText(text), images: parts.filter((p) => p.type === "image" && p.data && p.mimeType),
        attachments: parseAttachments(text),
      })
      currentUserId = item.id
      currentAssistant = null
      continue
    }

    if (raw?.role === "assistant") {
      const content = normalizeParts(raw.content)
      if (!content.length) continue
      let item = currentAssistant
      if (!previousAssistant || !item) {
        item = push({
          id: `assistant:${currentUserId || raw.id || raw.timestamp || newId("history")}`,
          kind: "assistant", role: "assistant", blocks: [], tools: {}, timestamp: raw.timestamp,
          usage: raw.usage || null, status: "complete", finalized: true,
        })
        currentAssistant = item
      }
      previousAssistant = true
      const key = String(raw.id || raw.timestamp || `history-${result.length}`)
      const block = { id: key, content }
      const blocks = item.blocks.filter((entry) => entry.id !== key).concat(block)
      const tools = { ...item.tools }
      for (const part of content) {
        if (part?.type === "toolCall" && part.id) {
          owners.set(String(part.id), item.id)
          if (!tools[part.id]) tools[part.id] = { id: String(part.id), name: part.name, args: part.arguments, status: "running", startedAt: raw.timestamp || null }
        }
      }
      const next = { ...item, blocks, tools, timestamp: raw.timestamp || item.timestamp, usage: raw.usage || item.usage,
        stopReason: raw.stopReason || item.stopReason, errorMessage: raw.errorMessage || item.errorMessage }
      const index = result.findIndex((entry) => entry.id === item.id)
      result[index] = next
      byId.set(next.id, next)
      currentAssistant = next
      continue
    }

    if (raw?.role === "toolResult" && raw.toolCallId) {
      const owner = owners.get(String(raw.toolCallId))
      if (!owner) continue
      const item = byId.get(owner)
      if (!item) continue
      const tools = { ...item.tools, [raw.toolCallId]: {
        ...(item.tools[raw.toolCallId] || { id: String(raw.toolCallId) }),
        status: raw.isError ? "failed" : "complete", result: { content: raw.content, details: raw.details }, isError: !!raw.isError,
        duration: raw.timestamp && item.tools[raw.toolCallId]?.startedAt ? Math.max(0, raw.timestamp - item.tools[raw.toolCallId].startedAt) : null,
      } }
      const next = { ...item, tools }
      const index = result.findIndex((entry) => entry.id === item.id)
      result[index] = next
      byId.set(next.id, next)
      if (currentAssistant?.id === owner) currentAssistant = next
      const tool = tools[raw.toolCallId]
      if (!raw.isError && tool?.name === "ask_user" && tool.args?.question) {
        const id = `approval:${raw.toolCallId}`
        if (!byId.has(id)) push({ id, kind: "approval", approvalType: "question", question: tool.args.question,
          options: tool.args.options || [], allowCustom: tool.args.allowCustom !== false || !tool.args.options?.length, status: "pending" })
      }
    }
  }

  if (live) {
    const lastUser = result.findLastIndex(item => item.kind === "user")
    const activeReply = result.slice(lastUser + 1).findLast(item => item.kind === "assistant")
    if (activeReply) { activeReply.status = "running"; activeReply.finalized = false }
  }
  {
    for (const item of result) {
      if (item.kind !== "assistant" || item.status === "running") continue
      const tools = Object.fromEntries(Object.entries(item.tools).map(([id, tool]) => [id,
        tool.status === "running" ? { ...tool, status: "interrupted" } : tool]))
      item.tools = tools
    }
  }
  return { items: result, owners }
}

function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) }
function getSnapshot() { return snapshot }

const view = {
  subscribe,
  getSnapshot,
  registerBody(id, element) { if (element) bodyRefs.set(id, element); else bodyRefs.delete(id) },
  replaceHistory(messages, { prepend = false, userOffset = 0, live = false } = {}) {
    const normalized = normalizeHistory(messages, userOffset, live)
    if (prepend) {
      const merged = [...normalized.items, ...messageItems.values()].filter((item, index, all) =>
        all.findIndex((entry) => entry.id === item.id) === index)
      messageItems = new Map(merged.map((item) => [item.id, item]))
      for (const [id, owner] of normalized.owners) toolOwners.set(id, owner)
    } else {
      messageItems = new Map(normalized.items.map((item) => [item.id, item]))
      toolOwners = normalized.owners
      activeAssistantId = live ? normalized.items.find(item => item.kind === "assistant" && item.status === "running")?.id || null : null
      activeMessageKey = null
      bodyRefs.clear()
    }
    flushSync(publish)
  },
  appendUser(text, images = [], attachments = [], timestamp = Date.now()) {
    const item = { id: newId("user"), kind: "user", role: "user", userIndex: null, text: simplifyAttachmentText(text),
      images: images || [], attachments: attachments || [], timestamp }
    const next = new Map(messageItems)
    next.set(item.id, item)
    messageItems = next
    activeAssistantId = null
    activeMessageKey = null
    publish()
  },
  addAssistantMessage(message, start = false) {
    const key = String(message?.id || message?.timestamp || (start ? newId("message") : activeMessageKey || newId("message")))
    if (start || !activeMessageKey) activeMessageKey = key
    else if (message?.id || message?.timestamp) activeMessageKey = key
    if (!activeAssistantId || !messageItems.has(activeAssistantId)) {
      const item = { id: newId("assistant"), kind: "assistant", role: "assistant", blocks: [], tools: {},
        timestamp: message?.timestamp || Date.now(), status: streaming ? "running" : "complete", finalized: false }
      const next = new Map(messageItems)
      next.set(item.id, item)
      messageItems = next
      activeAssistantId = item.id
      flushSync(publish)
    }
    const item = messageItems.get(activeAssistantId)
    const body = bodyRefs.get(activeAssistantId)
    if (body) return body
    return item ? document.querySelector(`.msg.agent[data-item-id="${CSS.escape(item.id)}"] .body`) : null
  },
  updateAssistantContent(body, content) {
    const id = body?.closest?.(".msg.agent")?.dataset.itemId || activeAssistantId
    if (!id || !activeMessageKey) return
    const item = messageItems.get(id)
    if (!item) return
    const block = { id: activeMessageKey, content: normalizeParts(content) }
    const old = item.blocks.find((entry) => entry.id === activeMessageKey)
    if (old && sameContent(old.content, block.content)) return
    const blocks = old ? item.blocks.map((entry) => entry.id === activeMessageKey ? block : entry) : [...item.blocks, block]
    const tools = { ...item.tools }
    for (const part of block.content) {
      if (part?.type === "toolCall" && part.id) {
        const toolId = String(part.id)
        toolOwners.set(toolId, id)
        tools[toolId] = { ...(tools[toolId] || {}), id: toolId, name: part.name, args: part.arguments,
          status: tools[toolId]?.status || "running" }
      }
    }
    const updated = new Map(messageItems)
    updated.set(id, { ...item, blocks, tools, timestamp: item.timestamp || Date.now(), status: streaming ? "running" : item.status })
    messageItems = updated
    publishNextFrame()
  },
  startTool(id, name, args) {
    const ownerId = activeAssistantId
    if (!ownerId) return
    const toolId = String(id || newId("tool"))
    toolOwners.set(toolId, ownerId)
    updateItem(ownerId, (item) => ({ ...item, status: "running", tools: { ...item.tools, [toolId]: {
      ...(item.tools[toolId] || {}), id: toolId, name: name || item.tools[toolId]?.name || "tool", args: args ?? item.tools[toolId]?.args,
      status: "running", startedAt: Date.now(), result: null, isError: false,
    } } }))
    return toolId
  },
  finishTool(id, result, isError, duration) {
    const toolId = String(id || "")
    const ownerId = toolOwners.get(toolId) || activeAssistantId
    if (ownerId) updateItem(ownerId, (item) => {
      const previous = item.tools[toolId] || { id: toolId, name: "tool", args: {} }
      return { ...item, tools: { ...item.tools, [toolId]: {
        ...previous, status: isError ? "failed" : "complete", result, isError: !!isError,
        duration: duration ?? (previous.startedAt ? Math.max(0, Date.now() - previous.startedAt) : null),
      } } }
    })
    const approval = [...messageItems.values()].find((item) => item.kind === "approval" && item.approvalType === "write" &&
      item.status === "executing" && item.toolCallId === toolId)
    if (approval) updateItem(approval.id, (old) => ({ ...old, status: isError ? "failed" : "complete" }))
    const tool = messageItems.get(ownerId)?.tools?.[toolId]
    if (!isError && tool?.name === "ask_user" && tool.args?.question && !messageItems.has(`approval:${toolId}`)) {
      view.addApproval({ id: toolId, ...tool.args, allowCustom: tool.args.allowCustom !== false || !tool.args.options?.length })
    }
    toolOwners.delete(toolId)
  },
  interruptTools() {
    const next = new Map(messageItems)
    let changed = false
    const interrupted = new Set()
    for (const [id, item] of next) {
      if (item.kind !== "assistant") continue
      let dirty = false
      const tools = { ...item.tools }
      for (const [toolId, tool] of Object.entries(tools)) {
        if (tool.status !== "running") continue
        tools[toolId] = { ...tool, status: "interrupted" }
        interrupted.add(toolId)
        dirty = changed = true
      }
      if (dirty) next.set(id, { ...item, tools })
    }
    for (const [id, item] of next) {
      if (item.kind !== "approval" || item.approvalType !== "write" || item.status !== "executing") continue
      next.set(id, { ...item, status: "interrupted" })
      changed = true
    }
    for (const toolId of interrupted) toolOwners.delete(toolId)
    if (changed) { messageItems = next; publish() }
  },
  staleUnexecutedApprovals(sessionFile = App.state.currentPath) {
    for (const item of messageItems.values()) {
      if (item.kind !== "approval" || item.approvalType !== "write" || item.status !== "submitted") continue
      if (item.sessionFile && sessionFile && item.sessionFile !== sessionFile) continue
      updateItem(item.id, (old) => ({ ...old, status: "stale" }))
    }
  },
  finishAssistant(usage = null, elapsed = null) {
    if (activeAssistantId) updateItem(activeAssistantId, (item) => ({ ...item, status: "complete", finalized: true,
      usage: usage || item.usage, elapsed: elapsed ?? item.elapsed, timestamp: item.timestamp || Date.now() }))
  },
  removeActiveAssistantIfEmpty() {
    const item = messageItems.get(activeAssistantId)
    if (!item || item.kind !== "assistant") return
    const hasContent = item.blocks.some((block) => block.content.some((part) =>
      (part?.type === "text" && part.text) || (part?.type === "thinking" && part.thinking) ||
      (part?.type === "toolCall" && part.id) || (part?.type === "image" && part.data))) || Object.keys(item.tools || {}).length > 0
    if (hasContent) return
    const next = new Map(messageItems)
    next.delete(activeAssistantId)
    messageItems = next
    bodyRefs.delete(activeAssistantId)
    activeAssistantId = null
    activeMessageKey = null
    publish()
  },
  setStreaming(value) {
    streaming = !!value
    if (!streaming) waiting = null
    if (activeAssistantId) updateItem(activeAssistantId, (item) => ({ ...item, status: streaming ? "running" : item.status }))
    if (!streaming) {
      const deferred = [...messageItems.values()].filter((item) => item.kind === "approval" && item.deferred)
      if (deferred.length) {
        const next = new Map(messageItems)
        for (const item of deferred) {
          next.delete(item.id)
          next.set(item.id, { ...item, deferred: false })
        }
        messageItems = next
      }
    }
    publish()
  },
  setCompressing(value) { compressing = !!value; publish() },
  setWaiting(text, retrying = false) { waiting = { text: text || (retrying ? "正在重试…" : "等待模型响应…"), startedAt: Date.now(), retrying }; publish() },
  hideWaiting() { if (waiting) { waiting = null; publish() } },
  addSystemNote(text, kind = "note") {
    const item = { id: newId("notice"), kind: "system", tone: kind, text: String(text || "") }
    const next = new Map(messageItems)
    next.set(item.id, item)
    messageItems = next
    publish()
    return item.id
  },
  addApproval(payload, approvalType = "question") {
    const id = String(payload.id || payload.toolCallId || newId("approval"))
    const item = { id: `approval:${id}`, kind: "approval", approvalType, sessionFile: payload.sessionFile || App.state.currentPath || "",
      question: payload.question || "需要你确认下一步", options: Array.isArray(payload.options) ? payload.options : [],
      allowCustom: payload.allowCustom === true, toolName: payload.toolName || "", input: payload.input || {}, preflight: payload.preflight === true,
      requestToolCallId: payload.toolCallId ? String(payload.toolCallId) : null,
      status: "pending", deferred: approvalType === "write" && streaming, createdAt: payload.ts || Date.now() }
    const next = new Map(messageItems)
    next.set(item.id, item)
    messageItems = next
    publish()
  },
  updateApproval(id, status, toolCallId = null) {
    const itemId = String(id).startsWith("approval:") ? String(id) : `approval:${id}`
    updateItem(itemId, (item) => ({ ...item, status, toolCallId: toolCallId || item.toolCallId }))
  },
  prepareApproval(id) {
    const itemId = String(id).startsWith("approval:") ? String(id) : `approval:${id}`
    selectedApprovalId = itemId
    updateItem(itemId, (item) => ["pending", "failed"].includes(item.status) ? { ...item, status: "draft", submissionFailed: false } : item)
  },
  submitApproval(text, sessionFile) {
    const command = String(text || "").trim()
    const isConfirm = /^(确认|同意|批准|执行|可以)[。！!]?$/i.test(command)
    const isReject = /^(拒绝|不要|取消)[。！!]?$/i.test(command)
    const selectedId = selectedApprovalId
    selectedApprovalId = null
    const eligible = [...messageItems.values()].filter((item) => item.kind === "approval" &&
      (item.status === "pending" || item.status === "draft") &&
      (!item.sessionFile || !sessionFile || item.sessionFile === sessionFile))
    const selected = selectedId ? eligible.find((item) => item.id === selectedId) : null
    const fallback = isConfirm || isReject
      ? eligible.filter((item) => item.approvalType === "write").at(-1)
      : eligible.filter((item) => item.approvalType === "question").at(-1)
    const target = selected || fallback
    if (!target) return []
    if (target.approvalType === "write") {
      if (!isConfirm && !isReject) return []
      updateItem(target.id, (item) => ({ ...item, status: isConfirm ? "submitted" : "rejected" }))
    } else {
      if (!command) return []
      updateItem(target.id, (item) => ({ ...item, status: "submitted" }))
    }
    return [target.id]
  },
  settleApprovalSubmission(ids, success) {
    for (const id of ids || []) updateItem(id, (item) => {
      if (item.status !== "submitted" && item.status !== "rejected") return item
      if (!success) return { ...item, status: "failed", submissionFailed: true }
      return item.approvalType === "question" ? { ...item, status: "complete" } : item
    })
  },
  setHistoryMore(value) { historyMore = value || null; publish() },
  setHistoryStatus(value, retry = null) { historyStatus = value; historyRetry = retry; flushSync(publish) },
  setStopping(value) { stopping = value; publish() },
  remove(id) {
    if (!messageItems.has(id)) return
    const next = new Map(messageItems)
    next.delete(id)
    messageItems = next
    if (activeAssistantId === id) activeAssistantId = null
    publish()
  },
  removeFrom(id) {
    const keys = [...messageItems.keys()]
    const index = keys.indexOf(id)
    if (index < 0) return
    messageItems = new Map(keys.slice(0, index).map((key) => [key, messageItems.get(key)]))
    activeAssistantId = null
    activeMessageKey = null
    publish()
  },
  clear() {
    messageItems = new Map()
    toolOwners = new Map()
    activeAssistantId = null
    activeMessageKey = null
    selectedApprovalId = null
    historyMore = null
    waiting = null
    bodyRefs.clear()
    publish()
  },
  body(id) { return bodyRefs.get(id) || null },
  activeAssistant() { return activeAssistantId ? bodyRefs.get(activeAssistantId) || null : null },
  setActiveAssistant(id) { activeAssistantId = id || null },
  toolStarted(id, name, args, sessionFile = App.state.currentPath) {
    const owner = toolOwners.get(String(id))
    const candidates = [...messageItems.values()].filter((item) => item.kind === "approval" && item.approvalType === "write" &&
      item.status === "submitted" && (item.toolName === name || item.preflight) &&
      (!item.sessionFile || !sessionFile || item.sessionFile === sessionFile))
    const executionArgs = stableJson(sanitizeApprovalInput(args || {}))
    const approval = candidates.find((item) => item.requestToolCallId === String(id)) ||
      candidates.find((item) => stableJson(sanitizeApprovalInput(item.input)) === executionArgs) ||
      (candidates.length === 1 ? candidates[0] : null)
    if (approval) updateItem(approval.id, (old) => ({ ...old, status: "executing", toolCallId: String(id) }))
    return owner
  },
}

App.chatView = view

function useChat() { return useSyncExternalStore(subscribe, getSnapshot, getSnapshot) }

function timeLabel(timestamp) {
  if (!timestamp) return ""
  return App.formatMessageTime ? App.formatMessageTime(timestamp) : new Date(timestamp).toLocaleTimeString()
}

function formatElapsed(ms) {
  const seconds = Math.max(0, ms / 1000)
  return `${seconds < 60 ? seconds.toFixed(1) + " 秒" : Math.floor(seconds / 60) + " 分 " + Math.floor(seconds % 60) + " 秒"}`
}

function toolLabel(status) {
  return ({ queued: "待执行", running: "执行中", complete: "已完成", failed: "失败", interrupted: "已中断" })[status] || "待执行"
}

function safeResultText(result) {
  if (typeof result === "string") return result
  if (Array.isArray(result)) return result.map((entry) => entry?.text || (entry?.type === "image" ? "[图片结果]" : "")).filter(Boolean).join("\n")
  if (result && typeof result === "object") {
    if (Array.isArray(result.content)) return safeResultText(result.content)
    try { return JSON.stringify(result, null, 2) } catch { return String(result) }
  }
  return result == null ? "" : String(result)
}

function recordsFromResult(result) {
  const candidates = [result?.structuredContent, result?.details?.records, result?.records, result?.data]
  for (const value of candidates) {
    if (Array.isArray(value) && value.length && value.slice(0, 200).every((row) => row && typeof row === "object" && !Array.isArray(row))) return value.slice(0, 200)
  }
  return null
}

function RecordsTable({ rows }) {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))].slice(0, 12)
  return <div className="bu-records-scroll"><table className="bu-records-table"><thead><tr>{columns.map((key) => <th key={key}>{key}</th>)}</tr></thead>
    <tbody>{rows.map((row, index) => <tr key={index}>{columns.map((key) => <td key={key}>{typeof row[key] === "object" ? JSON.stringify(row[key]) : String(row[key] ?? "")}</td>)}</tr>)}</tbody>
  </table></div>
}

function ToolChip({ tool }) {
  const [expanded, setExpanded] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (tool.status !== "running") return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [tool.status, tool.startedAt])
  const records = useMemo(() => expanded ? recordsFromResult(tool.result) : null, [expanded, tool.result])
  const resultText = useMemo(() => expanded ? safeResultText(tool.result) : "", [expanded, tool.result])
  const elapsed = tool.duration != null ? tool.duration : tool.status === "running" && tool.startedAt ? now - tool.startedAt : null
  const duration = elapsed != null ? formatElapsed(elapsed) : ""
  const presentation = toolPresentation(tool)
  return <details className={`bu-tool ${tool.status}`} open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary aria-label={`${tool.name}，${toolLabel(tool.status)}`} title={`${tool.name} · ${toolLabel(tool.status)}${duration ? ` · ${duration}` : ""}`}>
      <span className="bui-row-glyph"><TraceIcon kind={presentation.icon}/><TraceIcon kind="chevron" className="bui-row-chevron"/></span>
      <span className="bu-tool-name">{presentation.label}</span>
    </summary>
    {expanded && <div className="bu-tool-detail">
      <div className="bu-tool-status">{toolLabel(tool.status)}{duration ? ` · ${duration}` : ""}</div>
      {tool.isError && <p className="bu-tool-error-summary">{(resultText || "工具执行失败").split("\n").find(line => line.trim())?.slice(0, 180)}</p>}
      {tool.isError && <button type="button" className="bui-more" onClick={() => setShowLog(!showLog)}>{showLog ? "收起完整日志" : "查看完整输入与错误"}</button>}
      {(!tool.isError || showLog) && <><div className="bu-tool-detail-section"><div className="bu-detail-label">输入</div><pre>{JSON.stringify(tool.args || {}, null, 2)}</pre></div>
      {expanded && tool.result != null && <div className="bu-tool-detail-section"><div className="bu-detail-label">{tool.isError ? "错误" : "结果"}</div>
        {records ? <RecordsTable rows={records} /> : <pre className="bu-tool-result">{resultText || (tool.isError ? "工具执行失败" : "执行完成")}</pre>}
      </div>}</>}
    </div>}
  </details>
}

function ToolDiffs({ tools }) {
  const diffs = tools.flatMap(tool => {
    const diff = tool.result?.details?.diff
    const file = tool.args?.path || tool.args?.file_path
    if (tool.status !== "complete" || !file || typeof diff !== "string") return []
    const lines = diff.split("\n")
    return [{ id: tool.id, file, diff, add: lines.filter(line => /^\+(?!\+)/.test(line)).length, del: lines.filter(line => /^-(?!-)/.test(line)).length }]
  })
  if (!diffs.length) return null
  return <div className="bui-diffs">{diffs.map(diff => <details className="bui-file-diff" key={diff.id}><summary><span>{diff.file.split(/[\\/]/).at(-1)}</span><b>+{diff.add}</b>{diff.del > 0 && <em>−{diff.del}</em>}</summary><pre>{diff.diff}</pre></details>)}</div>
}

function PixelLoader() {
  return <span className="bu-loading-mark" aria-hidden="true">{Array.from({ length: 9 }, (_, i) => <i key={i}/>)}</span>
}

function CodeBlock({ code, language, streaming }) {
  const isDiff = /^diff(?:-|$)/i.test(language) || /^(?:\+\+\+|---|@@)/m.test(code)
  const [mode, setMode] = useState(isDiff ? "diff" : "code")
  useEffect(() => { if (isDiff) setMode("diff") }, [isDiff])
  const lang = language.toLowerCase().replace(/^sap-/, "")
  const highlighted = useMemo(() => {
    if (streaming || !window.hljs || !lang || !window.hljs.getLanguage?.(lang)) return code.split("\n").map(App.escapeHtml)
    return code.split("\n").map((line) => {
      try { return window.hljs.highlight(line || " ", { language: lang }).value || "&nbsp;" }
      catch { return App.escapeHtml(line) }
    })
  }, [code, lang, streaming])
  const shown = useMemo(() => {
    if (!isDiff || mode === "diff") return code.split("\n").map((line) => ({ line, tone: isDiff ? line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : "" : "" }))
    return code.split("\n").filter((line) => !line.startsWith("-") && !line.startsWith("---") && !line.startsWith("@@")).map((line) => ({ line: line.startsWith("+") && !line.startsWith("+++") ? line.slice(1) : line.startsWith("+++") ? "" : line.replace(/^ /, ""), tone: "" }))
  }, [code, isDiff, mode])
  const copy = () => App.copyText(code)
  return <div className="code-block-wrapper bu-code">
    <div className="bu-code-header"><span className="code-lang">{language || "代码"}</span><span className="bu-code-spacer" />
      {isDiff && <div className="bu-code-tabs"><button type="button" className={mode === "code" ? "active" : ""} onClick={() => setMode("code")}>代码</button><button type="button" className={mode === "diff" ? "active" : ""} onClick={() => setMode("diff")}>差异</button></div>}
      <button type="button" className="code-copy-btn" onClick={copy}>复制</button>
    </div>
    <div className="bu-code-lines" role="group" aria-label={`${language || "代码"}代码块`}>
      {shown.map((entry, index) => <div className={`bu-code-line ${entry.tone}`} key={index}><span className="bu-line-number">{index + 1}</span>
        <code className={`language-${lang}`} dangerouslySetInnerHTML={{ __html: mode === "code" && !isDiff ? highlighted[index] ?? "" : App.escapeHtml(entry.line) || "&nbsp;" }} />
      </div>)}
    </div>
  </div>
}

function markdownBlocks(text) {
  const output = []
  const fence = /```([^\n`]*)\n([\s\S]*?)```/g
  let cursor = 0
  let match
  while ((match = fence.exec(text))) {
    if (match.index > cursor) output.push({ kind: "markdown", text: text.slice(cursor, match.index) })
    output.push({ kind: "code", language: match[1].trim(), text: match[2].replace(/\n$/, ""), complete: true })
    cursor = fence.lastIndex
  }
  const tail = text.slice(cursor)
  const lastOpen = tail.lastIndexOf("```")
  const closes = (tail.match(/```/g) || []).length
  if (lastOpen >= 0 && closes % 2 === 1) {
    if (lastOpen > 0) output.push({ kind: "markdown", text: tail.slice(0, lastOpen) })
    const raw = tail.slice(lastOpen + 3)
    const newline = raw.indexOf("\n")
    output.push({ kind: "code", language: newline >= 0 ? raw.slice(0, newline).trim() : "", text: newline >= 0 ? raw.slice(newline + 1) : "", complete: false })
  } else if (tail) output.push({ kind: "markdown", text: tail })
  return output
}

// Preserve unchanged Markdown DOM while later pieces stream, including selections.
const MarkdownPiece = memo(function MarkdownPiece({ text, streaming }) {
  const html = useMemo(() => App.renderMarkdown(text, { streaming }), [text, streaming])
  return <span className="bu-markdown-piece" dangerouslySetInnerHTML={{ __html: html }} />
})

const Markdown = memo(function Markdown({ text, streaming }) {
  const host = useRef(null)
  const pieces = useMemo(() => markdownBlocks(text || ""), [text])
  useEffect(() => {
    if (streaming || !host.current) return
    App.highlightCodeBlocks?.(host.current)
    App.renderMermaid?.(host.current)
  }, [streaming, text])
  return <div className={`reply-text md bu-streaming-text${streaming ? " is-streaming" : ""}`} ref={host}>
    {pieces.map((piece, index) => piece.kind === "code"
      ? <CodeBlock key={`code-${index}`} code={piece.text} language={piece.language} streaming={streaming && !piece.complete} />
      : <MarkdownPiece key={`md-${index}`} text={piece.text} streaming={streaming} />)}
  </div>
})

function renderPart(part, item, streaming, key) {
  if (part?.type === "text" && part.text) return <Markdown key={key} text={part.text} streaming={streaming} />
  if (part?.type === "toolCall" && part.id) {
    const tool = item.tools?.[part.id] || { id: part.id, name: part.name, args: part.arguments, status: "running" }
    return <ToolChip key={key} tool={tool} />
  }
  if (part?.type === "image" && part.data && part.mimeType) return <img className="msg-img" key={key} alt="图片" src={`data:${part.mimeType};base64,${part.data}`} />
  return null
}

function ActionIcon({ action }) {
  const paths = {
    copy: <><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></>,
    edit: <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/>,
    delete: <><path d="M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3"/></>,
    regenerate: <><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></>,
  }
  return <svg className="msg-action-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[action]}</svg>
}

function MessageActions({ item }) {
  const actions = item.kind === "user" ? ["copy", "edit", "delete"] : ["copy", "regenerate", "delete"]
  const labels = { copy: "复制", edit: "编辑并重发", delete: "删除", regenerate: "重新生成" }
  return <div className="msg-actions">{actions.map((action) => <button type="button" className="msg-action-btn" data-action={action} aria-label={labels[action]} title={labels[action]} key={action}>
    <ActionIcon action={action}/>
  </button>)}</div>
}

const UserMessage = memo(function UserMessage({ item }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.text || "")
  const textArea = useRef(null)
  useEffect(() => { if (editing) { textArea.current?.focus(); textArea.current?.select() } }, [editing])
  useEffect(() => {
    const onEdit = (event) => { if (event.detail?.id === item.id) { setDraft(item.text || ""); setEditing(true) } }
    window.addEventListener("sapbuddy:edit-message", onEdit)
    return () => window.removeEventListener("sapbuddy:edit-message", onEdit)
  }, [item.id, item.text])
  return <div className="msg user" data-item-id={item.id} data-user-index={item.userIndex ?? undefined} ref={(element) => { if (element) element._attachments = item.attachments || [] }}>
    <div className="msg-content"><div className="meta">你</div>
      {editing ? <div className="msg-edit-wrap">
        {item.images?.length > 0 && <div className="msg-edit-images">{item.images.map((image, index) => <img key={index} className="msg-edit-img" alt="图片预览" src={`data:${image.mimeType};base64,${image.data}`} />)}</div>}
        {item.attachments?.length > 0 && <div className="msg-edit-attachments">{item.attachments.map((attachment, index) => <div className="msg-edit-attachment" key={index}>{attachment.name}</div>)}</div>}
        <textarea ref={textArea} className="msg-edit-textarea" rows={3} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); setEditing(false) }
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); App.submitEditedMessage?.(item.id, draft) }
        }} />
        <div className="msg-edit-actions"><button type="button" className="btn-sm btn-primary" onClick={() => App.submitEditedMessage?.(item.id, draft)}>发送</button><button type="button" className="btn-sm" onClick={() => setEditing(false)}>取消</button></div>
      </div> : <div className="body">{item.text}{(item.images || []).map((image, index) => <img className="msg-img" alt="图片" key={index} src={`data:${image.mimeType};base64,${image.data}`} />)}</div>}
      <div className="msg-footer"><span className="msg-time">{timeLabel(item.timestamp)}</span><MessageActions item={item} /></div>
    </div>
  </div>
})

function ArtifactCards({ tools }) {
  const paths = [...new Set(tools.filter(tool => ["write", "edit"].includes(tool.name) && tool.status === "complete" && !tool.isError).map(tool => {
    const file = String(tool.args?.path || tool.args?.file_path || "").replace(/\\/g, "/")
    const marker = ".sapbuddy/output/"
    const index = file.toLowerCase().indexOf(marker)
    if (index < 0) return null
    const relative = file.slice(index + marker.length)
    return relative && !relative.split("/").some(part => part === ".." || part === ".") ? relative : null
  }).filter(Boolean))]
  return paths.length > 0 && <div className="artifact-cards">{paths.map(path => <div className="artifact-card" key={path}>
    <span className="artifact-name" title={path}>{path}</span>
    <div className="artifact-actions"><button type="button" onClick={() => App.previewFile?.(path)}>预览</button>
      <a href={`/api/output-files/${encodeURIComponent(path)}?download=1`} download>下载</a>
      <button type="button" onClick={() => App.openFileLocation?.(path)}>打开目录</button></div>
  </div>)}</div>
}

const AssistantMessage = memo(function AssistantMessage({ item, active }) {
  const streamingHere = active && item.status === "running"
  const [manualProcessOpen, setManualProcessOpen] = useState(null)
  const processOpen = manualProcessOpen ?? streamingHere
  const tokens = item.usage?.totalTokens || item.usage?.total_tokens
  const parts = useMemo(() => item.blocks.flatMap(block => block.content.map((part, index) => ({ part, key: `${block.id}:${index}` }))), [item.blocks])
  const toolMap = new Map()
  for (const { part } of parts) {
    if (part.type === "toolCall" && part.id) toolMap.set(String(part.id), item.tools?.[part.id] || { id: part.id, name: part.name, args: part.arguments, status: "running" })
  }
  for (const tool of Object.values(item.tools || {})) toolMap.set(String(tool.id), tool)
  const tools = [...toolMap.values()].filter(tool => tool.name !== "ask_user" || tool.status === "failed")
  const segments = []
  const placedTools = new Set()
  for (const { part, key } of parts) {
    if (part.type === "thinking" && part.thinking) {
      const last = segments.at(-1)
      if (last?.type === "thinking") last.texts.push(part.thinking)
      else segments.push({ type: "thinking", key, texts: [part.thinking] })
    } else if (part.type === "toolCall" && part.id) {
      const tool = toolMap.get(String(part.id))
      if (!tool || (tool.name === "ask_user" && tool.status !== "failed")) continue
      placedTools.add(String(part.id))
      const last = segments.at(-1)
      if (last?.type === "tools") last.tools.push(tool)
      else segments.push({ type: "tools", key, tools: [tool] })
    } else if (part.type !== "thinking" && part.type !== "toolCall") {
      segments.push({ type: "content", key, part })
    }
  }
  const orphanTools = tools.filter(tool => !placedTools.has(String(tool.id)))
  if (orphanTools.length) {
    const last = segments.at(-1)
    if (last?.type === "tools") last.tools.push(...orphanTools)
    else segments.push({ type: "tools", key: `orphan:${orphanTools[0].id}`, tools: orphanTools })
  }
  const elapsedLabel = item.elapsed != null ? formatElapsed(item.elapsed) : ""
  const thoughtCount = segments.filter(segment => segment.type === "thinking").length
  const hasProcess = thoughtCount > 0 || tools.length > 0
  const firstProcessIndex = segments.findIndex(segment => segment.type !== "content")
  const failureCount = tools.filter(tool => tool.isError || tool.status === "failed").length
  const processLabel = thoughtCount && tools.length ? "思考与工具" : thoughtCount ? "思考过程" : "工具调用"
  const processToggle = hasProcess && <button type="button" className="bu-process-toggle" aria-expanded={processOpen} onClick={() => setManualProcessOpen(!processOpen)}>
    <TraceIcon kind="chevron" className="bu-process-chevron"/><span>{processLabel}</span>
    <small>{thoughtCount > 0 && `${thoughtCount} 段思考`}{thoughtCount > 0 && tools.length > 0 && " · "}{tools.length > 0 && `${tools.length} 次调用`}{failureCount > 0 && <span className="bu-tool-error-summary"> · {failureCount} 次失败</span>}</small>
  </button>
  const questionOnly = parts.length > 0 && parts.every(({ part }) => part.type === "toolCall" && part.name === "ask_user" && item.tools?.[part.id]?.status !== "failed") && !tools.length
  return <div className={`msg agent${item.status === "running" ? " typing" : ""}${questionOnly ? " bu-question-only" : ""}`} data-item-id={item.id}>
    <div className="avatar agent-avatar" aria-hidden="true">S</div>
    <div className="msg-content"><div className="meta">SapBuddy</div>
      <div className="body md" ref={(element) => view.registerBody(item.id, element)}>
        {segments.map((segment, index) => <React.Fragment key={segment.key}>
          {index === firstProcessIndex && processToggle}
          {segment.type === "content"
          ? renderPart(segment.part, item, streamingHere, segment.key)
          : !processOpen ? null : segment.type === "thinking"
            ? <ThinkingTrace key={segment.key} texts={segment.texts} tools={[]} working={streamingHere && index === segments.length - 1} autoExpand={streamingHere} compact />
            : <div className="bu-timeline-tools" key={segment.key}>
                {segment.tools.map(tool => <ToolChip key={tool.id} tool={tool} />)}
                <ToolDiffs tools={segment.tools}/>
              </div>}
        </React.Fragment>)}
        <ArtifactCards tools={tools}/>
      </div>
      <div className="msg-footer"><span className="msg-time">{timeLabel(item.timestamp)}</span>{tokens > 0 && <span className="msg-tokens">消耗 {App.formatTokens(tokens)}</span>}{elapsedLabel && <span className="msg-tokens">本轮 {elapsedLabel}</span>}<MessageActions item={item} /></div>
    </div>
  </div>
})

function sanitizeApprovalValue(value, depth = 0, key = "") {
  if (typeof value === "string") {
    const limit = key === "diff" ? 60000 : 600
    return value.length > limit ? `${value.slice(0, limit)}…（已截断）` : value
  }
  if (!value || typeof value !== "object") return value
  if (depth >= 3) return "[嵌套内容已省略]"
  if (Array.isArray(value)) return value.slice(0, 32).map((entry) => sanitizeApprovalValue(entry, depth + 1))
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/(password|secret|token|api.?key|credential|authorization)/i.test(key))
    .slice(0, 16)
    .map(([key, entry]) => [key, sanitizeApprovalValue(entry, depth + 1, key)]))
}

function sanitizeApprovalInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {}
  return sanitizeApprovalValue(input)
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function writeApprovalSummary(toolName, input) {
  const actions = {
    create_object_programmatically: "创建 ABAP 对象",
    replace_string_in_abap_object: "修改 ABAP 源码",
    abap_activate: "激活 ABAP 对象",
    create_test_include: "创建测试 Include",
    update_object_description: "修改对象描述",
    request_write_approval: "申请 SAP 写入授权",
  }
  const target = input.name || input.objectName || input.className || input.fileUri
  const change = input.fullSource ? "整段覆盖源码" : input.oldString != null || input.newString != null ? "局部替换源码" : null
  return [
    ["操作", actions[toolName] || toolName || "写入 SAP"],
    ["对象", target],
    ["改动摘要", input.summary],
    ["对象类型", input.objectType],
    ["变更方式", change],
    ["开发包", input.packageName],
    ["传输请求", input.requestNumber],
    ["目标连接", input.connectionId || "当前启用的 SAP 连接"],
  ].filter(([, value]) => value != null && value !== "")
}

function ApprovalCard({ item }) {
  const [custom, setCustom] = useState("")
  const [selected, setSelected] = useState("")
  const confirmDialog = useRef(null)
  const input = sanitizeApprovalInput(item.input)
  const write = item.approvalType === "write"
  const diff = item.preflight && typeof input.diff === "string" ? input.diff : ""
  const codeWrite = new Set(["create_object_programmatically", "replace_string_in_abap_object", "create_test_include", "abap_activate", "manage_text_elements", "translate_text_pool", "translate_message_class", "translate_screen_text", "fix_ddic_text"]).has(item.toolName)
  const missingCodeDiff = write && codeWrite && !diff
  const summary = write ? writeApprovalSummary(item.toolName, input) : []
  // 问题已提交后回收卡片，避免答案气泡出现后仍残留旧问题。
  if (!write && (item.status === "submitted" || item.status === "complete")) return null
  // 写入确认只在等待决定或发送失败可重试时显示；执行结果由对话和工具记录呈现。
  if (write && !(["pending", "draft"].includes(item.status) || (item.status === "failed" && item.submissionFailed))) return null
  const actionText = write ? (missingCodeDiff ? "缺少可审核的代码差异，暂不能确认执行" : item.preflight ? "尚未调用写工具，等待你审核计划和代码差异" : "写入操作已拦截，尚未执行") : item.question
  const statusText = write
    ? ({ pending: "等待你确认或拒绝", draft: "准备提交确认", submitted: "确认词已发送，等待 Agent 校验", executing: "后端已放行，工具正在执行", complete: "工具执行完成", failed: "工具执行失败", rejected: "已拒绝", interrupted: "请求已中断，写操作未完成", stale: "请求已结束，未执行写操作" })[item.status] || "等待处理"
    : ({ pending: "等待你的回答", draft: "准备提交回答", submitted: "回答已发送", complete: "回答已发送", failed: "发送失败", interrupted: "本轮已中断" })[item.status] || "等待处理"
  function submit(value) {
    if (App.state.streaming) { App.showToast?.("请等待当前回答结束后提交"); return }
    view.prepareApproval(item.id)
    App.sendMessage?.(value, { preserveDraft: true })
  }
  return <section className={`confirm-card bu-approval ${write ? "write-approval" : "question-approval"}`} data-cid={item.id} aria-live="polite">
    <div className="bu-approval-heading">{write && <span className="bu-approval-mark" aria-hidden="true">!</span>}<div><h3>{write ? "需要确认写入计划" : item.question}</h3>{write && <p>{actionText}</p>}</div></div>
    {write && <><dl className="bu-approval-summary">{summary.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{String(value)}</dd></div>)}</dl>
      {diff && <div className="bu-approval-diff"><h4>拟执行的代码差异</h4><CodeBlock code={diff} language="diff" streaming={false}/></div>}
      {Object.keys(input).length > 0 && <details className="bu-approval-detail"><summary>查看工具参数</summary><dl className="bu-approval-fields">{Object.entries(input).filter(([key]) => key !== "diff").map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === "object" ? JSON.stringify(value) : String(value ?? "")}</dd></div>)}</dl></details>}
      <p className="bu-approval-note">确认只会通过正常对话提交，仍由服务端写入门禁和开发客户端检查决定是否执行。</p></>}
    {!write && <div className="bu-approval-options" role="radiogroup" aria-label={item.question}>{item.options.map((option) => <label key={option}><input type="radio" name={`question-${item.id}`} checked={selected === option && !custom} onChange={() => { setSelected(option); setCustom("") }}/><span>{option}</span></label>)}</div>}
    {!write && item.allowCustom && <div className="bu-approval-custom"><input aria-label="补充你的回答" value={custom} onChange={(event) => { setCustom(event.target.value); setSelected("") }} placeholder="其他想法…"/></div>}
    {!write && <div className="bu-question-footer"><button type="button" className="btn-sm btn-primary" disabled={!(custom.trim() || selected)} onClick={() => submit(custom.trim() || selected)}>发送答案</button></div>}
    {write && (item.status === "pending" || item.status === "draft" || (item.status === "failed" && item.submissionFailed)) && <div className="bu-approval-actions">{!missingCodeDiff && <button type="button" className="btn-sm btn-primary" onClick={() => diff ? confirmDialog.current?.showModal() : submit("确认")}>{diff ? "审核完成，确认执行" : "确认并发送"}</button>}<button type="button" className="btn-sm" onClick={() => submit("拒绝")}>拒绝并发送</button></div>}
    {diff && <dialog ref={confirmDialog} className="bu-approval-dialog" aria-labelledby={`confirm-title-${item.id}`}><h3 id={`confirm-title-${item.id}`}>确认执行代码修改？</h3><p>对象：{input.name || "当前对象"}</p><p>{input.summary}</p><p>确认后，Agent 将按上方差异方案调用 SAP 写工具。</p><div className="bu-approval-dialog-actions"><button type="button" className="btn-sm" onClick={() => confirmDialog.current?.close()}>返回查看差异</button><button type="button" className="btn-sm btn-primary" onClick={() => { confirmDialog.current?.close(); submit("确认") }}>确认执行</button></div></dialog>}
    {(write || item.status === "failed" || item.status === "interrupted") && <div className={`bu-approval-status ${item.status}`}>{write && item.status === "failed" && item.submissionFailed ? "发送失败，请重试" : statusText}</div>}
  </section>
}

function SystemNotice({ item }) {
  if (item.tone === "interrupted") return <div className="msg system-note interruption-note" data-item-id={item.id}>{item.text}<br/><button className="continue-btn" type="button" onClick={() => { view.remove(item.id); App.sendMessage?.("请继续刚才的回答，从上次中断的地方接着写下去") }}>继续生成 ▶</button></div>
  return <div className={`msg system-note ${item.tone === "error" ? "generation-error" : ""}`} data-item-id={item.id}>{item.text}</div>
}

function Welcome() {
  const prompts = [
    ["请帮我查找并分析一个 ABAP 程序。", "查阅与分析代码", "从程序逻辑到调用关系"],
    ["请帮我梳理一个 SAP 业务问题。", "梳理业务问题", "从业务现象到排查步骤"],
  ]
  return <section className="chat-welcome"><div className="welcome-label">SAPBUDDY / WORKSPACE</div><h1>今天，一起解决什么问题？</h1><p>查阅 ABAP 代码、分析业务数据，或梳理一个开发需求。</p>
    <div className="welcome-prompts">{prompts.map(([prompt, title, subtitle]) => <button key={title} type="button" onClick={() => App.prefillMessage?.(prompt)}>{title}<small>{subtitle}</small></button>)}</div>
  </section>
}

function LoadingState({ waiting: value }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [])
  return <div className="msg waiting-note bu-loading" role="status" aria-live="polite"><PixelLoader/>
    <span className="waiting-text bu-shimmer">{value.text}</span><span className="bu-loading-time">{formatElapsed(now - value.startedAt)}</span></div>
}

function SendControl() {
  const state = useChat()
  return <button id="send-btn" type="button" className={state.streaming ? "stop" : ""} disabled={state.compressing || state.stopping} onClick={() => {
    if (state.streaming) {
      App.stopGeneration?.()
    } else App.sendMessage?.()
  }}>{state.stopping ? "正在停止…" : state.streaming ? <><span className="bu-stop-icon"/>停止</> : "发送"}</button>
}

function SelectionActions() {
  const [selection, setSelection] = useState(null)
  useEffect(() => {
    const onMouseUp = () => {
      const selected = window.getSelection()
      const text = selected?.toString().trim()
      const node = selected?.anchorNode?.parentElement?.closest?.(".reply-text")
      if (!text || !node) { setSelection(null); return }
      const rect = selected.getRangeAt(0).getBoundingClientRect()
      setSelection({ text, x: rect.left + rect.width / 2, y: rect.top })
    }
    document.addEventListener("mouseup", onMouseUp)
    return () => document.removeEventListener("mouseup", onMouseUp)
  }, [])
  if (!selection) return null
  const quote = selection.text.length > 1600 ? selection.text.slice(0, 1600) + "…" : selection.text
  return <div className="bu-selection-actions" style={{ left: selection.x, top: Math.max(8, selection.y - 42) }}>
    <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => { App.prefillMessage?.(`请解释以下 ABAP 内容：\n\n\`\`\`abap\n${quote}\n\`\`\``); setSelection(null) }}>解释</button>
    <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => { App.prefillMessage?.(`请针对以下内容提出修改建议，先不要执行 SAP 写操作：\n\n\`\`\`abap\n${quote}\n\`\`\``); setSelection(null) }}>修改建议</button>
  </div>
}

function Conversation() {
  const state = useChat()
  const scrollRef = useRef(null)
  useEffect(() => {
    const container = document.getElementById("messages")
    let previousTop = container.scrollTop
    const onScroll = () => {
      const upward = container.scrollTop < previousTop
      previousTop = container.scrollTop
      if (upward && container.scrollTop < 100 && state.historyMore && !state.streaming && !App.state.historyLoading && state.historyStatus !== "error") {
        App.loadHistory?.(state.historyMore.path, state.historyMore.before)
      }
    }
    container.addEventListener("scroll", onScroll, { passive: true })
    return () => container.removeEventListener("scroll", onScroll)
  }, [state.historyMore, state.streaming, state.historyStatus])
  const items = [...state.items.values()]
  const hasConversation = items.some((item) => ["user", "assistant", "system", "approval"].includes(item.kind)) || state.waiting
  return <>
    {(state.historyMore || state.historyStatus) && <button className="load-more history-more" type="button" disabled={state.historyStatus === "loading"} onClick={() => {
      const retry = state.historyRetry || state.historyMore
      if (retry) App.loadHistory?.(retry.path, retry.before, retry.options)
    }}>{state.historyStatus === "loading" ? "正在加载历史…" : state.historyStatus === "error" ? "历史加载失败，点击重试" : "加载更早的消息"}</button>}
    {!hasConversation && <Welcome />}
    {items.map((item) => {
      if (item.kind === "user") return <UserMessage key={item.id} item={item} />
      if (item.kind === "assistant") return <AssistantMessage key={item.id} item={item} active={item.id === activeAssistantId} />
      if (item.kind === "approval") return item.deferred ? null : <ApprovalCard key={item.id} item={item} />
      return <SystemNotice key={item.id} item={item} />
    })}
    {state.waiting && <LoadingState waiting={state.waiting} />}
    <SelectionActions />
  </>
}

const messagesRoot = document.getElementById("messages")
const sendRoot = document.getElementById("send-control-root")
if (messagesRoot && sendRoot) {
  const conversationRoot = createRoot(messagesRoot)
  const sendControlRoot = createRoot(sendRoot)
  flushSync(() => {
    conversationRoot.render(<Conversation />)
    sendControlRoot.render(<SendControl />)
  })
}
