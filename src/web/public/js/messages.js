/**
 * 消息渲染 — 气泡、过程卡片、系统提示
 */
"use strict";

(function() {
  const App = window.SapBuddy;
  const state = App.state;
  const $ = App.$;

  const messagesEl = $("#messages");

  // ── 智能滚动 + 回到底部按钮 ──
  let autoScroll = true;
  let scrollRaf = 0;

  // 回到底部按钮（类似豆包工作，用户上滚后显示）
  const scrollBottomBtn = document.createElement("button");
  scrollBottomBtn.className = "scroll-bottom-btn";
  scrollBottomBtn.title = "回到底部";
  scrollBottomBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>';
  scrollBottomBtn.addEventListener("click", () => {
    App.scrollToBottom(true);
  });
  const chatEl = $("#chat");
  const inputAreaEl = $("#input-area");
  if (inputAreaEl) inputAreaEl.appendChild(scrollBottomBtn);
  else if (chatEl) chatEl.appendChild(scrollBottomBtn);

  function isNearBottom() {
    // 阈值收紧：几乎贴底才自动跟随，用户稍微上滚就退出，避免流式输出时被反复拉回
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;
  }

  messagesEl.addEventListener("scroll", () => {
    autoScroll = isNearBottom();
    // 回到底部按钮：不在底部时显示，在底部时隐藏
    if (scrollBottomBtn) {
      scrollBottomBtn.classList.toggle("show", !autoScroll);
    }
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

  // 每次提问都恢复"到底自动跟随"：防止上滚/换对话后 autoScroll 残留为关闭，
  // 导致第二次对话时滚动条停在原地不跟着 LLM 输出走
  App.resetAutoScroll = function() {
    autoScroll = true;
    App.scrollToBottom(true);
  };

  // ── 思考面板智能滚动 ──
  // 与 #messages 独立：思考面板内部可滚动（max-height 520px），流式中跟随底部看最新输出；
  // 用户上滚则停止跟随，拉回底部后恢复。每个 think-body 独立记录 atBottom。
  const thinkScrollState = new WeakMap();
  const THINK_NEAR_BOTTOM = 30;
  function thinkIsNearBottom(body) {
    return body.scrollHeight - body.scrollTop - body.clientHeight < THINK_NEAR_BOTTOM;
  }
  function scrollThinkBody(body) {
    if (!body || !state.streaming) return; // 仅流式中自动跟随；历史渲染不动滚动位置
    if (!autoScroll) return; // 用户已滚离主视图底部（如上滚看历史）：不再强制面板跟随底部，避免与用户意图打架
    const st = thinkScrollState.get(body);
    if (st && !st.atBottom) return; // 用户上滚过：不强制拉回底部
    body.scrollTop = body.scrollHeight;
  }
  document.addEventListener(
    "scroll",
    (e) => {
      const body = e.target;
      if (!body || !(body instanceof Element) || !body.classList || !body.classList.contains("agent-think-body")) return;
      const st = thinkScrollState.get(body) || {};
      st.atBottom = thinkIsNearBottom(body);
      thinkScrollState.set(body, st);
    },
    true
  );

  // 思考面板内部是独立滚动区（max-height 520px + overflow-y auto），长思考内容可达上万像素。
  // 鼠标在面板上滚动时，面板内部优先自己滚；滚到面板边界后，继续的滚轮转给主滚动条（滚动链），
  // 既不吞掉主滚动条（外面卡住），也保证面板内部内容能正常滚到（旧实现 autoScroll=false 时
  // 把面板上所有滚轮都转给主滚动条，导致面板内部永远滚不动）。
  document.addEventListener(
    "wheel",
    (e) => {
      const t = e.target;
      if (!t || !(t instanceof Element) || !t.closest(".agent-think-body")) return;
      const body = t.closest(".agent-think-body");
      const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight <= 2;
      const atTop = body.scrollTop <= 0;
      if ((e.deltaY > 0 && !atBottom) || (e.deltaY < 0 && !atTop)) return; // 面板内部还能滚 → 交给面板
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? messagesEl.clientHeight : 1;
      messagesEl.scrollTop += e.deltaY * unit;
    },
    { passive: false, capture: true }
  );

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

  // 从完整文本中解析附件信息（格式：【用户附带的文件...】\n- name → path）
  function parseAttachmentsFromText(text) {
    if (!text || !text.includes("【用户附带的文件")) return [];
    const idx = text.indexOf("【用户附带的文件");
    const body = text.slice(idx);
    const atts = [];
    body.split("\n").forEach((l) => {
      const trimmed = l.trim();
      if (trimmed.startsWith("- ")) {
        const parts = trimmed.replace(/^- /, "").split(" → ");
        if (parts.length >= 2 && parts[0] && parts[1]) {
          atts.push({ name: parts[0].trim(), path: parts.slice(1).join(" → ").trim() });
        }
      }
    });
    return atts;
  }

  // ── 消息时间格式化：毫秒时间戳 → 今天/昨天/日期 + 时分 ──
  App.formatMessageTime = function(ts) {
    if (!ts) return "";
    const date = new Date(ts);
    const now = new Date();
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    const timeStr = hh + ":" + mm;
    // 今天
    if (date.toDateString() === now.toDateString()) {
      return "今天 " + timeStr;
    }
    // 昨天
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) {
      return "昨天 " + timeStr;
    }
    // 今年
    if (date.getFullYear() === now.getFullYear()) {
      return (date.getMonth() + 1) + "月" + date.getDate() + "日 " + timeStr;
    }
    // 其他年份
    return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0") + " " + timeStr;
  };
  // 兼容局部调用
  function formatMessageTime(ts) { return App.formatMessageTime(ts); }

  // ── Tokens 格式化：大数字用 k 表示 ──
  function formatTokens(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(2) + "M";
    if (n >= 1000) return (n / 1000).toFixed(2) + "k";
    return String(n);
  }

  App.addUserBubble = function(text, images, attachments, timestamp) {
    const el = document.createElement("div");
    el.className = "msg user";
    el._attachments = attachments || []; // 存储附件数据，供编辑重发/重新生成使用
    el.innerHTML =
      '<div class="msg-content">' +
        '<div class="meta">你</div>' +
        '<div class="body"></div>' +
        '<div class="msg-footer">' +
          '<span class="msg-time"></span>' +
          '<div class="msg-actions">' +
          '<button class="msg-action-btn" data-action="copy" title="复制">' +
            '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
          '</button>' +
          '<button class="msg-action-btn" data-action="edit" title="编辑并重发">' +
            '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>' +
          '</button>' +
          '<button class="msg-action-btn" data-action="delete" title="删除">' +
            '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>' +
          '</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    const body = el.querySelector(".body");
    if (text) body.textContent = simplifyAttachmentText(text);
    for (const img of images || []) {
      const im = document.createElement("img");
      im.className = "msg-img";
      im.alt = "图片";
      im.src = "data:" + img.mimeType + ";base64," + img.data;
      body.appendChild(im);
    }
    // 设置时间
    if (timestamp) {
      el.querySelector(".msg-time").textContent = formatMessageTime(timestamp);
    }
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
      '<div class="msg-content">' +
        '<div class="meta">SapBuddy</div>' +
        '<div class="body md"></div>' +
        '<div class="msg-footer">' +
          '<div class="msg-actions">' +
          '<button class="msg-action-btn" data-action="copy" title="复制">' +
            '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
          '</button>' +
          '<button class="msg-action-btn" data-action="regenerate" title="重新生成">' +
            '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>' +
          '</button>' +
          '<button class="msg-action-btn" data-action="delete" title="删除">' +
            '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>' +
          '</button>' +
          '</div>' +
          '<span class="msg-tokens"></span>' +
          '<span class="msg-time"></span>' +
        '</div>' +
      '</div>';
    messagesEl.appendChild(el);
    state.currentAssistantEl = el.querySelector(".body");
    state.currentAssistantEl._thinkWrap = null;
    state.currentAssistantEl._toolsWrap = null;
    return state.currentAssistantEl;
  };

  // 思考折叠区（DeepSeek 风格：浅色圆角卡片，标题"深度思考"，默认收起）
  function ensureThinkWrap(container) {
    if (container._thinkWrap) return container._thinkWrap;
    const det = document.createElement("details");
    det.className = "agent-think";
    det.innerHTML = '<summary><svg class="think-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg><span class="think-label">思考过程</span></summary><div class="agent-think-body"></div>';
    det.open = false;
    container.prepend(det);
    container._thinkWrap = det;
    container._thinkLen = 0;
    const body = det.querySelector(".agent-think-body");
    // 流式中展开面板：直接跟到底部看最新输出
    det.addEventListener("toggle", () => {
      if (det.open && state.streaming) scrollThinkBody(body);
    });
    return det;
  }

  // 思考字数（中英混合估算）
  function countChars(s) {
    if (!s) return 0;
    const cjk = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
    return cjk + Math.round((s.length - cjk) / 3);
  }

  function updateThinkSummary(det) {
    // 工具已独立到分组容器，思考面板只显示思考字数
    const text = containerText(det);
    const chars = countChars(text);
    let label = "思考过程";
    if (chars > 0) label += " · " + chars + " 字";
    const labelEl = det.querySelector(".think-label");
    if (labelEl) labelEl.textContent = label;
    else det.querySelector("summary").textContent = label;
  }
  function containerText(det) {
    let t = "";
    det.querySelectorAll(".think-seg").forEach((s) => { t += s.textContent });
    return t;
  }

  // 工具调用条目直接内联到 assistant bubble body（豆包风格：与文本按原始顺序穿插，无分组容器）
  function ensureMsgToolsWrap(container) {
    container._curToolsWrap = container;
    return container;
  }

  App.addToolCallToAgent = function(id, name, args) {
    const container = state.currentAssistantEl;
    if (!container) return;
    if (state.currentAssistantEl) state.currentAssistantEl.classList.remove("typing");
    const card = App.createToolCard(id, name, args);
    if (!card.isConnected) container.appendChild(card);
    App.scrollToBottom();
  };

  /** 收起思考面板（agent 输出结束后调用） */
  App.collapseThinkPanels = function() {
    const c = state.currentAssistantEl;
    if (c && c._thinkWrap) c._thinkWrap.open = false;
  };

  /** 消息结束收尾：折叠所有内联思考块 + 最终回复完整 markdown 渲染 */
  App.finalizeAssistantBubble = function() {
    const c = state.currentAssistantEl;
    if (!c) return;
    // 折叠所有思考块
    c.querySelectorAll(".inline-think-wrap").forEach((det) => { det.open = false; });
    // 对最终回复文本进行完整 markdown 渲染（流式中只追加了纯文本增量）
    c.querySelectorAll(".reply-text").forEach((div) => {
      const fullText = div._fullText;
      if (fullText) {
        div.innerHTML = "";
        App.mountMarkdown(div, fullText, { highlight: true });
      }
    });
  };

  // ── 思考内容（内联到助手消息）──
  // 整个工具执行轮次的思考统一汇入一段连续文本流（think-flow），读起来是一整段，
  // 不再按消息切成多个带边框的独立块。每个消息的思考块用独立文本节点整体更新
  // （nodeValue 覆盖不重建 DOM，流式中不闪烁），工具卡按到达顺序穿插在文本之间。
  function ensureThinkFlow(container, body) {
    if (container._thinkFlow) return container._thinkFlow;
    const flow = document.createElement("div");
    flow.className = "think-seg think-flow";
    body.appendChild(flow);
    container._thinkFlow = flow;
    return flow;
  }

  // 把一段纯文本追加进思考流（中间叙述「我先读取…」等挪进思考区时使用）。
  // 若本消息已建工具区，叙述文本插到工具卡之前，保持 思考→叙述→工具 顺序。
  // 每条消息的叙述用独立文本节点整体覆盖（renderedLen 去重）：
  // 同一段叙述被 message_update 重复推送时不会再次插入 → 不会出现多份副本。
  function appendThinkText(container, raw) {
    if (!raw) return;
    const det = container._thinkWrap || ensureThinkWrap(container);
    const body = det.querySelector(".agent-think-body");
    const flow = ensureThinkFlow(container, body);
    let entry = container._curNarrationEntry;
    if (!entry) {
      const anchor = container._curToolsWrap && container._curToolsWrap.parentNode === flow ? container._curToolsWrap : null;
      entry = { node: document.createTextNode(""), renderedLen: 0, sep: flow.childNodes.length ? "\n" : "" };
      container._curNarrationEntry = entry;
      if (anchor) flow.insertBefore(entry.node, anchor);
      else flow.appendChild(entry.node);
    }
    if (raw.length !== entry.renderedLen) {
      entry.node.nodeValue = entry.sep + raw;
      entry.renderedLen = raw.length;
    }
  }

  // 当前消息已确认有工具调用 → 它输出的「叙述型」回复文本不属于最终答案。
  // 把这段文本从回复区挪进思考流，回复区只留最终答案，不再出现一行行的过程语句。
  App.moveMsgNarrationToThink = function() {
    const container = state.currentAssistantEl;
    if (!container) return;
    // 已确认本消息是中间步骤（有工具）→ 之后重复推送同一段文本时不再渲染到回复区
    container._curMsgNarrationMoved = true;
    const texts = container._curMsgTexts || [];
    container._curMsgTexts = [];
    for (const div of texts) {
      if (!div || !div.isConnected) continue;
      const raw = div._fullText || div.textContent;
      div.remove();
      // appendThinkText 内部按 renderedLen 去重：重复推送不会产生副本
      if (raw) appendThinkText(container, raw);
    }
    state.pendingTexts = state.pendingTexts.filter((d) => d.isConnected);
    if (state.currentTextDiv && !state.currentTextDiv.isConnected) state.currentTextDiv = null;
  };

  App.addThinking = function(text, segIdx, beforeEl) {
    if (!text) return;
    const container = state.currentAssistantEl;
    if (!container) return;
    const det = ensureThinkWrap(container);
    const body = det.querySelector(".agent-think-body");
    // LLM 输出中默认展开思考面板（agent_end 时收起）；历史渲染保持收起
    if (state.streaming) det.open = true;
    if (!container._thinkSegs) container._thinkSegs = [];
    let entry = container._thinkSegs[segIdx];
    if (!entry) {
      entry = { node: document.createTextNode(""), renderedLen: 0 };
      container._thinkSegs[segIdx] = entry;
      ensureThinkFlow(container, body).appendChild(entry.node);
    }
    if (text.length !== entry.renderedLen) {
      entry.node.nodeValue = text; // 同一文本节点整体覆盖：不闪烁
      entry.renderedLen = text.length;
    }
    updateThinkSummary(det);
    scrollThinkBody(body);
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

  // ── 内联文本块管理器（豆包风格穿插：思考/叙述/回复按序插入同一容器） ──
  // 每条消息重置 _inlineBlocks，按 key（类型+序号）匹配已渲染块，增量更新不闪烁
  function ensureInlineBlock(container, key, className) {
    if (!container._inlineBlocks) container._inlineBlocks = {};
    let entry = container._inlineBlocks[key];
    if (!entry) {
      const div = document.createElement("div");
      div.className = className;
      container.appendChild(div);
      entry = { el: div, renderedLen: 0 };
      container._inlineBlocks[key] = entry;
    }
    return entry;
  }

  // 内联思考块：可折叠 details，流式中默认展开，流结束后自动折叠
  function ensureInlineThinkBlock(container, key) {
    if (!container._inlineBlocks) container._inlineBlocks = {};
    let entry = container._inlineBlocks[key];
    if (!entry) {
      const det = document.createElement("details");
      det.className = "inline-think-wrap";
      det.open = state.streaming ? true : false; // 流式中展开，历史渲染收起
      det.innerHTML = '<summary class="inline-think-summary"><svg class="think-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg><span class="think-label">思考过程</span><span class="think-count"></span></summary><div class="inline-think-body"></div>';
      container.appendChild(det);
      const body = det.querySelector(".inline-think-body");
      entry = { el: det, body: body, renderedLen: 0 };
      container._inlineBlocks[key] = entry;
    }
    return entry;
  }

  // 最终回复 markdown 渲染（复用流式增量逻辑）
  function renderReplyMarkdown(entry, text) {
    const div = entry.el;
    div._fullText = text;
    if (!state.streaming) {
      App.mountMarkdown(div, text, { highlight: true });
      entry.renderedLen = text.length;
    } else if (entry.renderedLen === 0) {
      App.mountMarkdown(div, text);
      entry.renderedLen = text.length;
      ensureStreamCursor(div);
    } else if (text.length > entry.renderedLen) {
      ensureStreamCursor(div);
      div.insertBefore(document.createTextNode(text.slice(entry.renderedLen)), div._cursor);
      entry.renderedLen = text.length;
    } else if (text.length < entry.renderedLen) {
      entry.renderedLen = 0;
    }
  }

  // ── 渲染 assistant 内容（豆包风格：thinking/text/toolCall 按原始顺序内联穿插） ──
  App.renderAssistantContent = function(container, contentParts) {
    const bubbleEl = container.closest(".msg");
    const parts = typeof contentParts === "string" ? [{ type: "text", text: contentParts }] : (contentParts || []);
    const hasTools = parts.some((p) => p.type === "toolCall");

    // 按 content 数组原始顺序遍历：思考→叙述→工具→思考→工具→最终回复
    let partIdx = 0;
    for (const part of parts) {
      if (part.type === "thinking" && part.thinking) {
        // 思考文本：可折叠块，默认收起
        const entry = ensureInlineThinkBlock(container, "think-" + partIdx);
        if (part.thinking.length !== entry.renderedLen) {
          entry.body.textContent = part.thinking;
          entry.renderedLen = part.thinking.length;
          // 更新字数
          const countEl = entry.el.querySelector(".think-count");
          if (countEl) countEl.textContent = "· " + countChars(part.thinking) + " 字";
        }
      } else if (part.type === "text" && part.text) {
        // 用统一 key，hasTools 变化时自动切换类型并清理旧内容，避免重复显示
        const key = "text-" + partIdx;
        if (hasTools) {
          // 有工具调用时，text 是过程叙述：内联灰色小字纯文本
          const entry = ensureInlineBlock(container, key, "inline-narration");
          // 若之前渲染为最终回复，切换类名并清空
          if (entry.el.classList.contains("reply-text")) {
            entry.el.className = "inline-narration";
            entry.el.innerHTML = "";
            entry.renderedLen = 0;
          }
          if (part.text.length !== entry.renderedLen) {
            entry.el.textContent = part.text;
            entry.renderedLen = part.text.length;
          }
        } else {
          // 无工具调用时，text 是最终回复：正常 markdown
          const entry = ensureInlineBlock(container, key, "reply-text md");
          // 若之前渲染为叙述文本，切换类名并清空
          if (entry.el.classList.contains("inline-narration")) {
            entry.el.className = "reply-text md";
            entry.el.innerHTML = "";
            entry.renderedLen = 0;
          }
          renderReplyMarkdown(entry, part.text);
        }
      } else if (part.type === "toolCall") {
        // 工具调用：轻量行式（无卡片边框），直接内联
        const card = App.createToolCard(part.id, part.name, part.arguments);
        if (!card.isConnected) container.appendChild(card);
        const summary = App.summarizeArgs(part.arguments);
        if (summary) {
          const argsEl = card.querySelector(".invoke-args");
          if (argsEl) argsEl.textContent = summary;
        }
      }
      partIdx++;
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

  // ── 等待模型响应（提问后、首字输出前的空窗提示） ──
  // 避免用户提问后页面长时间"没反应"（模型首字慢/网络波动），
  // AI 开始渲染消息（message_start）时自动移除。
  App.showWaiting = function(text) {
    App.hideWaiting();
    const el = document.createElement("div");
    el.className = "msg waiting-note";
    el.innerHTML = '<span class="waiting-spinner"></span><span class="waiting-text"></span>';
    el.querySelector(".waiting-text").textContent = text || "等待模型响应…";
    messagesEl.appendChild(el);
    App.scrollToBottom(true);
  };
  App.hideWaiting = function() {
    const el = messagesEl.querySelector(".waiting-note");
    if (el) el.remove();
  };

  // ── 生成错误提示（模型接口明确拒绝，如图片不支持、参数错误） ──
  // 与"生成中断"区分：这类错误是模型明确拒绝，不需要"继续生成"按钮，
  // 而是把底层报错翻译成人话提示用户（如"这个模型不支持图片输入"）。
  App.friendlyErrorMessage = function(raw) {
    const s = String(raw || "");
    if (/do not support image|not support image|does not support image|image_url|unsupported image|image input/i.test(s)) {
      return "⚠ 当前模型不支持图片输入，发图片会失败。请到「设置-大模型」换成支持图片的模型，或改发纯文字。";
    }
    if (s === "terminated") {
      return "⚠ 本次生成被模型接口中断（深度思考耗时过长或接口超时），AI 已写入部分内容。可点击下方按钮让其接着写：";
    }
    if (!s.trim()) return "⚠ 生成出错，请重试。";
    return "⚠ 生成出错：" + s;
  };
  App.onGenerationError = function(errorMessage) {
    for (const sel of [".interruption-note", ".generation-error"]) {
      const old = messagesEl.querySelector(sel);
      if (old) old.remove();
    }
    const el = document.createElement("div");
    el.className = "msg system-note generation-error";
    el.textContent = App.friendlyErrorMessage(errorMessage);
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
    autoScroll = true; // 新对话/切换对话后恢复自动跟随，避免滚动条卡在原地
    App.setStreaming(false);
  };

  // ── 渲染消息列表 ──
  App.renderMessageList = function(messages) {
    let lastWasAssistant = false; // 同一轮次（相邻 assistant 无 user 间隔）复用气泡，避免刷屏
    const toolCallTimestamps = new Map(); // 记录 toolCallId -> 开始时间戳（用于历史会话耗时计算）
    for (const msg of messages) {
      if (msg.role === "user") {
        lastWasAssistant = false;
        const blocks = msg.content || [];
        const text = blocks.map((c) => (c.type === "text" ? c.text || "" : "")).join("");
        const images = blocks.filter((c) => c.type === "image" && c.data && c.mimeType);
        const attachments = parseAttachmentsFromText(text);
        if (text || images.length) {
          App.addUserBubble(text, images, attachments, msg.timestamp);
          state.currentAssistantEl = null;
          state.currentTextDiv = null;
          state.pendingTexts = [];
          state.currentThinkSeg = null;
          state.processEl = null;
        }
      } else if (msg.role === "assistant") {
        // 跳过空 assistant 消息（无内容不产生气泡）
        if (!msg.content || (Array.isArray(msg.content) && msg.content.length === 0)) continue;
        // 记录 toolCall 的开始时间戳（用于历史会话耗时计算）
        if (Array.isArray(msg.content)) {
          msg.content.forEach((block) => {
            if (block.type === "toolCall" && block.id && msg.timestamp) {
              toolCallTimestamps.set(block.id, msg.timestamp);
            }
          });
        }
        state.currentTextDiv = null;
        state.currentThinkSeg = null;
        // 同一轮次（上一条是 assistant）复用同一气泡：思考/工具/文本按序合并进一个气泡
        if (!lastWasAssistant) {
          state.currentAssistantEl = null;
        }
        lastWasAssistant = true;
        const body = App.ensureAssistantBubble();
        body._thinkSegs = []; // 每条消息的思考段独立（复用气泡时也重置）
        body._curMsgTexts = [];
        body._curToolsWrap = null;
        body._curMsgIntermediate = Array.isArray(msg.content) && msg.content.some((p) => p.type === "toolCall");
        body._curMsgNarrationMoved = false; // 叙述是否已判定进思考流（每消息重置）
        body._curNarrationEntry = null;     // 叙述文本节点（每消息重置）
        body._inlineBlocks = {};             // 内联文本块（每消息重置，按 key 匹配）
        App.renderAssistantContent(body, msg.content);
        // 设置AI消息的时间和tokens（找到.msg.agent元素）
        const agentMsgEl = body.closest(".msg.agent");
        if (agentMsgEl) {
          if (msg.timestamp) {
            const timeEl = agentMsgEl.querySelector(".msg-time");
            if (timeEl) timeEl.textContent = formatMessageTime(msg.timestamp);
          }
          const totalTokens = msg.usage?.totalTokens || msg.usage?.total_tokens;
          if (totalTokens) {
            const tokensEl = agentMsgEl.querySelector(".msg-tokens");
            if (tokensEl) tokensEl.textContent = "消耗 " + formatTokens(totalTokens);
          }
        }
      } else if (msg.role === "toolResult") {
        // 计算历史会话的工具耗时：toolResult.timestamp - toolCall所在assistant消息.timestamp
        let duration = null;
        const startTime = toolCallTimestamps.get(msg.toolCallId);
        if (startTime && msg.timestamp) {
          duration = Math.max(0, msg.timestamp - startTime);
        }
        App.finishToolCard(msg.toolCallId, msg.content, msg.isError, duration);
      }
    }
    // 被中断的历史工具调用（无 toolResult 落盘，如运行中被杀掉）→ 标"中断"，避免永久停在"执行中"
    App.markToolCardsInterrupted();
    // 检测最后一条 assistant 消息是否被中断（terminated），提示用户可继续，
    // 解决"刷新页面后看到半截消息、对话卡住不继续"的问题。
    const _last = messages[messages.length - 1];
    if (_last && _last.role === "assistant" &&
        (_last.stopReason === "error" || _last.errorMessage === "terminated")) {
      if (_last.errorMessage === "terminated") App.onGenerationInterrupted();
      else App.onGenerationError(_last.errorMessage);
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

  // ── 消息操作：复制 / 重新生成 / 删除 / 编辑重发 ──
  function getMsgText(msgEl) {
    const body = msgEl.querySelector(".body");
    if (!body) return "";
    // 优先取最终回复文本（.reply-text），否则取整个 body 的文本
    const reply = body.querySelector(".reply-text");
    if (reply) return reply.textContent || "";
    return body.textContent || "";
  }

  // 从用户消息中提取图片数据（格式：[{mimeType, data}]）
  function getMsgImages(msgEl) {
    const body = msgEl.querySelector(".body");
    if (!body) return [];
    const imgs = body.querySelectorAll("img.msg-img");
    const result = [];
    imgs.forEach((img) => {
      const src = img.src || "";
      const match = src.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        result.push({ mimeType: match[1], data: match[2] });
      }
    });
    return result;
  }

  // 从用户消息中提取附件数据（格式：[{name, path}]）
  function getMsgAttachments(msgEl) {
    // 优先从 DOM 存储的附件数据读取
    if (msgEl._attachments && msgEl._attachments.length > 0) {
      return msgEl._attachments;
    }
    // 降级：从文本中解析附件信息
    const text = getMsgText(msgEl);
    return parseAttachmentsFromText(text);
  }

  function findUserMsgForAgent(agentEl) {
    // 找到这条 AI 回复对应的用户消息（前面最近的 .msg.user）
    let prev = agentEl.previousElementSibling;
    while (prev) {
      if (prev.classList.contains("msg") && prev.classList.contains("user")) return prev;
      prev = prev.previousElementSibling;
    }
    return null;
  }

  function findAgentMsgForUser(userEl) {
    // 找到这条用户消息对应的 AI 回复（后面最近的 .msg.agent）
    let next = userEl.nextElementSibling;
    while (next) {
      if (next.classList.contains("msg") && next.classList.contains("agent")) return next;
      next = next.nextElementSibling;
    }
    return null;
  }

  // 复制消息文本
  function copyMsgText(msgEl, btn) {
    const text = getMsgText(msgEl);
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      const orig = btn.textContent;
      btn.textContent = "✓";
      btn.title = "已复制";
      setTimeout(() => { btn.textContent = orig; btn.title = "复制"; }, 1500);
    }).catch(() => {
      // 降级：用 textarea + execCommand
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* 忽略 */ }
      document.body.removeChild(ta);
    });
  }

  // 删除消息（用户消息+对应 AI 回复，或单独 AI 回复）
  function deleteMsg(msgEl) {
    const isUser = msgEl.classList.contains("user");
    const isAgent = msgEl.classList.contains("agent");
    let toRemove = [msgEl];
    if (isUser) {
      const agent = findAgentMsgForUser(msgEl);
      if (agent) toRemove.push(agent);
    }
    toRemove.forEach((el) => {
      el.style.transition = "opacity 0.2s, max-height 0.2s";
      el.style.opacity = "0";
      el.style.maxHeight = el.offsetHeight + "px";
      requestAnimationFrame(() => { el.style.maxHeight = "0"; });
      setTimeout(() => { el.remove(); }, 220);
    });
    // 提示用户：前端删除，刷新后从历史重新加载
    setTimeout(() => {
      App.addSystemNote("已从当前视图删除该消息（刷新页面后会从历史记录重新加载）。");
    }, 250);
  }

  // 截断会话：从会话历史（后端 jsonl）和 DOM 中删除指定用户消息及其后所有内容
  async function truncateFromUserMsg(userEl) {
    // 计算当前用户消息在可见用户消息中的索引
    const allUserMsgs = Array.from(document.querySelectorAll('.msg.user'));
    const idx = allUserMsgs.indexOf(userEl);
    if (idx < 0) return false;
    // 调用后端截断 API
    const sessionPath = state.currentPath;
    if (!sessionPath) return false;
    try {
      const r = await fetch("/api/session/truncate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: sessionPath, keepUserCount: idx }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.success) {
        App.addSystemNote("截断会话失败：" + (j.error || r.status));
        return false;
      }
    } catch (e) {
      App.addSystemNote("截断会话失败（网络异常）：" + e.message);
      return false;
    }
    // 从 DOM 中删除从该用户消息开始的所有后续元素
    let el = userEl;
    while (el) {
      const next = el.nextElementSibling;
      el.remove();
      el = next;
    }
    return true;
  }

  // 重新生成 AI 回复
  async function regenerateMsg(agentEl) {
    if (state.streaming) {
      App.addSystemNote("当前正在生成中，请先停止或等待完成。");
      return;
    }
    const userEl = findUserMsgForAgent(agentEl);
    if (!userEl) {
      App.addSystemNote("未找到对应的用户消息，无法重新生成。");
      return;
    }
    const userText = getMsgText(userEl);
    const userImages = getMsgImages(userEl);
    const userAttachments = getMsgAttachments(userEl);
    if (!userText && userImages.length === 0 && userAttachments.length === 0) {
      App.addSystemNote("用户消息为空，无法重新生成。");
      return;
    }
    // 截断会话：删除该用户提问及其后的 AI 回复（从历史和 DOM 中）
    const ok = await truncateFromUserMsg(userEl);
    if (!ok) return;
    // 重新发送用户消息（会创建新的用户气泡 + AI 回复）
    App.sendMessage(userText, { images: userImages, attachments: userAttachments });
  }

  // 编辑并重发用户消息
  function editAndResend(userEl) {
    if (state.streaming) {
      App.addSystemNote("当前正在生成中，请先停止或等待完成。");
      return;
    }
    const currentText = getMsgText(userEl);
    const currentImages = getMsgImages(userEl);
    const currentAttachments = getMsgAttachments(userEl);
    // 用内联编辑框替代 prompt
    const body = userEl.querySelector(".body");
    if (!body) return;
    const origDisplay = body.style.display;
    body.style.display = "none";
    const editWrap = document.createElement("div");
    editWrap.className = "msg-edit-wrap";
    // 图片预览区域（如果有图片）
    let imgPreviewHtml = "";
    if (currentImages.length > 0) {
      imgPreviewHtml = '<div class="msg-edit-images">';
      currentImages.forEach((img, idx) => {
        imgPreviewHtml += '<img src="data:' + img.mimeType + ';base64,' + img.data + '" class="msg-edit-img" data-idx="' + idx + '" alt="图片预览">';
      });
      imgPreviewHtml += '</div>';
    }
    // 附件预览区域（如果有附件）
    let attachPreviewHtml = "";
    if (currentAttachments.length > 0) {
      attachPreviewHtml = '<div class="msg-edit-attachments">';
      currentAttachments.forEach((att, idx) => {
        attachPreviewHtml += '<div class="msg-edit-attachment" data-idx="' + idx + '">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' +
          '<span class="msg-edit-attachment-name">' + att.name + '</span>' +
          '</div>';
      });
      attachPreviewHtml += '</div>';
    }
    const hasMedia = currentImages.length > 0 || currentAttachments.length > 0;
    editWrap.innerHTML =
      imgPreviewHtml +
      attachPreviewHtml +
      '<textarea class="msg-edit-textarea" rows="3" placeholder="' + (hasMedia ? '添加文字说明（可选）…' : '输入消息…') + '"></textarea>' +
      '<div class="msg-edit-actions">' +
        '<button class="btn-sm btn-primary msg-edit-send">发送</button>' +
        '<button class="btn-sm msg-edit-cancel">取消</button>' +
      '</div>';
    const ta = editWrap.querySelector(".msg-edit-textarea");
    ta.value = currentText;
    body.parentNode.insertBefore(editWrap, body.nextSibling);
    setTimeout(() => { ta.focus(); ta.select(); }, 50);

    const finish = async (send) => {
      const newText = ta.value.trim();
      editWrap.remove();
      body.style.display = origDisplay;
      // 允许纯图片/纯附件消息：文本为空但有图片或附件时也可以发送
      if (!send || (!newText && currentImages.length === 0 && currentAttachments.length === 0)) return;
      // 截断会话：删除该用户提问及其后的 AI 回复（从历史和 DOM 中）
      const ok = await truncateFromUserMsg(userEl);
      if (!ok) return;
      // 发送编辑后的新消息（会创建新的用户气泡 + AI 回复）
      App.sendMessage(newText, { images: currentImages, attachments: currentAttachments });
    };
    editWrap.querySelector(".msg-edit-send").addEventListener("click", () => finish(true));
    editWrap.querySelector(".msg-edit-cancel").addEventListener("click", () => finish(false));
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finish(true); }
      if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
  }

  // ── 多选删除对话框 ──
  // 获取所有对话对（用户消息 + 其后的AI回复，直到下一条用户消息）
  function getConversationPairs() {
    const pairs = [];
    let current = null;
    messagesEl.querySelectorAll(".msg").forEach((el) => {
      if (el.classList.contains("user")) {
        if (current) pairs.push(current);
        const text = el.querySelector(".body")?.textContent || "(空)";
        current = { userEl: el, userText: text, agentEls: [], agentText: "" };
      } else if (el.classList.contains("agent") && current) {
        current.agentEls.push(el);
        const text = el.querySelector(".body")?.textContent || "";
        if (!current.agentText && text) current.agentText = text;
      }
    });
    if (current) pairs.push(current);
    return pairs;
  }

  // 计算消息属于第几个对话对（0-based）
  function getPairIndexForMsg(msgEl) {
    const pairs = getConversationPairs();
    for (let i = 0; i < pairs.length; i++) {
      if (pairs[i].userEl === msgEl || pairs[i].agentEls.includes(msgEl)) return i;
    }
    return -1;
  }

  // 展示多选删除对话框
  function showDeleteDialog(msgEl) {
    const pairs = getConversationPairs();
    if (pairs.length === 0) return;
    const defaultIdx = getPairIndexForMsg(msgEl);
    const selected = new Set(defaultIdx >= 0 ? [defaultIdx] : []);

    // 创建遮罩层
    const overlay = document.createElement("div");
    overlay.className = "delete-dialog-overlay";
    overlay.innerHTML =
      '<div class="delete-dialog">' +
        '<div class="delete-dialog-header">' +
          '<span class="delete-dialog-title">选择对话</span>' +
          '<button class="delete-dialog-cancel" title="取消">取消</button>' +
        '</div>' +
        '<div class="delete-dialog-list"></div>' +
        '<div class="delete-dialog-footer">' +
          '<span class="delete-dialog-count">已选 0 项</span>' +
          '<button class="delete-dialog-confirm btn-danger" disabled>删除</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    const listEl = overlay.querySelector(".delete-dialog-list");
    const countEl = overlay.querySelector(".delete-dialog-count");
    const confirmBtn = overlay.querySelector(".delete-dialog-confirm");

    // 渲染对话对列表
    function renderList() {
      listEl.innerHTML = "";
      pairs.forEach((pair, idx) => {
        const item = document.createElement("label");
        item.className = "delete-dialog-item" + (selected.has(idx) ? " selected" : "");
        const userPreview = pair.userText.length > 50 ? pair.userText.slice(0, 50) + "…" : pair.userText;
        const agentPreview = pair.agentText.length > 80 ? pair.agentText.slice(0, 80) + "…" : pair.agentText;
        item.innerHTML =
          '<input type="checkbox" class="delete-dialog-checkbox" ' + (selected.has(idx) ? "checked" : "") + ' data-idx="' + idx + '">' +
          '<div class="delete-dialog-item-content">' +
            '<div class="delete-dialog-user">' + App.escapeHtml(userPreview) + '</div>' +
            (agentPreview ? '<div class="delete-dialog-agent">' + App.escapeHtml(agentPreview) + '</div>' : '') +
          '</div>';
        item.addEventListener("click", (e) => {
          if (e.target.tagName !== "INPUT") {
            const cb = item.querySelector(".delete-dialog-checkbox");
            cb.checked = !cb.checked;
          }
          const idx = parseInt(item.querySelector(".delete-dialog-checkbox").dataset.idx);
          if (selected.has(idx)) selected.delete(idx);
          else selected.add(idx);
          updateUI();
        });
        listEl.appendChild(item);
      });
    }

    function updateUI() {
      countEl.textContent = "已选 " + selected.size + " 项";
      confirmBtn.disabled = selected.size === 0;
      listEl.querySelectorAll(".delete-dialog-item").forEach((item, i) => {
        item.classList.toggle("selected", selected.has(i));
      });
    }

    renderList();
    updateUI();

    // 取消按钮
    overlay.querySelector(".delete-dialog-cancel").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

    // 确认删除
    confirmBtn.addEventListener("click", async () => {
      if (selected.size === 0) return;
      const sessionPath = state.currentPath;
      if (!sessionPath) { overlay.remove(); return; }
      confirmBtn.disabled = true;
      confirmBtn.textContent = "删除中…";
      try {
        const r = await fetch("/api/session/delete-messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: sessionPath, userIndices: Array.from(selected) }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.success) {
          App.addSystemNote("删除失败：" + (j.error || r.status));
          confirmBtn.disabled = false;
          confirmBtn.textContent = "删除";
          return;
        }
        overlay.remove();
        // 重新加载会话历史
        App.clearChat();
        App.loadHistory(sessionPath);
        App.addSystemNote("已删除 " + selected.size + " 组对话");
      } catch (e) {
        App.addSystemNote("删除失败：" + (e?.message || e));
        confirmBtn.disabled = false;
        confirmBtn.textContent = "删除";
      }
    });
  }

  // 事件委托：消息操作按钮
  messagesEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".msg-action-btn");
    if (!btn) return;
    e.stopPropagation();
    const msgEl = btn.closest(".msg");
    if (!msgEl) return;
    const action = btn.dataset.action;
    switch (action) {
      case "copy": copyMsgText(msgEl, btn); break;
      case "delete": showDeleteDialog(msgEl); break;
      case "regenerate": regenerateMsg(msgEl); break;
      case "edit": editAndResend(msgEl); break;
    }
  });
})();
