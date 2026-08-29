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

  // 全展开 / 全折叠切换按钮（有折叠则全展开，全展开则全折叠）
  const toggleAllBtn = document.getElementById("toggle-all-groups");
  const ICON_EXPAND = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="7 13 12 18 17 13"/><polyline points="7 6 12 11 17 6"/></svg>';
  const ICON_COLLAPSE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="7 11 12 6 17 11"/><polyline points="7 18 12 13 17 18"/></svg>';
  function setAllGroups(collapsed) {
    Object.keys(groupCollapsedState).forEach((k) => { groupCollapsedState[k] = collapsed; });
    document.querySelectorAll("#session-list .session-group").forEach((g) => {
      g.open = !collapsed;
      g.classList.toggle("is-open", !collapsed);
    });
    updateToggleAllIcon();
  }
  function updateToggleAllIcon() {
    if (!toggleAllBtn) return;
    const anyCollapsed = Object.values(groupCollapsedState).some(Boolean);
    toggleAllBtn.innerHTML = anyCollapsed ? ICON_EXPAND : ICON_COLLAPSE;
    toggleAllBtn.title = anyCollapsed ? "全展开" : "全折叠";
  }
  if (toggleAllBtn) {
    toggleAllBtn.addEventListener("click", () => {
      const anyCollapsed = Object.values(groupCollapsedState).some(Boolean);
      setAllGroups(!anyCollapsed ? true : false);
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
        // 搜索时强制展开所有有匹配项的分组，清除搜索后恢复用户保存的状态
        const groupEl = document.createElement("details");
        const isCollapsed = sessionSearch
          ? false
          : (groupCollapsedState[group.key] !== undefined ? groupCollapsedState[group.key] : (group.key !== "today"));
        groupEl.className = "session-group" + (!isCollapsed ? " is-open" : "");
        groupEl.open = !isCollapsed;
        // 折叠/展开时保存状态 + 同步 is-open class（CSS 动画/样式依赖它）
        groupEl.addEventListener("toggle", () => {
          groupCollapsedState[group.key] = !groupEl.open;
          groupEl.classList.toggle("is-open", groupEl.open);
          updateToggleAllIcon();
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
          let titleHtml = escapeHtml(s.name || s.firstMessage || "(空对话)");
          if (isRunning) {
            titleHtml += '<span class="session-running-icon" title="正在执行"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg></span>';
          }
          title.innerHTML = titleHtml;
          const meta = document.createElement("div");
          meta.className = "session-meta";
          meta.textContent = `${formatTime(s.modified)} · ${s.messageCount} 条消息`;
          text.appendChild(title);
          text.appendChild(meta);

          // 左侧消息图标（视觉锚点）
          const itemIcon = document.createElement("div");
          itemIcon.className = "session-item-icon";
          itemIcon.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
          item.appendChild(itemIcon);
          item.appendChild(text);

          // 更多操作按钮（...），点击弹出菜单：固定/重命名/删除
          const moreBtn = document.createElement("button");
          moreBtn.className = "session-more" + (pinned ? " has-pinned" : "");
          moreBtn.title = "更多操作";
          moreBtn.setAttribute("aria-label", "更多操作");
          moreBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
          moreBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            // toggle: 同一会话的菜单已打开则关闭，避免先关后开闪烁
            if (_sessionMenu && _sessionMenu.classList.contains("open") && _sessionMenu.dataset.sessionPath === s.path) {
              closeSessionMenu();
              return;
            }
            showSessionMenu(moreBtn, s, pinned);
          });
          item.appendChild(moreBtn);

          item.addEventListener("click", () => App.switchChat(s.path));
          groupEl.appendChild(item);
        }
        list.appendChild(groupEl);
      }
      updateToggleAllIcon();
    } catch { /* 忽略 */ }
  };

  // ── 会话更多操作菜单（持久单例：只创建一次，通过 open 类控制显隐，避免 create/remove 闪烁）──
  let _sessionMenu = null;
  function ensureSessionMenu() {
    if (_sessionMenu) return _sessionMenu;
    _sessionMenu = document.createElement("div");
    _sessionMenu.className = "session-menu";
    document.body.appendChild(_sessionMenu);
    return _sessionMenu;
  }
  function closeSessionMenu(e) {
    // 点击更多操作按钮或菜单内部时不关闭（避免捕获阶段先关闭导致闪烁）
    if (e && e.target && (e.target.closest('.session-more') || e.target.closest('.session-menu'))) return;
    if (_sessionMenu) {
      _sessionMenu.classList.remove("open");
      _sessionMenu.dataset.sessionPath = "";
    }
    document.removeEventListener("click", closeSessionMenu, true);
  }
  function showSessionMenu(anchor, s, pinned) {
    const menu = ensureSessionMenu();
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
    menu.dataset.sessionPath = s.path;
    // transition 模式下直接添加 open 类即可，无需 remove→void→add（避免一帧空白）
    menu.classList.add("open");

    // 点击菜单项（单例模式下用 onclick 覆盖，避免重复绑定）
    menu.onclick = async (ev) => {
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
    };

    // 点击其他地方关闭（setTimeout 确保本次点击不会触发）
    setTimeout(() => {
      document.addEventListener("click", closeSessionMenu, true);
    }, 0);
  }

  // ── 轻量更新会话高亮（只改 .current class，不全量重建，避免与消息渲染抢 DOM 造成闪烁）──
  App.updateSessionHighlight = function() {
    const list = $("#session-list");
    if (!list) return;
    const norm = (p) => String(p || "").replace(/\\/g, "/").toLowerCase();
    const cur = norm(state.currentPath);
    list.querySelectorAll(".session-item").forEach((el) => {
      const path = el.dataset.path;
      const match = path && norm(path) === cur;
      el.classList.toggle("current", match);
    });
  };

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
