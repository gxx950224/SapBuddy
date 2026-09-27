// Ported from Beautiful UI ThinkingState / ToolChips (MIT, Shane Levine).
// Layout and glyphs follow 44a274e598395ab61e7c96c26fda2758780253b7.
// Demo timers/data are replaced with the persisted pi event stream.
import React, { useEffect, useMemo, useRef, useState } from "react"
import "./process-trace.css"

export function TraceIcon({ kind = "think", className = "" }) {
  const paths = {
    think: <path fill="currentColor" stroke="none" d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />,
    write: <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />,
    run: <path d="M4 17l6-5-6-5M12 19h8" />,
    read: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></>,
    globe: <><circle cx="12" cy="12" r="9"/><path d="M3.5 12h17M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></>,
    check: <path d="M20 6L9 17l-5-5"/>,
    chevron: <path d="M6 9l6 6 6-6"/>,
  }
  return <svg className={`bui-icon ${className}`} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind] || paths.read}</svg>
}

export function toolPresentation(tool) {
  const args = tool.args || {}
  const name = tool.name || "tool"
  const icon = /write|edit|replace|create|activate/i.test(name) ? "write" : /bash|exec|run/i.test(name) ? "run" : /search|find|grep|query/i.test(name) ? "search" : "read"
  const label = ({ bash: /\bcurl\b/.test(args.command || "") ? "请求网页" : /\bgrep\b/.test(args.command || "") ? "搜索内容" : /\bnode\b/.test(args.command || "") ? "运行脚本" : "运行命令", read: "读取文件", write: "写入文件", edit: "编辑文件", grep: "搜索内容", find: "查找文件", ls: "列出目录", search_abap_objects: "搜索对象", get_abap_object_lines: "读取代码", execute_sql_query: "查询数据" })[name] || name.replace(/^mcp_/, "").replaceAll("_", " ")
  const value = args.path || args.file_path || args.object_name || args.objectName || args.name || args.query || args.sql || args.command || Object.values(args).find(v => typeof v === "string") || "无参数"
  return { icon, label, chip: String(value).replace(/\s+/g, " ") }
}

