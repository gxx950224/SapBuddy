/**
 * 状态面板 — 底部状态栏、Agent 指示灯、SAP 状态
 */
"use strict";

(function() {
  const App = window.SapBuddy;
  const state = App.state;
  const $ = App.$;

  // ── Agent 状态指示灯 ──
  App.setAgentStatus = function(ok, text) {
    const d = $("#agent-dot-bottom");
    const t = $("#agent-text-bottom");
    if (d) d.className = "dot " + (ok ? "ok" : "err");
    if (t) t.textContent = text;
  };

  // ── 快速刷新流式状态 ──
  App.refreshStateQuick = function(streaming) {
    $("#st-streaming").textContent = streaming ? "生成中…" : "空闲";
  };

  // ── 完整刷新状态面板 ──
  App.refreshState = async function() {
    try {
      const r = await fetch("/api/state");
      const j = await r.json();
      if (!j.success || !j.data.ready) {
        App.setAgentStatus(false, "Agent 未就绪");
        return;
      }
      const d = j.data;
      state.rebuilding = !!d.rebuilding;
      state.configStatus = d.configStatus || "ok";
      state.messageCount = d.messageCount || 0;
      $("#st-model").textContent = d.model || "-";
      $("#st-streaming").textContent = d.isStreaming ? "生成中…" : "空闲";
      const sidEl = $("#chat-session-id");
      if (sidEl) {
        sidEl.textContent = d.sessionLabel || d.sessionId || "-";
        sidEl.dataset.kernelId = d.sessionId || "";
        sidEl.title = d.sessionId ? `会话: ${d.sessionLabel || "新对话"}\n内核: ${d.sessionId}\n点击复制内核ID` : "";
      }
      if (d.isStreaming !== state.streaming) App.setStreaming(d.isStreaming);
      if (d.configStatus === "invalid") {
        App.setAgentStatus(false, "API Key 无效" + (d.configError ? "：" + d.configError : ""));
        return;
      }
      if (d.configStatus === "unknown") {
        App.setAgentStatus(false, "已断开（Key 未能联网校验）");
        App.syncThinkLevel(d);
        return;
      }
      App.setAgentStatus(true, "Agent 已连接");
      App.syncThinkLevel(d);
    } catch {
      App.setAgentStatus(false, "服务不可达");
    }
  };

  // ── SAP 连接状态 ──
  App.refreshSapStatus = async function() {
    const dot = $("#sap-dot-bottom");
    const text = $("#sap-text-bottom");
    if (text) text.textContent = "SAP 检测中…";
    if (dot) dot.className = "dot";

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      const r = await fetch("/api/sap-status", { signal: controller.signal });
      clearTimeout(timeout);
      const j = await r.json();
      if (j.success && j.data) {
        const d = j.data;
        const cat = d.clientCategoryLabel ? ` · 类别 ${d.clientCategoryLabel}${d.clientCategory ? `(${d.clientCategory})` : ""}` : "";
        const label = `SAP ${j.data.sid || "已连接"} · ${j.data.user || ""}${cat}`;
        if (dot) dot.className = "dot ok";
        if (text) text.textContent = label;
      } else {
        if (dot) dot.className = "dot err";
        const errText = (j.error || "").includes("超时") ? "SAP 检测超时" : "SAP 未连接";
        if (text) text.textContent = errText;
      }
    } catch (e) {
      if (dot) dot.className = "dot err";
      const textEl = $("#sap-text-bottom");
      if (e.name === "AbortError") {
        if (textEl) textEl.textContent = "SAP 检测超时";
      } else {
        if (textEl) textEl.textContent = "SAP 检测失败";
      }
    }
  };
})();
