/** SSE connection and pi event adapter for the React conversation state. */
"use strict";

(function() {
  const App = window.SapBuddy;
  const state = App.state;
  let pendingFailure = null;

  App.connectEvents = function() {
    if (state.es) state.es.close();
    const es = new EventSource("/api/events");
    state.es = es;
    let queue = [];
    let processing = false;
    let reconnecting = false;
    const batchSize = 20;

    function handlePayload(payload) {
      if (payload.sequence && payload.sequence <= (state.historyEventSequence || 0)) return;
      if (payload.sessionFile && state.currentPath && payload.sessionFile !== state.currentPath) return;
      if (payload.kind === "agent") {
        handleAgentEvent(payload.event, payload.elapsed, payload.usage);
      } else if (payload.kind === "user_confirmation") {
        App.addConfirmation(payload);
      } else if (payload.kind === "write_approval_required") {
        App.addWriteApproval(payload);
      } else if (payload.kind === "session_reset") {
        pendingFailure = null;
        const generation = payload.state?.gen ?? 0;
        if (payload.state?.sessionFile && generation >= state.currentGen) {
          state.currentPath = payload.state.sessionFile;
          state.currentGen = generation;
        }
        App.refreshState().catch(() => {});
        App.refreshSessions().catch(() => {});
      } else if (payload.kind === "compress_result") {
        const details = [];
        if (payload.tokensSaved > 0) details.push(`节省约 ${App.formatTokens(payload.tokensSaved)} tokens`);
        if (payload.saved > 0) details.push(`减少 ${payload.saved} 条消息`);
        App.addSystemNote(`上下文压缩完成${details.length ? "，" + details.join("、") : ""}`);
        App.setCompressUI(false);
        if (window._ctxTooltip?.classList.contains("visible")) App.refreshCtxTooltip();
      } else if (payload.kind === "error") {
        pendingFailure = null;
        App.chatView.staleUnexecutedApprovals(state.currentPath);
        if (state.currentAssistantEl) App.chatView.removeActiveAssistantIfEmpty();
        state.currentAssistantEl = null;
        App.onGenerationError(payload.error);
        App.setStreaming(false);
        App.setCompressUI(false);
      } else if (payload.kind === "config_status") {
        state.configStatus = payload.configStatus || "ok";
        App.refreshState().catch(() => {});
      } else if (payload.kind === "update" && typeof App.onUpdateEvent === "function") {
        App.onUpdateEvent(payload);
      }
    }

    function processQueue() {
      if (state.es !== es) return;
      if (state.historyLoading) { setTimeout(processQueue, 16); return; }
      processing = true;
      const batch = queue.splice(0, batchSize);
      for (const payload of batch) handlePayload(payload);
      processing = false;
      if (queue.length) { processing = true; setTimeout(processQueue, 16); }
    }

    es.onmessage = (event) => {
      let payload;
      try { payload = JSON.parse(event.data); } catch { return; }
      const previous = queue[queue.length - 1];
      if (payload.event?.type === "message_update" && previous?.event?.type === "message_update" &&
          previous.event.message?.timestamp === payload.event.message?.timestamp && previous.sessionFile === payload.sessionFile) {
        queue[queue.length - 1] = payload;
      } else queue.push(payload);
      if (!processing) { processing = true; setTimeout(processQueue, 16); }
    };

    es.onerror = () => {
      reconnecting = true;
      App.setAgentStatus(false, "连接断开，重连中…");
    };
    es.onopen = () => {
      App.setAgentStatus(true, "Agent 已连接");
      if (reconnecting) {
        App.loadHistory(state.currentPath);
        App.refreshState();
        reconnecting = false;
      }
    };
  };

  function handleAgentEvent(event, elapsed, usage) {
    if (!event?.type) return;
    switch (event.type) {
      case "agent_start":
        pendingFailure = null;
        App.setStreaming(true);
        state.aborted = false;
        state.currentAssistantEl = null;
        break;

      case "message_start":
        if (state.aborted || event.message?.role !== "assistant") break;
        App.hideWaiting();
        state.currentAssistantEl = App.beginAssistantMessage(event.message, true);
        break;

      case "message_update":
        if (state.aborted || event.message?.role !== "assistant") break;
        state.currentAssistantEl = App.beginAssistantMessage(event.message);
        App.renderAssistantContent(state.currentAssistantEl, event.message.content);
        break;

      case "message_end": {
        if (event.message?.role !== "assistant") break;
        if (!state.aborted) {
          state.currentAssistantEl = App.beginAssistantMessage(event.message);
          App.renderAssistantContent(state.currentAssistantEl, event.message.content);
        }
        App.finalizeAssistantBubble();
        const aborted = state.aborted || event.message?.stopReason === "aborted";
        const errorText = event.message?.errorMessage;
        const terminated = errorText === "terminated";
        const failed = !aborted && (event.message?.stopReason === "error" || (errorText && !terminated && String(errorText).trim()));
        if (failed || terminated) {
          if (state.currentAssistantEl) App.chatView.removeActiveAssistantIfEmpty();
          state.currentAssistantEl = null;
          // message_end precedes the SDK retry decision in agent_end.
          pendingFailure = event.message;
        } else {
          pendingFailure = null;
          App.clearGenerationError?.();
        }
        break;
      }

      case "tool_execution_start":
        App.addToolCallToAgent(event.toolCallId, event.toolName, event.args);
        break;

      case "tool_execution_end":
        App.finishToolCard(event.toolCallId, event.result, event.result?.isError ?? event.isError);
        App.scrollToBottom();
        break;

      case "agent_abort":
        pendingFailure = null;
        state.aborted = true;
        App.addSystemNote("操作已中止");
        if (state.currentAssistantEl) App.chatView.removeActiveAssistantIfEmpty();
        state.currentAssistantEl = null;
        App.markToolCardsInterrupted();
        App.chatView.staleUnexecutedApprovals(state.currentPath);
        App.setStreaming(false);
        App.refreshState();
        break;

      case "agent_end": {
        state.aborted = false;
        if (event.willRetry) {
          pendingFailure = null;
          App.clearGenerationError?.();
          if (state.currentAssistantEl) App.chatView.removeActiveAssistantIfEmpty();
          App.showRetrying("模型暂时不可用，正在重试…");
          state.currentAssistantEl = null;
          break;
        }
        const finalMessage = event.message || event.messages?.findLast(message => message.role === "assistant") || pendingFailure;
        pendingFailure = null;
        const errorText = finalMessage?.errorMessage;
        const terminated = errorText === "terminated";
        const failed = finalMessage?.stopReason !== "aborted" && (finalMessage?.stopReason === "error" || (errorText && !terminated && String(errorText).trim()));
        if (failed || terminated) {
          if (state.currentAssistantEl) App.chatView.removeActiveAssistantIfEmpty();
          if (terminated) App.onGenerationInterrupted();
          else App.onGenerationError(errorText || finalMessage?.stopReason || "生成失败");
        } else App.clearGenerationError?.();
        App.chatView.staleUnexecutedApprovals(state.currentPath);
        App.resetAutoScroll();
        App.consolidateAssistantReplies(usage || event.message?.usage, elapsed);
        state.currentAssistantEl = null;
        App.setStreaming(false);
        App.refreshFiles();
        App.refreshState();
        App.refreshSessions().catch(() => {});
        if (window._ctxTooltip?.classList.contains("visible")) App.refreshCtxTooltip();
        break;
      }

      case "auto_retry_start":
        App.clearGenerationError?.();
        App.showRetrying(`模型暂时不可用，正在重试（${event.attempt}/${event.maxAttempts}）…`);
        break;

      case "agent_settled":
        if (!state.streaming) App.hideWaiting();
        break;
    }
  }
})();
