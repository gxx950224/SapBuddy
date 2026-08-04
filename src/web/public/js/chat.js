/**
 * 聊天操作 — 发送、停止、新建、切换、历史加载
 */
"use strict";

(function() {
  const App = window.SapBuddy;
  const state = App.state;
  const $ = App.$;

  const inputEl = $("#input");
  const sendBtn = $("#send-btn");

  // ── 流式状态 ──
  App.setStreaming = function(on) {
    // 无条件清残留光标：覆盖 abort/error/点停止等不经过 consolidate 的路径，防光标残留
    document.querySelectorAll(".stream-cursor").forEach((c) => c.remove());
    const prev = state.streaming;
    state.streaming = on;
    sendBtn.textContent = on ? "停止" : "发送";
    sendBtn.classList.toggle("stop", on);
    inputEl.disabled = false;
    App.refreshStateQuick(on);
    // 流式结束：用保存的原始 markdown 全文重渲染（textContent 会丢掉 md 标记）
    if (!on && prev) {
      const lastDiv = state.pendingTexts?.[state.pendingTexts.length - 1];
      if (lastDiv && lastDiv._renderedLen > 0 && !lastDiv._finalized) {
        lastDiv._finalized = true;
        App.mountMarkdown(lastDiv, lastDiv._fullText || lastDiv.textContent, { highlight: true });
        lastDiv._cursor = null;
      }
    }
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
  App.sendMessage = async function() {
    const raw = inputEl.value.trim();
    const atts = state.attachments || [];
    if ((!raw && !atts.length) || state.streaming) return;

    // 气泡显示：用户文本 + 附件名（简洁）
    let displayText = raw;
    if (atts.length) displayText = (displayText ? displayText + "\n" : "") + atts.map((a) => a.name).join("\n");

    // 发给 AI：完整文本 + 隐藏的文件路径引用（AI 用 read 读取）
    let sendText = raw;
    if (atts.length) {
      const ref = atts.map((a) => "- " + a.name + " → " + a.path).join("\n");
      sendText = (sendText ? sendText + "\n\n" : "") + "【用户附带的文件（已保存到本地，请用 read 工具读取内容）】\n" + ref;
    }

    App.addUserBubble(displayText);
    inputEl.value = "";
    App.clearAttachments();
    autoGrow();
    App.setStreaming(true);
    if (state.rebuilding) {
      App.addSystemNote("正在准备会话，首条回复稍候…");
    }

    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: sendText }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      App.addSystemNote("发送失败：" + (j.error || r.status));
      App.setStreaming(false);
    }
  };

  // ── 停止 / 发送按钮 ──
  sendBtn.addEventListener("click", (e) => {
    if (state.streaming) {
      navigator.sendBeacon("/api/abort");
      App.setStreaming(false);
      return;
    }
    App.sendMessage();
  });
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      App.sendMessage();
    }
  });

  function autoGrow() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
  }
  App.autoGrow = autoGrow;
  inputEl.addEventListener("input", autoGrow);

  // ── 加载历史 ──
  App.loadHistory = async function(path) {
    state.currentAssistantEl = null;
    state.currentTextDiv = null;
    state.pendingTexts = [];
    state.processEl = null;
    state.currentThinkSeg = null;
    state.toolCards.clear();
    try {
      const url = path ? "/api/history?path=" + encodeURIComponent(path) : "/api/history";
      const r = await fetch(url);
      const j = await r.json();
      if (!j.success) return;
      App.renderMessageList(j.data.messages || []);
    } catch (e) {
      App.addSystemNote("加载历史失败：" + (e?.message || "未知错误"));
      return;
    }
    App.scrollToBottom(true);
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
