/**
 * 对话业务适配层。React only owns #messages and #send-control-root;
 * this module keeps history, scroll, and message actions on the existing App API.
 */
"use strict";

(function() {
  const App = window.SapBuddy;
  const state = App.state;
  const $ = App.$;
  const messagesEl = $("#messages");
  const chatView = App.chatView;

  // ── 滚动跟随 ──
  let autoScroll = true;
  let scrollRaf = 0;
  let previousTop = messagesEl.scrollTop;
  let previousHeight = messagesEl.scrollHeight;
  const scrollBottomBtn = document.createElement("button");
  scrollBottomBtn.className = "scroll-bottom-btn";
  scrollBottomBtn.title = "回到底部";
  scrollBottomBtn.setAttribute("aria-label", "回到底部");
  scrollBottomBtn.textContent = "↓";
  scrollBottomBtn.addEventListener("click", () => App.scrollToBottom(true));
  const inputAreaEl = $("#input-area");
  if (inputAreaEl) inputAreaEl.appendChild(scrollBottomBtn);

  function isNearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <= 4;
  }

  function updateScrollButton() {
    scrollBottomBtn.classList.toggle("show", !isNearBottom());
  }
  function pauseScroll() {
    autoScroll = false;
    if (scrollRaf) cancelAnimationFrame(scrollRaf);
    scrollRaf = 0;
  }
  // Stop a queued follow immediately, before the browser applies the user's scroll.
  messagesEl.addEventListener("wheel", event => { if (event.deltaY < 0) pauseScroll(); }, { passive: true });
  let touchY = null;
  messagesEl.addEventListener("touchstart", event => { touchY = event.touches[0]?.clientY; }, { passive: true });
  messagesEl.addEventListener("touchmove", event => {
    const nextY = event.touches[0]?.clientY;
    if (touchY != null && nextY > touchY) pauseScroll();
    touchY = nextY;
  }, { passive: true });
  messagesEl.addEventListener("keydown", event => {
    if (event.target.closest("input, textarea, [contenteditable='true']")) return;
    if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) pauseScroll();
  });
  messagesEl.addEventListener("scroll", () => {
    const top = messagesEl.scrollTop;
    const height = messagesEl.scrollHeight;
    if (isNearBottom()) autoScroll = true;
    else if (top < previousTop && height === previousHeight) pauseScroll();
    previousTop = top;
    previousHeight = height;
    updateScrollButton();
  });

  App.scrollToBottom = function(force) {
    if (force) autoScroll = true;
    if (state.historyLoading || !autoScroll) { updateScrollButton(); return; }
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        if (autoScroll && !state.historyLoading) {
          messagesEl.scrollTop = messagesEl.scrollHeight;
          previousTop = messagesEl.scrollTop;
          previousHeight = messagesEl.scrollHeight;
        }
        updateScrollButton();
      });
    });
  };

  // Observe committed React content and delayed layout changes (images, code, resizing).
  const resized = new Set();
  const resizeObserver = new ResizeObserver(() => App.scrollToBottom());
  resizeObserver.observe(messagesEl);
  new MutationObserver(() => {
    for (const element of resized) if (element.parentElement !== messagesEl) { resizeObserver.unobserve(element); resized.delete(element); }
    for (const element of messagesEl.children) if (!resized.has(element)) { resizeObserver.observe(element); resized.add(element); }
    App.scrollToBottom();
  }).observe(messagesEl, { childList: true, subtree: true, characterData: true });

  App.resetAutoScroll = function() {
    autoScroll = true;
    App.scrollToBottom(true);
  };
  App.captureScroll = function() {
    const rect = messagesEl.getBoundingClientRect();
    const anchor = [...messagesEl.querySelectorAll("[data-item-id]")].find(el => el.getBoundingClientRect().bottom > rect.top);
    return { following: autoScroll, top: messagesEl.scrollTop, id: anchor?.dataset.itemId,
      offset: anchor ? anchor.getBoundingClientRect().top - rect.top : 0 };
  };
  App.restoreScroll = function(saved) {
    if (!saved || saved.following) { App.resetAutoScroll(); return; }
    pauseScroll();
    const anchor = saved.id && [...messagesEl.querySelectorAll("[data-item-id]")].find(el => el.dataset.itemId === saved.id);
    messagesEl.scrollTop = anchor ? messagesEl.scrollTop + anchor.getBoundingClientRect().top - messagesEl.getBoundingClientRect().top - saved.offset : saved.top;
    previousTop = messagesEl.scrollTop; previousHeight = messagesEl.scrollHeight;
    updateScrollButton();
  };

  App.formatMessageTime = function(ts) {
    if (!ts) return "";
    const date = new Date(ts);
    const now = new Date();
    const hm = String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");
    if (date.toDateString() === now.toDateString()) return "今天 " + hm;
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return "昨天 " + hm;
    if (date.getFullYear() === now.getFullYear()) return (date.getMonth() + 1) + "月" + date.getDate() + "日 " + hm;
    return date.getFullYear() + "年" + (date.getMonth() + 1) + "月" + date.getDate() + "日 " + hm;
  };

  // ── React 状态适配 ──
  App.showWelcome = function() {};

  App.addUserBubble = function(text, images, attachments, timestamp) {
    chatView.appendUser(text, images, attachments, timestamp);
    App.scrollToBottom(true);
  };

  App.ensureAssistantBubble = function() {
    const body = chatView.addAssistantMessage({ timestamp: Date.now() }, true);
    if (body) state.currentAssistantEl = body;
    return body;
  };

  App.beginAssistantMessage = function(message, start = false) {
    const body = chatView.addAssistantMessage(message || {}, start);
    if (body) state.currentAssistantEl = body;
    return body;
  };

  App.renderAssistantContent = function(body, content) {
    chatView.updateAssistantContent(body, content);
    App.scrollToBottom();
  };

  App.addToolCallToAgent = function(id, name, args) {
    chatView.startTool(id, name, args);
    chatView.toolStarted(id, name, args, state.currentPath);
    App.scrollToBottom();
  };

  App.finishToolCard = function(id, result, isError, duration) {
    chatView.finishTool(id, result, isError, duration);
  };

  App.markToolCardsInterrupted = function() { chatView.interruptTools(); };
  App.finalizeAssistantBubble = function() { chatView.finishAssistant(); };
  App.consolidateAssistantReplies = function(usage, elapsed) { chatView.finishAssistant(usage, elapsed); };

  App.addConfirmation = function(payload) { chatView.addApproval(payload, "question"); App.scrollToBottom(); };
  App.addWriteApproval = function(payload) { chatView.addApproval(payload, "write"); App.scrollToBottom(); };
  App.setHistoryMore = function(value) { chatView.setHistoryMore(value); };

  App.addSystemNote = function(text) {
    chatView.addSystemNote(text);
    App.scrollToBottom();
  };

  App.showWaiting = function(text) {
    chatView.setWaiting(text || "等待模型响应…");
    App.scrollToBottom();
  };

  App.showRetrying = function(text) {
    chatView.setWaiting(text || "正在重试…", true);
  };

  App.hideWaiting = function() { chatView.hideWaiting(); };

  App.friendlyErrorMessage = function(raw) {
    const message = String(raw || "");
    if (/do not support image|not support image|does not support image|image_url|unsupported image|image input/i.test(message)) {
      return "⚠ 当前模型不支持图片输入，发图片会失败。请到「设置-大模型」换成支持图片的模型，或改发纯文字。";
    }
    if (message === "terminated") return "⚠ 本次生成被模型接口中断（深度思考耗时过长或接口超时），AI 已写入部分内容。可点击下方按钮让其接着写：";
    return message.trim() ? "⚠ 生成出错：" + message : "⚠ 生成出错，请重试。";
  };

  let interruptionNoteId = null;
  let generationErrorId = null;
  App.onGenerationError = function(error) {
    if (generationErrorId) chatView.remove(generationErrorId);
    generationErrorId = chatView.addSystemNote(App.friendlyErrorMessage(error), "error");
    App.scrollToBottom();
  };

  App.clearGenerationError = function() {
    if (!generationErrorId) return;
    chatView.remove(generationErrorId);
    generationErrorId = null;
  };

  App.onGenerationInterrupted = function() {
    if (interruptionNoteId && document.querySelector(`[data-item-id="${CSS.escape(interruptionNoteId)}"]`)) return;
    interruptionNoteId = chatView.addSystemNote(App.friendlyErrorMessage("terminated"), "interrupted");
    App.scrollToBottom();
  };

  App.clearChat = function() {
    App.cancelHistoryLoad?.();
    state.historyUserOffset = 0;
    state.currentAssistantEl = null;
    interruptionNoteId = null;
    generationErrorId = null;
    autoScroll = true;
    chatView.clear();
    App.setStreaming(false);
  };

  App.renderMessageList = function(messages, options = {}) {
    chatView.replaceHistory(messages, {
      prepend: options.prepend === true,
      userOffset: options.userOffset ?? state.historyUserOffset ?? 0,
      live: options.live === true,
    });
    if (!options.prepend) {
      state.currentAssistantEl = options.live ? chatView.activeAssistant() : null;
      interruptionNoteId = null;
      generationErrorId = null;
    }
    state.messageCount = (messages || []).filter((message) => message?.role === "user" || message?.role === "assistant").length;
    const last = (messages || []).at(-1);
    if (!options.live && last?.role === "assistant") {
      if (last.errorMessage === "terminated") App.onGenerationInterrupted();
      else if (last.stopReason === "error" || last.errorMessage) App.onGenerationError(last.errorMessage || last.stopReason);
    }
  };

  // ── 消息操作 ──
  function getMsgText(msgEl) {
    const body = msgEl?.querySelector(".body");
    if (!body) return "";
    const replies = Array.from(body.querySelectorAll(".reply-text"));
    return replies.length ? replies.map((reply) => reply.textContent || "").join("\n") : body.textContent || "";
  }

  function getMsgImages(msgEl) {
    return Array.from(msgEl?.querySelectorAll(".body img.msg-img") || []).flatMap((image) => {
      const match = (image.src || "").match(/^data:([^;]+);base64,(.+)$/);
      return match ? [{ mimeType: match[1], data: match[2] }] : [];
    });
  }

  function getMsgAttachments(msgEl) {
    if (msgEl?._attachments?.length) return msgEl._attachments;
    const text = getMsgText(msgEl);
    if (!text.includes("【用户附带的文件")) return [];
    return text.slice(text.indexOf("【用户附带的文件")).split("\n").flatMap((line) => {
      const entry = line.trim().replace(/^- /, "");
      const [name, ...location] = entry.split(" → ");
      return line.trim().startsWith("- ") && name && location.length ? [{ name: name.trim(), path: location.join(" → ").trim() }] : [];
    });
  }

  function findUserMsgForAgent(agentEl) {
    let previous = agentEl?.previousElementSibling;
    while (previous) {
      if (previous.classList.contains("msg") && previous.classList.contains("user")) return previous;
      previous = previous.previousElementSibling;
    }
    return null;
  }

  function findAgentMsgForUser(userEl) {
    let next = userEl?.nextElementSibling;
    while (next) {
      if (next.classList.contains("msg") && next.classList.contains("agent")) return next;
      next = next.nextElementSibling;
    }
    return null;
  }

  async function truncateFromUserMsg(userEl) {
    const userMessages = Array.from(messagesEl.querySelectorAll(".msg.user"));
    const localIndex = userMessages.indexOf(userEl);
    if (localIndex < 0 || !state.currentPath) return false;
    const keepUserCount = userEl.dataset.userIndex != null
      ? Number(userEl.dataset.userIndex)
      : localIndex + (state.historyUserOffset || 0);
    try {
      const response = await fetch("/api/session/truncate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: state.currentPath, keepUserCount }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.success) {
        App.addSystemNote("截断会话失败：" + (result.error || response.status));
        return false;
      }
    } catch (error) {
      App.addSystemNote("截断会话失败（网络异常）:" + error.message);
      return false;
    }
    chatView.removeFrom(userEl.dataset.itemId);
    return true;
  }

  async function regenerateMsg(agentEl) {
    if (state.streaming) { App.addSystemNote("当前正在生成中，请先停止或等待完成。"); return; }
    const userEl = findUserMsgForAgent(agentEl);
    if (!userEl) { App.addSystemNote("未找到对应的用户消息，无法重新生成。"); return; }
    const text = getMsgText(userEl);
    const images = getMsgImages(userEl);
    const attachments = getMsgAttachments(userEl);
    if (!text && !images.length && !attachments.length) { App.addSystemNote("用户消息为空，无法重新生成。"); return; }
    if (await truncateFromUserMsg(userEl)) App.sendMessage(text, { images, attachments });
  }

  async function submitEditedMessage(userEl, text) {
    if (state.streaming) { App.addSystemNote("当前正在生成中，请先停止或等待完成。"); return; }
    const images = getMsgImages(userEl);
    const attachments = getMsgAttachments(userEl);
    const value = String(text || "").trim();
    if (!value && !images.length && !attachments.length) return;
    if (await truncateFromUserMsg(userEl)) App.sendMessage(value, { images, attachments });
  }

  App.submitEditedMessage = function(id, text) {
    const userEl = messagesEl.querySelector(`.msg.user[data-item-id="${CSS.escape(id)}"]`);
    if (userEl) submitEditedMessage(userEl, text);
  };

  function copyMsgText(msgEl) {
    const text = getMsgText(msgEl);
    if (text) App.copyText(text);
  }

  function deleteMsg(msgEl) {
    const removeIds = [msgEl.dataset.itemId];
    if (msgEl.classList.contains("user")) {
      const agent = findAgentMsgForUser(msgEl);
      if (agent?.dataset.itemId) removeIds.push(agent.dataset.itemId);
    }
    removeIds.forEach((id) => id && chatView.remove(id));
    App.addSystemNote("已从当前视图删除该消息（刷新页面后会从历史记录重新加载）。");
  }

  function getConversationPairs() {
    const pairs = [];
    let current = null;
    messagesEl.querySelectorAll(".msg").forEach((element) => {
      if (element.classList.contains("user")) {
        if (current) pairs.push(current);
        current = { userEl: element, userText: element.querySelector(".body")?.textContent || "(空)", agentEls: [], agentText: "" };
      } else if (element.classList.contains("agent") && current) {
        current.agentEls.push(element);
        const text = element.querySelector(".body")?.textContent || "";
        if (!current.agentText && text) current.agentText = text;
      }
    });
    if (current) pairs.push(current);
    return pairs;
  }

  function showDeleteDialog(msgEl) {
    const pairs = getConversationPairs();
    if (!pairs.length) return;
    const selected = new Set([pairs.findIndex((pair) => pair.userEl === msgEl || pair.agentEls.includes(msgEl))].filter((index) => index >= 0));
    const overlay = document.createElement("div");
    overlay.className = "delete-dialog-overlay";
    overlay.innerHTML = '<div class="delete-dialog"><div class="delete-dialog-header"><span class="delete-dialog-title">选择对话</span><button class="delete-dialog-cancel" title="取消">取消</button></div><div class="delete-dialog-list"></div><div class="delete-dialog-footer"><span class="delete-dialog-count">已选 0 项</span><button class="delete-dialog-confirm btn-danger" disabled>删除</button></div></div>';
    document.body.appendChild(overlay);
    const list = overlay.querySelector(".delete-dialog-list");
    const count = overlay.querySelector(".delete-dialog-count");
    const confirm = overlay.querySelector(".delete-dialog-confirm");
    pairs.forEach((pair, index) => {
      const label = document.createElement("label");
      label.className = "delete-dialog-item";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selected.has(index);
      checkbox.className = "delete-dialog-checkbox";
      const preview = document.createElement("div");
      preview.className = "delete-dialog-item-content";
      const user = document.createElement("div");
      user.className = "delete-dialog-user";
      user.textContent = pair.userText.slice(0, 50);
      preview.appendChild(user);
      if (pair.agentText) {
        const agent = document.createElement("div");
        agent.className = "delete-dialog-agent";
        agent.textContent = pair.agentText.slice(0, 80);
        preview.appendChild(agent);
      }
      label.append(checkbox, preview);
      checkbox.addEventListener("change", () => {
        checkbox.checked ? selected.add(index) : selected.delete(index);
        label.classList.toggle("selected", checkbox.checked);
        count.textContent = "已选 " + selected.size + " 项";
        confirm.disabled = selected.size === 0;
      });
      label.classList.toggle("selected", selected.has(index));
      list.appendChild(label);
    });
    count.textContent = "已选 " + selected.size + " 项";
    confirm.disabled = selected.size === 0;
    overlay.querySelector(".delete-dialog-cancel").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (event) => { if (event.target === overlay) overlay.remove(); });
    confirm.addEventListener("click", async () => {
      if (!selected.size || !state.currentPath) return;
      confirm.disabled = true;
      confirm.textContent = "删除中…";
      try {
        const response = await fetch("/api/session/delete-messages", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: state.currentPath, userIndices: Array.from(selected, (index) => {
            const item = pairs[index].userEl;
            return item.dataset.userIndex != null ? Number(item.dataset.userIndex) : index + (state.historyUserOffset || 0);
          }) }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.success) throw new Error(result.error || response.status);
        overlay.remove();
        App.clearChat();
        App.loadHistory(state.currentPath);
        App.addSystemNote("已删除 " + selected.size + " 组对话");
      } catch (error) {
        App.addSystemNote("删除失败：" + (error?.message || error));
        confirm.disabled = false;
        confirm.textContent = "删除";
      }
    });
  }

  messagesEl.addEventListener("click", (event) => {
    const button = event.target.closest(".msg-action-btn");
    if (!button) return;
    event.stopPropagation();
    const message = button.closest(".msg");
    if (!message) return;
    if (event.defaultPrevented) return;
    switch (button.dataset.action) {
      case "copy": copyMsgText(message); break;
      case "delete": showDeleteDialog(message); break;
      case "regenerate": regenerateMsg(message); break;
      case "edit": window.dispatchEvent(new CustomEvent("sapbuddy:edit-message", { detail: { id: message.dataset.itemId } })); break;
    }
  });
})();
