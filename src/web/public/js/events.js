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
          const parts = [];
          if (payload.tokensSaved > 0) parts.push(`节省约 ${App.formatTokens(payload.tokensSaved)} tokens`);
          if (payload.saved > 0) parts.push(`减少 ${payload.saved} 条消息`);
          const note = `上下文压缩完成${parts.length ? "，" + parts.join("、") : ""}`;
          App.addSystemNote(note);
          App.setCompressUI(false);
          if (window._ctxTooltip && window._ctxTooltip.classList.contains("visible")) App.refreshCtxTooltip();
        } else if (payload.kind === "error") {
          // session.prompt() 抛异常（如模型404/网络错误）：用统一的生成错误提示，
          // 并清掉可能残留的空气泡，避免"发了消息AI没反应"的体感
          if (state.currentAssistantEl) {
            const empty = state.currentAssistantEl.children.length === 0 &&
              !state.currentAssistantEl.classList.contains("typing");
            if (empty) {
              const bubble = state.currentAssistantEl.closest(".msg");
              if (bubble) bubble.remove();
            }
            state.currentAssistantEl = null;
          }
          App.onGenerationError(payload.error);
          App.setStreaming(false);
          App.setCompressUI(false);
        } else if (payload.kind === "config_status") {
          state.configStatus = payload.configStatus || "ok";
          App.refreshState().catch(() => {});
        } else if (payload.kind === "update") {
          if (typeof App.onUpdateEvent === "function") App.onUpdateEvent(payload);
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
        state.aborted = false;
        state.currentAssistantEl = null;
        state.currentTextDiv = null;
        state.pendingTexts = [];
        state.processEl = null;
        state.currentThinkSeg = null;
        break;

      case "message_start":
        if (state.aborted) break; // 用户已中止：忽略后续 message_start，防止重复创建气泡
        if (ev.message?.role === "assistant") {
          App.hideWaiting(); // AI 开始渲染消息 → 移除"等待模型响应"提示
          state.currentTextDiv = null;
          state.currentThinkSeg = null;
          const body = App.ensureAssistantBubble();
          body._thinkSegs = []; // 新消息独立思考段（同一轮复用气泡时也重置）
          body._curMsgTexts = [];
          body._curToolsWrap = null;
          body._curMsgIntermediate = false;
          body._curMsgNarrationMoved = false;   // 叙述是否已判定进思考流（每消息重置）
          body._curNarrationEntry = null;       // 叙述文本节点（每消息重置）
          body._inlineBlocks = {};               // 内联文本块（每消息重置，按 key 匹配）
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
        // 消息结束收尾：折叠思考块 + 最终回复完整 markdown 渲染
        App.finalizeAssistantBubble();
        if (state.currentAssistantEl) {
          state.currentAssistantEl.classList.remove("typing");
          const bubble = state.currentAssistantEl.closest(".msg");
          if (bubble) {
            const empty = state.currentAssistantEl.children.length === 0 && !state.currentAssistantEl.classList.contains("typing");
            bubble.classList.toggle("empty-bubble", empty);
          }
        }
        // 错误检测：pi SDK 的模型错误信息在 message_end.message 中
        // （agent_end 仅携带 willRetry，不携带 message/stopReason/errorMessage）
        // 用户主动中止（stopReason=aborted 或 state.aborted）不视为错误，不显示"生成出错"
        const _meAborted = state.aborted || ev.message?.stopReason === "aborted";
        const _meErr = ev.message?.errorMessage;
        const _meTerminated = _meErr === "terminated";
        const _meHasError = !_meAborted && (
          ev.message?.stopReason === "error" ||
          (_meErr && !_meTerminated && String(_meErr).trim() !== ""));
        if (_meHasError || _meTerminated) {
          // 清掉空气泡，用错误提示代替
          if (state.currentAssistantEl) {
            const empty = state.currentAssistantEl.children.length === 0;
            if (empty) {
              const bubble = state.currentAssistantEl.closest(".msg");
              if (bubble) bubble.remove();
            }
            state.currentAssistantEl = null;
          }
          if (_meTerminated) {
            App.onGenerationInterrupted();
          } else {
            App.onGenerationError(_meErr || ev.message?.stopReason || "生成失败");
          }
        }
        break;

      case "tool_execution_start": {
        if (state.currentAssistantEl) state.currentAssistantEl.classList.remove("typing");
        App.moveMsgNarrationToThink(); // 有工具 → 叙述文本挪进思考流，回复区只留最终答案
        App.addToolCallToAgent(ev.toolCallId, ev.toolName, ev.args);
        break;
      }

      case "tool_execution_end":
        App.finishToolCard(ev.toolCallId, ev.result?.content ?? ev.result, ev.result?.isError ?? ev.isError);
        App.scrollToBottom();
        break;

      case "agent_abort":
        console.log("[SapBuddy] 收到 agent_abort 事件");
        state.aborted = true;
        App.addSystemNote("操作已中止");
        // 不置空 currentAssistantEl：后续 message_end 可正常收尾；
        // 若空气泡（无内容）则直接移除，避免残留空 SapBuddy 气泡
        if (state.currentAssistantEl) {
          state.currentAssistantEl.classList.remove("typing");
          const empty = state.currentAssistantEl.children.length === 0;
          if (empty) {
            const bubble = state.currentAssistantEl.closest(".msg");
            if (bubble) bubble.remove();
            state.currentAssistantEl = null;
          }
        }
        state.currentTextDiv = null;
        state.pendingTexts = [];
        App.markToolCardsInterrupted(); // 未完成的工具调用标"中断"
        App.setStreaming(false);
        App.refreshState();
        break;

      case "agent_end":
        state.aborted = false;
        console.log("[SapBuddy] 收到 agent_end, stopReason:", ev.message?.stopReason, "willRetry:", ev.willRetry);
        // 临时性 LLM 错误（网络抖动等）SDK 会自动重试：此时不要拆除流式 UI，
        // 否则按钮"停止→发送→停止"来回切、"等待模型响应"闪没。保持流式态等重试继续。
        if (ev.willRetry) {
          // 移除这次失败消息产生的空气泡，避免残留空气泡
          if (state.currentAssistantEl) {
            const empty =
              state.currentAssistantEl.children.length === 0 &&
              !state.currentAssistantEl.classList.contains("typing");
            if (empty) {
              const bubble = state.currentAssistantEl.closest(".msg");
              if (bubble) bubble.remove();
            }
          }
          App.showWaiting(); // 重试期间继续显示"等待模型响应"
          state.currentAssistantEl = null;
          state.currentTextDiv = null;
          state.pendingTexts = [];
          state.processEl = null;
          state.currentThinkSeg = null;
          break;
        }
        // 错误检测放宽：stopReason=error 或 errorMessage 非空且非 terminated 都算错误
        const _errMsg = ev.message?.errorMessage;
        const _isTerminated = _errMsg === "terminated";
        const _hasError = ev.message?.stopReason === "error" ||
          (_errMsg && !_isTerminated && String(_errMsg).trim() !== "");
        if (_hasError || _isTerminated) {
          // 出错时清掉这次失败消息产生的空气泡（用错误提示代替空泡）
          if (state.currentAssistantEl) {
            const empty =
              state.currentAssistantEl.children.length === 0 &&
              !state.currentAssistantEl.classList.contains("typing");
            if (empty) {
              const bubble = state.currentAssistantEl.closest(".msg");
              if (bubble) bubble.remove();
            }
          }
          // 区分"模型明确拒绝"（如图片不支持，给精准提示）与"中途中断"（保留继续生成入口）
          if (_isTerminated) {
            App.onGenerationInterrupted();
          } else {
            App.onGenerationError(_errMsg || ev.message?.stopReason || "生成失败");
          }
        }
        if (state.currentAssistantEl) state.currentAssistantEl.classList.remove("typing");
        // 输出全部返回后自动收起思考面板（工具执行时自动展开过）
        App.collapseThinkPanels();
        App.resetAutoScroll(); // 输出结束：恢复"到底自动跟随"，防止中途上滚残留把视图留在半路
                        // token/time 须在 consolidate 之前设置（consolidate 会置空 currentAssistantEl）
        // usage 可能在 ev.message.usage（pi SDK agent_end 事件），也可能在 payload.usage（第三参数）
        const usageData = usage || ev.message?.usage;
        let agentMsgEl = state.currentAssistantEl?.closest(".msg.agent");
        // 兜底：currentAssistantEl 失效时，取最后一条可见 AI 消息
        if (!agentMsgEl) {
          const ams = document.querySelectorAll("#messages .msg.agent");
          agentMsgEl = ams[ams.length - 1] || null;
        }
        if (agentMsgEl) {
          const timeEl = agentMsgEl.querySelector(".msg-time");
          if (timeEl && !timeEl.textContent) timeEl.textContent = App.formatMessageTime(Date.now());
          if (usageData) {
            const totalTokens = usageData.totalTokens || usageData.total_tokens || ((usageData.input || 0) + (usageData.output || 0));
            if (totalTokens) {
              const tokensEl = agentMsgEl.querySelector(".msg-tokens");
              if (tokensEl) tokensEl.textContent = "消耗 " + App.formatTokens(totalTokens);
            }
          }
        }
        App.consolidateAssistantReplies();
                if (usageData) {
          const elapsedStr = elapsed
            ? `${Math.floor(elapsed / 60000)}分${Math.round((elapsed % 60000) / 1000)}秒`
            : "";
          const parts = [];
          if (usageData.input) parts.push(`输入 ${App.formatTokens(usageData.input)}`);
          if (usageData.output) parts.push(`输出 ${App.formatTokens(usageData.output)}`);
          if (usageData.cacheRead) parts.push(`缓存命中 ${App.formatTokens(usageData.cacheRead)}`);
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
        // 清理空的思考块（无内容时移除）
        const thinkEl = document.querySelector(".agent-think .agent-think-body");
        if (thinkEl && !thinkEl.textContent.trim()) {
          const det = thinkEl.closest(".agent-think");
          if (det) det.remove();
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
