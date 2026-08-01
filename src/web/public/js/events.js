/**
 * SSE 连接 + 事件分发 — connectEvents, handleAgentEvent, renderConfirmation
 */
"use strict";

(function() {
  const App = window.SapBuddy;
  const state = App.state;
  const $ = App.$;

  // ── 用户确认卡片 ──
  function renderConfirmation(payload) {
    const id = payload.toolCallId;
    const question = payload.question || "确认？";
    const options = payload.options || ["是", "否"];
    const allowCustom = payload.allowCustom === true;

    const old = document.querySelector(`.confirm-card[data-cid="${CSS.escape(id)}"]`);
    if (old) old.remove();

    const card = document.createElement("div");
    card.className = "confirm-card";
    card.dataset.cid = id;

    const q = document.createElement("div");
    q.className = "confirm-question";
    q.textContent = question;
    card.appendChild(q);

    const btns = document.createElement("div");
    btns.className = "confirm-btns";

    let customInput = null;
    const disableAll = (selected) => {
      btns.querySelectorAll("button").forEach((b) => {
        b.disabled = true;
        b.classList.toggle("selected", b.dataset.choice === selected);
      });
      if (customInput) {
        if (selected !== "__custom__") customInput.disabled = true;
        else customInput.classList.add("selected");
      }
    };

    for (const opt of options) {
      const btn = document.createElement("button");
      btn.className = "confirm-btn";
      btn.textContent = opt;
      btn.dataset.choice = opt;
      btn.addEventListener("click", async () => {
        disableAll(opt);
        await sendConfirmation(id, opt);
      });
      btns.appendChild(btn);
    }

    if (allowCustom) {
      customInput = document.createElement("input");
      customInput.className = "confirm-custom-input";
      customInput.type = "text";
      customInput.placeholder = "输入自定义内容…";
      customInput.addEventListener("keydown", async (e) => {
        if (e.key === "Enter" && customInput.value.trim()) {
          disableAll("__custom__");
          await sendConfirmation(id, "__custom__", customInput.value.trim());
        }
      });
      btns.appendChild(customInput);
    }

    card.appendChild(btns);
    document.getElementById("messages").appendChild(card);
    App.scrollToBottom();
  }

  async function sendConfirmation(toolCallId, choice, customText) {
    try {
      await fetch("/api/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolCallId, choice, custom_text: customText || "" }),
      });
    } catch (e) {
      console.error("[SapBuddy] 确认发送失败:", e);
    }
    const card = document.querySelector(`.confirm-card[data-cid="${CSS.escape(toolCallId)}"]`);
    if (card) {
      card.classList.add("resolved");
      setTimeout(() => card.remove(), 3000);
    }
  }

  // ── SSE 连接 ──
  App.connectEvents = function() {
    if (state.es) state.es.close();
    const es = new EventSource("/api/events");
    state.es = es;

    if (typeof App.connectEvents._retryDelay === "undefined") App.connectEvents._retryDelay = 3000;

    let _sseQueue = [];
    let _sseProcessing = false;
    const SSE_BATCH_MAX = 20; // 每帧最多处理 20 个事件，避免阻塞主线程
    function _processSseQueue() {
      _sseProcessing = true;
      const batch = _sseQueue.splice(0, SSE_BATCH_MAX); // 每次只取前 N 个
      for (const payload of batch) {
        if (payload.kind === "agent") {
          handleAgentEvent(payload.event, payload.elapsed, payload.usage);
        } else if (payload.kind === "user_confirmation") {
          renderConfirmation(payload);
        } else if (payload.kind === "session_reset") {
          const g = payload.state?.gen ?? 0;
          if (payload.state && payload.state.sessionFile && g >= state.currentGen) {
            state.currentPath = payload.state.sessionFile;
            state.currentGen = g;
          }
          App.refreshState().catch(() => {});
          App.refreshSessions().catch(() => {});
        } else if (payload.kind === "compress_result") {
          const saved = payload.saved ? `，节省约 ${payload.saved} tokens` : "";
          App.addSystemNote(`上下文压缩完成${saved}`);
          App.setCompressUI(false);
          if (window._ctxTooltip && window._ctxTooltip.classList.contains("visible")) App.refreshCtxTooltip();
        } else if (payload.kind === "error") {
          App.addSystemNote("错误：" + payload.error);
          App.setStreaming(false);
          App.setCompressUI(false);
        } else if (payload.kind === "config_status") {
          state.configStatus = payload.configStatus || "ok";
          App.refreshState().catch(() => {});
        }
      }
      _sseProcessing = false;
      if (_sseQueue.length > 0) {
        setTimeout(_processSseQueue, 0);
      }
    }

    es.onmessage = (e) => {
      let payload;
      try { payload = JSON.parse(e.data); } catch { return; }
      _sseQueue.push(payload);
      if (!_sseProcessing) {
        setTimeout(_processSseQueue, 0);
      }
    };

    es.onerror = () => {
      App.setAgentStatus(false, "连接断开，重连中…");
      es.close();
      setTimeout(App.connectEvents, App.connectEvents._retryDelay);
      App.connectEvents._retryDelay = Math.min(App.connectEvents._retryDelay * 2, 30000);
    };

    es.onopen = () => {
      App.setAgentStatus(true, "Agent 已连接");
      App.connectEvents._retryDelay = 3000;
    };
  };

  // ── Agent 事件处理 ──
  function handleAgentEvent(ev, elapsed, usage) {
    switch (ev.type) {
      case "agent_start":
        App.setStreaming(true);
        state.currentAssistantEl = null;
        state.currentTextDiv = null;
        state.pendingTexts = [];
        state.processEl = null;
        state.currentThinkSeg = null;
        break;

      case "message_start":
        if (ev.message?.role === "assistant") {
          state.currentTextDiv = null;
          state.currentThinkSeg = null;
          const body = App.ensureAssistantBubble();
          body.classList.add("typing");
        }
        break;

      case "message_update":
        if (ev.message?.role === "assistant") {
          const body = App.ensureAssistantBubble();
          App.renderAssistantContent(body, ev.message.content);
        }
        break;

      case "message_end":
        if (state.currentAssistantEl) {
          state.currentAssistantEl.classList.remove("typing");
          const bubble = state.currentAssistantEl.closest(".msg");
          if (bubble) {
            const empty = state.currentAssistantEl.children.length === 0 && !state.currentAssistantEl.classList.contains("typing");
            bubble.classList.toggle("empty-bubble", empty);
          }
        }
        break;

      case "tool_execution_start": {
        if (state.currentAssistantEl) state.currentAssistantEl.classList.remove("typing");
        const bubble = state.currentAssistantEl ? state.currentAssistantEl.closest(".msg") : null;
        const proc = App.ensureProcessCard(bubble);
        proc.querySelector(".process-body").appendChild(App.createToolCard(ev.toolCallId, ev.toolName, ev.args));
        App.updateProcessSummary();
        App.scrollToBottom();
        break;
      }

      case "tool_execution_end":
        App.finishToolCard(ev.toolCallId, ev.result?.content ?? ev.result, ev.result?.isError ?? ev.isError);
        App.scrollToBottom();
        break;

      case "agent_abort":
        console.log("[SapBuddy] 收到 agent_abort 事件");
        App.addSystemNote("操作已中止");
        if (state.currentAssistantEl) state.currentAssistantEl.classList.remove("typing");
        state.currentAssistantEl = null;
        state.currentTextDiv = null;
        state.pendingTexts = [];
        // 把所有"执行中"的工具卡片标记为已中止
        state.toolCards.forEach((card) => {
          const stateEl = card.querySelector(".tool-state");
          if (stateEl && stateEl.classList.contains("running")) {
            stateEl.className = "tool-state failed";
            stateEl.textContent = "⏹ 已中止";
          }
        });
        App.setStreaming(false);
        App.refreshState();
        break;

      case "agent_end":
        console.log("[SapBuddy] 收到 agent_end, stopReason:", ev.message?.stopReason);
        if (ev.message?.stopReason === "error" || ev.message?.errorMessage === "terminated") {
          App.onGenerationInterrupted();
        }
        if (state.currentAssistantEl) state.currentAssistantEl.classList.remove("typing");
        App.consolidateAssistantReplies();
        if (usage) {
          const elapsedStr = elapsed
            ? `${Math.floor(elapsed / 60000)}分${Math.round((elapsed % 60000) / 1000)}秒`
            : "";
          const parts = [];
          if (usage.input) parts.push(`输入 ${App.formatTokens(usage.input)}`);
          if (usage.output) parts.push(`输出 ${App.formatTokens(usage.output)}`);
          if (usage.cacheRead) parts.push(`缓存命中 ${App.formatTokens(usage.cacheRead)}`);
          if (elapsedStr) parts.push(`本轮耗时 ${elapsedStr}`);
          if (parts.length) {
            const note = document.createElement("div");
            note.className = "token-usage-note";
            note.textContent = parts.join("  ·  ");
            document.getElementById("messages").appendChild(note);
          }
        }
        state.currentAssistantEl = null;
        state.currentTextDiv = null;
        state.pendingTexts = [];
        if (state.processEl && state.processEl.querySelector(".process-body").children.length === 0) {
          state.processEl.remove();
        }
        App.setStreaming(false);
        App.refreshFiles();
        App.refreshState();
        App.refreshSessions().catch(() => {});
        if (window._ctxTooltip && window._ctxTooltip.classList.contains("visible")) App.refreshCtxTooltip();
        break;
    }
  }
})();
