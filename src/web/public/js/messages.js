/**
 * 消息渲染 — 气泡、过程卡片、系统提示
 */
"use strict";

(function() {
  const App = window.SapBuddy;
  const state = App.state;
  const $ = App.$;

  const messagesEl = $("#messages");

  // ── 智能滚动 ──
  let autoScroll = true;
  let scrollRaf = 0;

  function isNearBottom() {
    // 阈值收紧：几乎贴底才自动跟随，用户稍微上滚就退出，避免流式输出时被反复拉回
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;
  }

  messagesEl.addEventListener("scroll", () => {
    autoScroll = isNearBottom();
    if (!autoScroll && scrollRaf) {
      // 用户上滚离开底部：取消待执行的强制到底，防止下一帧把滚动拉回底
      cancelAnimationFrame(scrollRaf);
      scrollRaf = 0;
    }
  });

  // 滚动跟随合并到每帧一次：流式高频更新时避免反复强制 scrollTop 造成抖动/卡死
  App.scrollToBottom = function(force) {
    if (!force && !autoScroll) return;
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      if (force || autoScroll) messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  };

  // ── 用户气泡 ──
  // 精简附件消息：把「【用户附带的文件…】- name → path」转为文件名（历史兼容）
  function simplifyAttachmentText(text) {
    if (!text || !text.includes("【用户附带的文件")) return text;
    const idx = text.indexOf("【用户附带的文件");
    const prefix = text.slice(0, idx).trimEnd();
    const body = text.slice(idx);
    const names = body
      .split("\n")
      .filter((l) => l.trim().startsWith("- "))
      .map((l) => l.replace(/^- /, "").split(" → ")[0])
      .filter(Boolean);
    const attach = names.map((n) => n).join("\n");
    return (prefix ? prefix + "\n" : "") + attach;
  }

  App.addUserBubble = function(text) {
    const el = document.createElement("div");
    el.className = "msg user";
    el.innerHTML = '<div class="msg-content"><div class="meta">你</div><div class="body"></div></div>';
    el.querySelector(".body").textContent = simplifyAttachmentText(text);
    messagesEl.appendChild(el);
    App.scrollToBottom(true);
  };

  // ── Assistant 消息（ChatGPT/Claude 风格：思考 → 工具 → 回复 内联）──
  App.ensureAssistantBubble = function() {
    if (state.currentAssistantEl) return state.currentAssistantEl;
    const el = document.createElement("div");
    el.className = "msg agent";
    el.innerHTML =
      '<div class="avatar agent-avatar"><svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3z"/><circle cx="18.5" cy="18.5" r="1.3" fill="white" stroke="none"/></svg></div>' +
      '<div class="msg-content"><div class="meta">SapBuddy</div><div class="body md"></div></div>';
    messagesEl.appendChild(el);
    state.currentAssistantEl = el.querySelector(".body");
    state.currentAssistantEl._thinkWrap = null;   // 思考折叠区（Claude 风格）
    state.currentAssistantEl._toolsWrap = null;   // 工具调用链
    return state.currentAssistantEl;
  };

  // 思考折叠区（DeepSeek 风格：浅色圆角卡片，标题"深度思考"，默认收起）
  function ensureThinkWrap(container) {
    if (container._thinkWrap) return container._thinkWrap;
    const det = document.createElement("details");
    det.className = "agent-think";
    det.innerHTML = "<summary>思考过程</summary><div class='agent-think-body'></div>";
    det.open = false;
    container.prepend(det);
    container._thinkWrap = det;
    container._thinkLen = 0;
    return det;
  }

  // 思考字数（中英混合估算）
  function countChars(s) {
    if (!s) return 0;
    const cjk = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
    return cjk + Math.round((s.length - cjk) / 3);
  }

  function updateThinkSummary(det) {
    const tools = det.querySelectorAll(".tool-card").length;
    let label = "思考过程";
    if (tools) label += " · " + tools + " 个工具";
    det.querySelector("summary").textContent = label;
  }
  function containerText(det) {
    let t = "";
    det.querySelectorAll(".think-seg").forEach((s) => { t += s.textContent });
    return t;
  }

  // 工具卡插入到最后一个思考段之后（穿插显示，不堆积在末尾）
  function insertToolCardInterleaved(container, card) {
    const think = container._thinkWrap;
    if (think) {
      const body = think.querySelector(".agent-think-body");
      const segs = body.querySelectorAll(".think-seg");
      if (segs.length) body.insertBefore(card, segs[segs.length - 1].nextSibling);
      else body.appendChild(card);
    } else {
      ensureToolsWrap(container).appendChild(card);
    }
  }

  // 工具调用链：优先嵌入思考块内（Claude 风格），无思考时独立显示
  function ensureToolsWrap(container) {
    if (container._toolsWrap) return container._toolsWrap;
    let wrap = null
    // 有思考块 → 嵌入其 body（思考文本之后）
    if (container._thinkWrap) {
      const thinkBody = container._thinkWrap.querySelector(".agent-think-body");
      if (thinkBody) {
        wrap = document.createElement("div");
        wrap.className = "agent-tools";
        thinkBody.appendChild(wrap);
        container._toolsWrap = wrap;
        return wrap;
      }
    }
    // 无思考块 → 独立工具区（消息内，文本前）
    wrap = document.createElement("div");
    wrap.className = "agent-tools";
    const think = container._thinkWrap;
    if (think && think.nextSibling) container.insertBefore(wrap, think.nextSibling);
    else container.appendChild(wrap);
    container._toolsWrap = wrap;
    return wrap;
  }

  App.addToolCallToAgent = function(id, name, args) {
    const container = state.currentAssistantEl;
    if (!container) return;
    if (state.currentAssistantEl) state.currentAssistantEl.classList.remove("typing");
    const card = App.createToolCard(id, name, args);
    insertToolCardInterleaved(container, card);
    // 有工具时展开思考块（实时可见执行状态）
    if (container._thinkWrap) {
      container._thinkWrap.open = true;
      updateThinkSummary(container._thinkWrap);
    }
    App.scrollToBottom();
  };

  /** 收起思考面板（agent 输出结束后调用） */
  App.collapseThinkPanels = function() {
    const c = state.currentAssistantEl;
    if (c && c._thinkWrap) c._thinkWrap.open = false;
  };

  // ── 思考内容（内联到助手消息）──
  App.addThinking = function(text, beforeEl) {
    if (!text) return;
    const container = state.currentAssistantEl;
    if (!container) return;
    const det = ensureThinkWrap(container);
    const body = det.querySelector(".agent-think-body");
    if (!state.currentThinkSeg) {
      state.currentThinkSeg = document.createElement("div");
      state.currentThinkSeg.className = "think-seg";
      body.appendChild(state.currentThinkSeg);
    }
    state.currentThinkSeg.textContent = text;
    updateThinkSummary(det);
    App.scrollToBottom();
  };

  // ── 流式光标：确保文本 div 末尾有闪烁光标 span（DeepSeek 打字机感） ──
  function ensureStreamCursor(div) {
    if (!div._cursor || !div._cursor.isConnected) {
      const c = document.createElement("span");
      c.className = "stream-cursor";
      div.appendChild(c);
      div._cursor = c;
    }
    return div._cursor;
  }

  // ── 渲染 assistant 内容（流式输出时增量更新，避免全量 markdown 重绘） ──
  App.renderAssistantContent = function(container, contentParts) {
    const bubbleEl = container.closest(".msg");
    const parts = typeof contentParts === "string" ? [{ type: "text", text: contentParts }] : (contentParts || []);
    // thinking 与 toolCall 按原始顺序穿插（工具卡跟随对应思考段），text 统一最后渲染
    const textParts = [];
    for (const part of parts) {
      if (part.type === "text" && part.text) textParts.push(part);
      else if (part.type === "thinking" && part.thinking) App.addThinking(part.thinking, bubbleEl);
      else if (part.type === "toolCall") {
        const card = App.createToolCard(part.id, part.name, part.arguments);
        const summary = App.summarizeArgs(part.arguments);
        if (summary) card.querySelector(".tool-args").textContent = summary;
        insertToolCardInterleaved(container, card);
      }
    }
    for (const part of textParts) {
        if (!state.currentTextDiv) {
          state.currentTextDiv = document.createElement("div");
          container.appendChild(state.currentTextDiv);
          state.pendingTexts.push(state.currentTextDiv);
          state.currentTextDiv._renderedLen = 0;
        }
        const div = state.currentTextDiv;
        // 保存完整原始 markdown 文本（流结束后用全文做一次完整渲染）
        div._fullText = part.text;
        if (!state.streaming) {
          // 非流式：直接全量渲染
          App.mountMarkdown(div, part.text, { highlight: true });
          div._renderedLen = part.text.length;
        } else if (div._renderedLen === 0) {
          // 流式首段：markdown 渲染，保证代码块等初始格式正确（不高亮，避免流式中破坏结构）
          App.mountMarkdown(div, part.text);
          div._renderedLen = part.text.length;
          ensureStreamCursor(div);
        } else if (part.text.length > div._renderedLen) {
          // 流式增长：只追加增量纯文本（轻量），避免全量重绘
          ensureStreamCursor(div);
          div.insertBefore(document.createTextNode(part.text.slice(div._renderedLen)), div._cursor);
          div._renderedLen = part.text.length;
        } else if (part.text.length < div._renderedLen) {
          // 文本变短（模型改写）：重置偏移，下一轮从首段重渲，避免切片错位；
          // 不在这里直接重渲，防止流式中反复全量 innerHTML 让滚动高度振荡
          div._renderedLen = 0;
        }
        // 流式中文本持平：不动作，等流结束统一渲染（div._fullText 已更新）
    }
    updateBubbleVisibility(container);
    App.scrollToBottom();
  };

  function updateBubbleVisibility(container) {
    const bubble = container.closest(".msg");
    if (!bubble) return;
    const empty = container.children.length === 0 && !container.classList.contains("typing");
    bubble.classList.toggle("empty-bubble", empty);
  }

  // ── 回复合并（流式结束后做最终 markdown 渲染） ──
  App.consolidateAssistantReplies = function() {
    if (!state.currentAssistantEl || state.pendingTexts.length <= 1) {
      // 单段也做最终渲染
      const d = state.currentAssistantEl && state.pendingTexts[0];
      if (d && !d._finalized && d._renderedLen > 0) {
        const fullText = d._fullText || d.textContent;
        App.mountMarkdown(d, fullText, { highlight: true });
        d._cursor = null;
        d._finalized = true;
      }
      if (state.currentAssistantEl) updateBubbleVisibility(state.currentAssistantEl);
      App.scrollToBottom();
      return;
    }
    const lastIdx = state.pendingTexts.length - 1;
    // 合并所有文本段为完整 markdown
    const merged = state.pendingTexts.map((d) => d._fullText || d.textContent).join("\n\n");
    const lastDiv = state.pendingTexts[lastIdx];
    if (lastDiv) {
      App.mountMarkdown(lastDiv, merged, { highlight: true });
      lastDiv._cursor = null;
      lastDiv._finalized = true;
    }
    for (let i = 0; i < lastIdx; i++) state.pendingTexts[i].remove();
    state.pendingTexts = [lastDiv];
    updateBubbleVisibility(state.currentAssistantEl);
    App.scrollToBottom();
  };

  // ── 系统提示 ──
  App.addSystemNote = function(text) {
    const el = document.createElement("div");
    el.className = "msg system-note";
    el.textContent = text;
    messagesEl.appendChild(el);
    App.scrollToBottom();
  };

  // ── 生成中断提示 + 继续按钮 ──
  // 当 assistant 消息被 SDK 标 terminated（模型接口超时/中断）时，
  // 会话会遗留一条不完整的半截消息，前端若无入口就会表现为"卡住"。
  // 这里插入提示条 + 一键继续，让用户可让 AI 从断点接着写。
  App.onGenerationInterrupted = function() {
    if (messagesEl.querySelector(".interruption-note")) return; // 已提示则不再重复
    const el = document.createElement("div");
    el.className = "msg system-note interruption-note";
    el.appendChild(document.createTextNode(
      "⚠ 本次生成被模型接口中断（深度思考耗时过长或接口超时），AI 已写入部分内容。可点击下方按钮让其接着写："
    ));
    const btn = document.createElement("button");
    btn.className = "continue-btn";
    btn.type = "button";
    btn.textContent = "继续生成 ▶";
    btn.style.marginTop = "6px";
    btn.style.padding = "6px 14px";
    btn.style.background = "#6366f1";
    btn.style.color = "#fff";
    btn.style.border = "none";
    btn.style.borderRadius = "6px";
    btn.style.cursor = "pointer";
    btn.style.fontSize = "13px";
    btn.addEventListener("click", () => {
      el.remove();
      window.SapBuddy.sendMessage("请继续刚才的回答，从上次中断的地方接着写下去");
    });
    el.appendChild(document.createElement("br"));
    el.appendChild(btn);
    messagesEl.appendChild(el);
    App.scrollToBottom();
  };

  // ── 清屏 ──
  App.clearChat = function() {
    messagesEl.innerHTML = "";
    state.currentAssistantEl = null;
    state.currentTextDiv = null;
    state.pendingTexts = [];
    state.toolCards.clear();
    state.processEl = null;
    state.currentThinkSeg = null;
    App.setStreaming(false);
  };

  // ── 渲染消息列表 ──
  App.renderMessageList = function(messages) {
    let lastWasAssistant = false; // 同一轮次（相邻 assistant 无 user 间隔）复用气泡，避免刷屏
    for (const msg of messages) {
      if (msg.role === "user") {
        lastWasAssistant = false;
        const text = (msg.content || []).map((c) => c.text || "").join("");
        if (text) {
          App.addUserBubble(text);
          state.currentAssistantEl = null;
          state.currentTextDiv = null;
          state.pendingTexts = [];
          state.currentThinkSeg = null;
          state.processEl = null;
        }
      } else if (msg.role === "assistant") {
        // 跳过空 assistant 消息（无内容不产生气泡）
        if (!msg.content || (Array.isArray(msg.content) && msg.content.length === 0)) continue;
        state.currentTextDiv = null;
        state.currentThinkSeg = null;
        // 同一轮次（上一条是 assistant）复用同一气泡：思考/工具/文本按序合并进一个气泡
        if (!lastWasAssistant) {
          state.currentAssistantEl = null;
        }
        lastWasAssistant = true;
        const body = App.ensureAssistantBubble();
        App.renderAssistantContent(body, msg.content);
      } else if (msg.role === "toolResult") {
        App.finishToolCard(msg.toolCallId, msg.content, msg.isError);
      }
    }
    // 检测最后一条 assistant 消息是否被中断（terminated），提示用户可继续，
    // 解决"刷新页面后看到半截消息、对话卡住不继续"的问题。
    const _last = messages[messages.length - 1];
    if (_last && _last.role === "assistant" &&
        (_last.stopReason === "error" || _last.errorMessage === "terminated")) {
      App.onGenerationInterrupted();
    }
    // 合并同轮多段 assistant 文本为一段 markdown（历史渲染也不刷屏）
    if (state.currentAssistantEl && state.pendingTexts.length > 0) {
      App.consolidateAssistantReplies();
    }
    state.currentAssistantEl = null;
    state.currentTextDiv = null;
    state.pendingTexts = [];
    state.currentThinkSeg = null;
  };
})();
