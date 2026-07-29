/**
 * 工具调用卡片 — 幂等：同一 toolCallId 复用同一张卡片
 */
"use strict";

(function() {
  const App = window.AbapBuddy;
  const state = App.state;
  const escapeHtml = App.escapeHtml;

  // ── 图标映射 ──
  const TOOL_ICONS = {
    abap_ping: "⚡", abap_ls: "🔍", abap_cat: "📄", abap_create: "➕",
    abap_put: "💾", abap_check: "✔", abap_activate: "▶", abap_meta: "▦",
    abap_refs: "↗", abap_dump: "⚠", abap_transport: "📦", abap_status: "ℹ",
    abap_message: "✉", abap_texts: "𝐓", abap_system: "⚙", abap_run: "»",
    read: "📖", bash: "$", edit: "✎", write: "✎", grep: "🔍", find: "🔍", ls: "☰",
  };

  // ── 参数摘要 ──
  App.summarizeArgs = function(args) {
    if (!args) return "";
    let obj = args;
    if (typeof args === "string") {
      try { obj = JSON.parse(args); } catch { return args.length > 90 ? args.slice(0, 90) + "…" : args; }
    }
    if (typeof obj !== "object" || obj === null) return String(obj).slice(0, 90);
    const keys = Object.keys(obj);
    if (!keys.length) return "";
    const parts = keys.map((k) => {
      let v = obj[k];
      if (typeof v === "string" && v.length > 40) v = v.slice(0, 40) + "…";
      return `${k}: ${JSON.stringify(v)}`;
    });
    const s = parts.join(", ");
    return s.length > 90 ? s.slice(0, 90) + "…" : s;
  };

  // ── 创建工具卡片 ──
  App.createToolCard = function(id, name, args) {
    if (id && state.toolCards.has(id)) {
      return state.toolCards.get(id);
    }
    const card = document.createElement("div");
    card.className = "tool-card";
    card.dataset.toolName = name || "";
    card.innerHTML = `
      <div class="tool-head">
        <span class="tool-caret">▸</span>
        <span class="tool-icon">${TOOL_ICONS[name] || "🔧"}</span>
        <span class="tool-name"></span>
        <span class="tool-args"></span>
        <span class="tool-state running"><span class="spinner"></span> 执行中</span>
      </div>
      <div class="tool-body"></div>`;
    card.querySelector(".tool-name").textContent = name || "tool";
    card.querySelector(".tool-args").textContent = App.summarizeArgs(args);
    card.querySelector(".tool-head").addEventListener("click", () => card.classList.toggle("expanded"));
    if (id) state.toolCards.set(id, card);
    return card;
  };

  // ── 完成工具卡片 ──
  App.finishToolCard = function(id, resultContent, isError) {
    const card = state.toolCards.get(id);
    if (!card) return;
    const stateEl = card.querySelector(".tool-state");
    stateEl.className = "tool-state " + (isError ? "failed" : "done");
    stateEl.textContent = isError ? "✗ 失败" : "✓ 完成";
    const body = card.querySelector(".tool-body");
    let text = "";
    if (Array.isArray(resultContent)) {
      text = resultContent.map((c) => c.text || "").join("\n");
    } else if (typeof resultContent === "string") {
      text = resultContent;
    }
    if (text.length > 8000) text = text.slice(0, 8000) + "\n…（结果过长已截断）";
    body.innerHTML = "";
    const pre = document.createElement("pre");
    pre.className = "tool-code";
    pre.textContent = text || "(无输出)";
    body.appendChild(pre);
  };
})();
