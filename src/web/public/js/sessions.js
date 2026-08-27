/**
 * 会话列表管理 — refreshSessions, deleteChat, confirm 弹窗
 */
"use strict";

(function() {
  const App = window.SapBuddy;
  const state = App.state;
  const $ = App.$;
  const escapeHtml = App.escapeHtml;

  // ── 会话管理增强：搜索 / 固定 / 时间分组 ──
  const PIN_KEY = "sapbuddy_pinned_sessions";
  let sessionSearch = "";
  // 分组折叠状态：true=折叠，false=展开。默认只有"今天"展开
  const groupCollapsedState = {
    pinned: true,
    today: false,
    yesterday: true,
    week: true,
    older: true,
  };
  function getPinned() {
    try { return JSON.parse(localStorage.getItem(PIN_KEY) || "[]"); }
    catch { return []; }
  }
  function setPinned(arr) {
    try { localStorage.setItem(PIN_KEY, JSON.stringify(arr)); } catch { /* 忽略 */ }
  }
  function isPinned(path) {
    return getPinned().some((p) => p.toLowerCase() === String(path || "").toLowerCase());
  }
  function togglePin(path) {
    const pinned = getPinned();
    const idx = pinned.findIndex((p) => p.toLowerCase() === String(path || "").toLowerCase());
    if (idx >= 0) pinned.splice(idx, 1);
    else pinned.push(path);
    setPinned(pinned);
  }

  // 搜索框事件监听
  const searchInput = document.getElementById("sidebar-search");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      sessionSearch = searchInput.value.trim().toLowerCase();
      App.refreshSessions(true);
    });
  }

  // 时间分组：今天 / 昨天 / 7 天内 / 更早
  function getTimeGroup(ts) {
    const now = new Date();
    const d = new Date(ts);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 86400000);
    const sevenDaysAgo = new Date(today.getTime() - 6 * 86400000);
    if (d >= today) return "today";
    if (d >= yesterday) return "yesterday";
    if (d >= sevenDaysAgo) return "week";
    return "older";
  }
  const TIME_GROUP_LABELS = {
    today: "今天",
    yesterday: "昨天",
    week: "7 天内",
    older: "更早",
  };

  // ── 重命名弹窗（居中模态，替代 prompt）──
  App.promptRename = function(initialValue) {
    return new Promise((resolve) => {
      const overlay = document.getElementById("rename-overlay");
      const input = document.getElementById("rename-input");
      const ok = document.getElementById("rename-ok");
      const cancel = document.getElementById("rename-cancel");
      if (!overlay || !input) { resolve(null); return; }
      input.value = initialValue || "";
      overlay.classList.add("open");
      setTimeout(() => { input.focus(); input.select(); }, 60);
      let done = false;
      const finish = (val) => { if (done) return; done = true; overlay.classList.remove("open"); resolve(val); };
      ok.onclick = () => finish(input.value);
      cancel.onclick = () => finish(null);
      input.onkeydown = (e) => { if (e.key === "Enter") finish(input.value); if (e.key === "Escape") finish(null); };
    });
  };
  const formatTime = App.formatTime;

  // ── 删除对话 ──
  let _deleting = false;
  App.deleteChat = async function(path, ev) {
    ev.stopPropagation();
    if (_deleting) return;
    _deleting = true;
    try {
      const ok = await showConfirm({
        title: "删除对话",
        message: "确定要删除这条对话吗？删除后无法恢复。",
        confirmText: "删除",
        danger: true,
      });
      if (!ok) return;
      const r = await fetch("/api/session/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.success) {
        await showConfirm({ title: "删除失败", message: j.error || ("错误码 " + r.status), confirmText: "知道了", alert: true });
        return;
      }
      if (state.currentPath && state.currentPath === path) {
        App.clearChat();
        state.currentPath = j.data?.newPath || null;
        if (j.data?.gen) state.currentGen = j.data.gen;
      }
      App.refreshSessions();
    } finally {
      _deleting = false;
    }
  };

  // ── 确认弹窗 ──
  let _confirmBusy = false;
  function showConfirm({ title = "提示", message = "", confirmText = "确定", cancelText = "取消", danger = false, alert = false }) {
    return new Promise((resolve) => {
      if (_confirmBusy) { resolve(false); return; }
      _confirmBusy = true;
      const overlay = $("#confirm-overlay");
      const dlg = $("#confirm-dialog");
      const tEl = $("#confirm-title");
      const mEl = $("#confirm-message");
      const okBtn = $("#confirm-ok");
      const cancelBtn = $("#confirm-cancel");
      tEl.textContent = title;
      mEl.textContent = message;
      okBtn.textContent = confirmText;
      cancelBtn.textContent = alert ? "" : cancelText;
      cancelBtn.style.display = alert ? "none" : "";
      okBtn.className = "btn-sm" + (danger ? " danger" : "");
      dlg.classList.toggle("danger", !!danger);
      let done = false;
      const close = (val) => {
        if (done) return;
        done = true;
        _confirmBusy = false;
        overlay.classList.remove("open");
        document.removeEventListener("keydown", onKey, true);
        resolve(val);
      };
      const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(false); }
        else if (e.key === "Enter" && !alert) { e.preventDefault(); e.stopPropagation(); close(true); }
      };
      cancelBtn.onclick = () => close(false);
      okBtn.onclick = () => close(true);
      overlay.onclick = (e) => { if (e.target === overlay && !alert) close(false); };
      document.addEventListener("keydown", onKey, true);
      overlay.classList.add("open");
    });
  }
  // 供其他模块复用（如设置页"一键更新"确认）
  App.confirm = showConfirm;

  // ── 刷新会话列表（数据无变化时跳过 DOM 重建） ──
  let _refreshToken = 0;
  let _lastSessionsSig = "";
  App.refreshSessions = async function(force) {
    const token = ++_refreshToken;
    try {
      const r = await fetch("/api/sessions");
      const j = await r.json();
      if (!j.success) return;
      if (token !== _refreshToken) return;
      const sessions = j.data.sessions || [];
      state.sessions = sessions;
      App.updateTopbarTitle();
      // 计算签名，数据未变则跳过 DOM 重建（搜索/排序变化时 force=true）
      const sig = JSON.stringify(sessions.map((s) => s.path + "|" + s.modified + "|" + s.messageCount + "|" + !!s.current));
      if (!force && sig === _lastSessionsSig && sessions.length > 0) return;
      _lastSessionsSig = sig;
      const list = $("#session-list");
      list.innerHTML = "";

      // 搜索过滤
      let filtered = sessions;
      if (sessionSearch) {
        filtered = sessions.filter((s) => {
          const name = (s.name || s.firstMessage || "").toLowerCase();
          return name.includes(sessionSearch);
        });
      }
      if (!filtered.length) {
        list.innerHTML = sessionSearch
          ? '<div class="empty-hint">未找到匹配「' + escapeHtml(sessionSearch) + '」的对话</div>'
          : '<div class="empty-hint">暂无历史对话</div>';
        return;
      }

      // 排序：固定的排在前面，然后按时间降序
      const normPath = (p) => String(p || "").replace(/\\/g, "/").toLowerCase();
      const pinnedSet = new Set(getPinned().map(normPath));
      filtered.sort((a, b) => {
        const aPinned = pinnedSet.has(normPath(a.path)) ? 1 : 0;
        const bPinned = pinnedSet.has(normPath(b.path)) ? 1 : 0;
        if (aPinned !== bPinned) return bPinned - aPinned;
        return (b.modified || 0) - (a.modified || 0);
      });

      const norm = (p) => String(p || "").replace(/\\/g, "/").toLowerCase();
      let curPath = state.currentPath;
      if (curPath === undefined) {
        const c = filtered.find((x) => x.current);
        curPath = c ? c.path : null;
      }
      if (curPath && !filtered.some((s) => norm(s.path) === norm(curPath))) {
        const c = filtered.find((x) => x.current);
        curPath = c ? c.path : null;
      }

      // 时间分组渲染：已固定 / 今天 / 昨天 / 7天内 / 更早
      const pinnedItems = filtered.filter((s) => pinnedSet.has(norm(s.path)));
      const unpinnedItems = filtered.filter((s) => !pinnedSet.has(norm(s.path)));
      const groups = [
        { key: "pinned", label: "已固定", items: pinnedItems },
        { key: "today", label: TIME_GROUP_LABELS.today, items: [] },
        { key: "yesterday", label: TIME_GROUP_LABELS.yesterday, items: [] },
        { key: "week", label: TIME_GROUP_LABELS.week, items: [] },
        { key: "older", label: TIME_GROUP_LABELS.older, items: [] },
      ];
      for (const s of unpinnedItems) {
        const g = getTimeGroup(s.modified);
        groups.find((x) => x.key === g).items.push(s);
      }

      const seen = new Set();
      for (const group of groups) {
        if (group.items.length === 0) continue;
        // 可折叠分组：使用保存的折叠状态（避免操作后自动恢复默认）
        const groupEl = document.createElement("details");
        const isCollapsed = groupCollapsedState[group.key] !== undefined ? groupCollapsedState[group.key] : (group.key !== "today");
        groupEl.className = "session-group" + (!isCollapsed ? " is-open" : "");
        groupEl.open = !isCollapsed;
        // 折叠/展开时保存状态
        groupEl.addEventListener("toggle", () => {
          groupCollapsedState[group.key] = !groupEl.open;
        });
        const summary = document.createElement("summary");
        summary.className = "session-group-header";
        summary.innerHTML = '<svg class="group-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg><span>' + group.label + '</span>';
        groupEl.appendChild(summary);
        // 会话项
        for (const s of group.items) {
          const n = norm(s.path);
          if (seen.has(n)) continue;
          seen.add(n);
          const pinned = pinnedSet.has(n);
          const item = document.createElement("div");
          item.className = "session-item" + (norm(s.path) === norm(curPath) ? " current" : "") + (pinned ? " pinned" : "");
          item.title = s.firstMessage || "(空对话)";
          item.dataset.path = s.path;

          const text = document.createElement("div");
          text.className = "session-text";
          const title = document.createElement("div");
          title.className = "session-title";
          // 正在执行的会话：标题后加旋转图标
          const isCurrent = norm(s.path) === norm(curPath);
          const isRunning = isCurrent && state.streaming;
          let titleHtml = (pinned ? "📌 " : "") + escapeHtml(s.name || s.firstMessage || "(空对话)");
          if (isRunning) {
            titleHtml += '<span class="session-running-icon" title="正在执行"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg></span>';
          }
          title.innerHTML = titleHtml;
          const meta = document.createElement("div");
          meta.className = "session-meta";
          meta.textContent = `${formatTime(s.modified)} · ${s.messageCount} 条消息`;
          text.appendChild(title);
          text.appendChild(meta);
          item.appendChild(text);

          // 更多操作按钮（...），点击弹出菜单：固定/重命名/删除
          const moreBtn = document.createElement("button");
          moreBtn.className = "session-more" + (pinned ? " has-pinned" : "");
          moreBtn.title = "更多操作";
          moreBtn.setAttribute("aria-label", "更多操作");
          moreBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
          moreBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            showSessionMenu(moreBtn, s, pinned);
          });
          item.appendChild(moreBtn);

          item.addEventListener("click", () => App.switchChat(s.path));
          groupEl.appendChild(item);
        }
        list.appendChild(groupEl);
      }
    } catch { /* 忽略 */ }
  };

  // ── 会话更多操作菜单 ──
  let _sessionMenu = null;
  function closeSessionMenu() {
    if (_sessionMenu) { _sessionMenu.remove(); _sessionMenu = null; }
    document.removeEventListener("click", closeSessionMenu, true);
  }
  function showSessionMenu(anchor, s, pinned) {
    closeSessionMenu();
    const menu = document.createElement("div");
    menu.className = "session-menu";
    menu.innerHTML =
      '<div class="session-menu-item" data-action="pin">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>' +
        '<span>' + (pinned ? '取消固定' : '固定对话') + '</span>' +
      '</div>' +
      '<div class="session-menu-item" data-action="rename">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>' +
        '<span>重命名</span>' +
      '</div>' +
      '<div class="session-menu-item danger" data-action="delete">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
        '<span>删除对话</span>' +
      '</div>';

    // 定位到按钮下方
    const rect = anchor.getBoundingClientRect();
    menu.style.top = (rect.bottom + 4) + "px";
    menu.style.right = (window.innerWidth - rect.right) + "px";
    document.body.appendChild(menu);
    _sessionMenu = menu;

    // 点击菜单项
    menu.addEventListener("click", async (ev) => {
      const item = ev.target.closest(".session-menu-item");
      if (!item) return;
      const action = item.dataset.action;
      closeSessionMenu();
      if (action === "pin") {
        togglePin(s.path);
        App.refreshSessions(true);
      } else if (action === "rename") {
        const old = s.name || s.firstMessage || "";
        const nn = await App.promptRename(old);
        if (nn === null) return;
        try {
          await fetch("/api/session/rename", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: s.path, name: nn.trim() }),
          });
          App.refreshSessions();
        } catch { /* 忽略 */ }
      } else if (action === "delete") {
        App.deleteChat(s.path, ev);
      }
    });

    // 点击其他地方关闭
    setTimeout(() => {
      document.addEventListener("click", closeSessionMenu, true);
    }, 0);
  }

  // ── 顶栏当前会话标题 ──
  App.updateTopbarTitle = function() {
    const el = document.getElementById("topbar-title");
    if (!el) return;
    const norm = (p) => String(p || "").replace(/\\/g, "/").toLowerCase();
    const cur = norm(state.currentPath);
    const s = (state.sessions || []).find((x) => norm(x.path) === cur);
    el.textContent = s ? (s.name || s.firstMessage || "新对话") : "新对话";
    // 存储会话文件名，供点击复制使用
    const fileName = state.currentPath ? state.currentPath.split(/[\\/]/).pop() : "";
    el.dataset.sessionFile = fileName;
    el.title = fileName ? `点击复制会话文件名：${fileName}` : "新对话";
  };

  // 点击会话标题复制会话文件名
  document.addEventListener("click", (e) => {
    const titleEl = e.target.closest("#topbar-title");
    if (!titleEl) return;
    const fileName = titleEl.dataset.sessionFile;
    if (!fileName) return;
    // 复制到剪贴板（优先用现代API，失败则降级）
    const copyFallback = (text) => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch (e) {}
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(fileName).catch(() => copyFallback(fileName));
    } else {
      copyFallback(fileName);
    }
    // 显示复制成功提示
    const original = titleEl.textContent;
    titleEl.textContent = "已复制文件名";
    setTimeout(() => { titleEl.textContent = original; }, 1500);
  });

  // ── 新建对话按钮 ──
  $("#new-chat-btn").addEventListener("click", App.newChat);
})();