export function traceSources(tools) {
  const sources = new Map()
  for (const tool of tools) {
    // Only URLs actually present in tool input; never infer a source or a successful read.
    for (const value of Object.values(tool.args || {})) {
      if (typeof value !== "string") continue
      for (const match of value.matchAll(/https?:\/\/[^\s"'<>`\\)]+/g)) {
        try {
          const url = new URL(match[0])
          if (url.username || url.password) continue
          if (!sources.has(url.href)) sources.set(url.href, { href: url.href, title: url.hostname, status: tool.status })
        } catch { /* incomplete streaming URL */ }
      }
    }
  }
  return [...sources.values()]
}

export function selectTraceVariant(texts, tools, sources = traceSources(tools)) {
  const names = tools.map(tool => `${tool.name || ""} ${Object.values(tool.args || {}).join(" ")}`).join(" ")
  const codingScore = tools.reduce((score, tool) => {
    const value = `${tool.name || ""} ${Object.values(tool.args || {}).join(" ")}`
    return score + (/write|edit|replace|create|activate|delete|patch|commit|transport|apply_patch|sed\s+-i/i.test(value) ? 2 : 0)
  }, 0)
  const searchScore = tools.reduce((score, tool) => {
    const value = `${tool.name || ""} ${Object.values(tool.args || {}).join(" ")}`
    return score + (/search|find|grep|query|curl|http|url|browser|web|wiki|google|flight/i.test(value) ? 1 : 0)
  }, sources.length)
  if (texts.length > 0) return "Reasoning"
  if (codingScore > searchScore && codingScore > 0) return "Coding"
  if (searchScore > 0) return "Search"
  if (names.trim() || tools.length > 0) return "Steps"
  return "Reasoning"
}

export function ThinkingTrace({ texts, tools, working }) {
  const [manualOpen, setManualOpen] = useState(null)
  const [more, setMore] = useState(false)
  const [selected, setSelected] = useState(null)
  const started = useRef(Date.now())
  const [elapsed, setElapsed] = useState(null)
  const expanded = manualOpen ?? working
  useEffect(() => {
    if (!working) return
    const timer = setInterval(() => setElapsed((Date.now() - started.current) / 1000), 250)
    return () => clearInterval(timer)
  }, [working])
  const sources = useMemo(() => traceSources(tools), [tools])
  const variant = useMemo(() => selectTraceVariant(texts, tools, sources), [texts, tools, sources])
  const query = useMemo(() => tools.map(tool => tool.args?.query).find(value => typeof value === "string") || sources.map(source => {
    const params = new URL(source.href).searchParams
    return params.get("q") || params.get("wd") || params.get("query")
  }).find(Boolean), [tools, sources])
  const rows = variant === "Reasoning" ? texts : variant === "Search" ? sources : tools
  const visible = more ? rows : rows.slice(0, variant === "Reasoning" ? 2 : 4)
  const heading = variant === "Search" ? (working ? "正在检索" : "检索过程") : variant === "Coding" ? (working ? "正在运行工具" : `已调用 ${tools.length} 个工具`) : (working ? "正在思考" : "思考过程")
  return <section className={`bui-trace-shell bui-trace-${variant.toLowerCase()}`} data-variant={variant} aria-label={`Thinking：${variant}`}>
    <details className="bu-thinking bui-thinking" open={expanded} onToggle={event => { if (event.currentTarget.open !== expanded) setManualOpen(event.currentTarget.open) }}>
      <summary onClick={event => { event.preventDefault(); setManualOpen(!expanded) }}>
        <TraceIcon/><span className={working ? "bui-shimmer" : ""}>{heading}</span>{elapsed !== null && <span className="bui-elapsed">{elapsed.toFixed(1)} 秒</span>}<TraceIcon kind="chevron" className="bui-disclosure"/>
      </summary>
      <div className={`bui-trace-body bui-${variant.toLowerCase()}`}>
        {variant === "Search" && query && <div className="bui-trace-row"><TraceIcon kind="search"/><span>{query}</span></div>}
        {visible.map((row, index) => {
          if (variant === "Reasoning") return <p className="bui-reasoning-row" key={index}>{row}</p>
          if (variant === "Search") return <a className="bui-trace-row" key={row.href} href={row.href} target="_blank" rel="noreferrer"><span className={`bui-source-dot tone-${index % 3}`}><TraceIcon kind="globe"/></span><span>{row.title}</span><small>检索地址</small></a>
          const presentation = toolPresentation(row)
          const content = <>{variant === "Steps" && (row.status === "running" ? <i className="bui-spinner"/> : <TraceIcon kind={row.status === "complete" ? "check" : "run"}/>)}<span>{presentation.label}</span><small title={presentation.chip}>{presentation.chip}</small></>
          return variant === "Coding" ? <React.Fragment key={row.id}><button type="button" className="bui-trace-row" aria-pressed={selected === row.id} onClick={() => setSelected(selected === row.id ? null : row.id)}>{content}</button>{selected === row.id && <pre className="bui-trace-input">{JSON.stringify(row.args, null, 2)}</pre>}</React.Fragment> : <div className={`bui-trace-row ${row.status}`} key={row.id}>{content}</div>
        })}
        {!rows.length && <p className="bui-trace-empty">{variant === "Reasoning" ? "未提供思考内容" : variant === "Search" ? "本轮没有检索地址" : working ? "正在分析需求…" : "本轮没有工具调用"}</p>}
        {rows.length > (variant === "Reasoning" ? 2 : 4) && <button type="button" className="bui-more" onClick={() => setMore(!more)}>{more ? "收起" : `+${rows.length - visible.length} 更多`}</button>}
      </div>
    </details>
  </section>
}
