/**
 * 聊天操作 — 发送、停止、新建、切换、历史加载
 */
"use strict";

(function() {
  const App = window.SapBuddy;
  const state = App.state;
  const $ = App.$;

  const inputEl = $("#input");

  // ── 流式状态 ──
  App.setStreaming = function(on) {
    const prev = state.streaming;
    state.streaming = on;
    App.chatView?.setStreaming(on);
    inputEl.disabled = false;
    // 兜底：发送失败/中止/结束时清掉"等待模型响应"提示，防止卡住
    if (!on) App.hideWaiting();
    App.refreshStateQuick(on);
    // 流式状态变化时刷新会话列表（更新"正在执行"图标）
    if (App.refreshSessions) App.refreshSessions(true);
    if (!on && prev) App.chatView?.finishAssistant();
  };

  // ── 忙碌态 ──
  App.setBusyUI = function(on, msg) {
    const btn = document.getElementById("new-chat-btn");
    if (btn) { btn.disabled = on; btn.classList.toggle("is-busy", on); }
    document.body.classList.toggle("is-busy", on);
    const sb = document.getElementById("sidebar");
    if (sb) sb.classList.toggle("is-busy", on);
    if (on && msg) App.addSystemNote(msg);
  };

  // ── 发送消息 ──
  // textOverride 可选：「继续生成」按钮等场景传入待发送文字（而非从输入框读取）
  // opts.skipUserBubble：编辑重发场景，不创建新的用户气泡（复用已更新的旧消息）
  // opts.images：编辑重发/重新生成场景，传入原消息的图片数据（格式：[{mimeType, data}]）
  // opts.attachments：编辑重发/重新生成场景，传入原消息的附件数据（格式：[{name, path}]）
  App.sendMessage = async function(textOverride, opts) {
    const preserveDraft = opts?.preserveDraft === true;
    const skipUserBubble = !!(opts && opts.skipUserBubble);
    const overrideImages = opts && opts.images ? opts.images : null;
    const overrideAttachments = opts && opts.attachments ? opts.attachments : null;
    const raw = (textOverride != null ? String(textOverride).trim() : inputEl.value.trim());
    const atts = overrideAttachments || (preserveDraft ? [] : (state.attachments || []));
    const imgs = overrideImages || (preserveDraft ? [] : (state.images || []));
    if ((!raw && !atts.length && !imgs.length) || state.streaming) return;

    // 气泡显示：用户文本 + 附件名；图片直接以缩略图渲染（不再拼图片名，与历史回显一致）
    let displayText = raw;
    if (atts.length) displayText = (displayText ? displayText + "\n" : "") + atts.map((a) => a.name).join("\n");

    // 发给 AI：完整文本 + 隐藏的文件路径引用（AI 用 read 读取）+ 图片（视觉输入）
    let sendText = raw;
    if (atts.length) {
      const ref = atts.map((a) => "- " + a.name + " → " + a.path).join("\n");
      sendText = (sendText ? sendText + "\n\n" : "") + "【用户附带的文件（已保存到本地，请用 read 工具读取内容）】\n" + ref;
    }

    if (!skipUserBubble) {
      App.addUserBubble(displayText, imgs, atts, Date.now());
    }
    const approvalSubmission = App.chatView?.submitApproval(raw, state.currentPath) || [];
    if (!preserveDraft) {
      if (textOverride == null) inputEl.value = "";
      App.clearAttachments();
      App.clearImages();
    }
    autoGrow();
    App.setStreaming(true);
    App.resetAutoScroll(); // 每次提问都恢复到底自动跟随
    App.showWaiting();
    if (state.rebuilding) {
      App.addSystemNote("正在准备会话，首条回复稍候…");
    }

    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: sendText, images: imgs.map((i) => ({ mimeType: i.mimeType, data: i.data })) }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        App.chatView?.settleApprovalSubmission(approvalSubmission, false);
        App.addSystemNote("发送失败：" + (j.error || r.status));
        App.setStreaming(false);
      } else {
        App.chatView?.settleApprovalSubmission(approvalSubmission, true);
      }
    } catch (e) {
      // 网络波动/服务不可达：清掉等待提示并给出明确反馈，避免一直"等待模型响应"
      App.chatView?.settleApprovalSubmission(approvalSubmission, false);
      App.addSystemNote("发送失败（网络异常），请检查连接后重试。");
      App.setStreaming(false);
    }
  };

  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      App.sendMessage();
    }
  });

  App.prefillMessage = function(text) {
    inputEl.value = String(text || "");
    autoGrow();
    inputEl.focus();
  };

  function autoGrow() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
  }
  App.autoGrow = autoGrow;
  inputEl.addEventListener("input", autoGrow);

  // ── 加载历史 ──
  let historyRequest = 0;
  let historyController;
  App.cancelHistoryLoad = function() {
    historyRequest++;
    historyController?.abort();
    state.historyLoading = false;
  };
  App.loadHistory = async function(path, before = null) {
    if (before !== null && state.streaming) { App.showToast("请等待本轮完成后加载更早消息"); return; }
    historyController?.abort();
    historyController = new AbortController();
    const token = ++historyRequest;
    state.historyLoading = true;
    const messagesEl = document.getElementById("messages");
    const previousHeight = messagesEl.scrollHeight;
    const previousTop = messagesEl.scrollTop;
    try {
      const params = new URLSearchParams({ limit: "20" });
      if (path) params.set("path", path);
      if (before !== null) params.set("before", before);
      const r = await fetch("/api/history?" + params, { signal: historyController.signal });
      const j = await r.json();
      if (token !== historyRequest) return;
      if (!r.ok || !j.success) throw new Error(j.error || r.status);
      const sessionPath = path || j.data?.path;
      if (sessionPath) state.currentPath = sessionPath;
      if (sessionPath && j.data.name) {
        state.currentTitlePath = String(sessionPath).replace(/\\/g, "/").toLowerCase();
        state.currentTitle = j.data.name;
        App.updateTopbarTitle();
      }
      if (before === null) state.historyEventSequence = j.data.sequence || 0;
      state.currentAssistantEl = null;
      state.historyUserOffset = j.data.userOffset || 0;
      if (before === null) state.aborted = false;
      const wasStreaming = state.streaming;
      state.streaming = false;
      try {
        App.renderMessageList(j.data.messages || [], {
          live: j.data.isStreaming,
          prepend: before !== null,
          userOffset: j.data.userOffset || 0,
        });
        App.chatView?.setHistoryMore(j.data.before != null ? { path: sessionPath, before: j.data.before } : null);
      }
      finally { state.streaming = wasStreaming; }
      state.historyLoading = false;
      if (before === null) {
        App.setStreaming(!!j.data.isStreaming);
        if (j.data.isStreaming && !App.chatView?.activeAssistant()) App.showWaiting();
      }
      if (before !== null) requestAnimationFrame(() => { messagesEl.scrollTop = previousTop + messagesEl.scrollHeight - previousHeight; });
      else App.scrollToBottom(true);
      App.showWelcome();
    } catch (e) {
      if (e.name !== "AbortError" && token === historyRequest) App.addSystemNote("加载历史失败：" + e.message);
    } finally {
      if (token === historyRequest) state.historyLoading = false;
    }
  };

  // ── 新建对话 ──
  App.newChat = async function() {
    if (state.streaming) {
      App.addSystemNote("生成中，请先停止再新建对话");
      return;
    }
    if (state.creating) return;
    state.creating = true;
    App.setBusyUI(true, "正在新建会话…");
    try {
      App.clearChat();
      const r = await fetch("/api/session/new", { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.success) {
        App.addSystemNote("新建对话失败：" + (j.error || r.status));
        return;
      }
      state.currentPath = j.data?.path || null;
      if (j.data?.gen) state.currentGen = j.data.gen;
      App.updateTopbarTitle();
      await App.refreshSessions();
      await App.refreshState();
    } catch (e) {
      App.addSystemNote("新建对话失败：" + (e?.message || e));
    } finally {
      state.creating = false;
      App.setBusyUI(false);
    }
  };

  // ── 切换对话 ──
  App.switchChat = async function(path) {
    // 生成中禁止切换会话
    if (state.streaming) {
      App.addSystemNote("生成中，请先停止再切换对话");
      return;
    }
    if (state.creating) return;
    state.creating = true;
    // 先清掉旧消息并立即加载历史（读文件毫秒级，不等后台重建）
    state.currentPath = path;
    App.updateTopbarTitle();
    App.clearChat();
    App.loadHistory(path);
    // 后台重建 Agent 会话（耗时约 10s），不阻塞 UI
    try {
      const r = await fetch("/api/session/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.success) {
        App.addSystemNote("切换对话失败：" + (j.error || r.status));
        return;
      }
      if (j.data?.path) state.currentPath = j.data.path;
      if (j.data?.gen) state.currentGen = j.data.gen;
      // 刷新列表高亮 + 状态栏（会话 ID）
      App.refreshSessions?.(true);
      App.refreshState?.();
    } catch (e) {
      App.addSystemNote("切换对话失败：" + (e?.message || e));
    } finally {
      state.creating = false;
    }
  };
})();
