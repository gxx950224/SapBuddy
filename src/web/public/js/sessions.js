/**
 * 会话列表管理 — refreshSessions, deleteChat, confirm 弹窗
 */
"use strict";

(function() {
  const App = window.SapBuddy;
  const state = App.state;
  const $ = App.$;
  const escapeHtml = App.escapeHtml;

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
        message: "确定要删除这条对话吗？删除后将移至回收站，可在回收站中恢复。",
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
      // 计算签名，数据未变则跳过 DOM 重建
      const sig = JSON.stringify(sessions.map((s) => s.path + "|" + s.modified + "|" + s.messageCount + "|" + !!s.current));
      if (!force && sig === _lastSessionsSig && sessions.length > 0) return;
      _lastSessionsSig = sig;
      const list = $("#session-list");
      list.innerHTML = "";
      if (!sessions.length) {
        list.innerHTML = '<div class="empty-hint">暂无历史对话</div>';
        return;
      }
      const norm = (p) => String(p || "").replace(/\\/g, "/").toLowerCase();
      let curPath = state.currentPath;
      if (curPath === undefined) {
        const c = sessions.find((x) => x.current);
        curPath = c ? c.path : null;
      }
      if (curPath && !sessions.some((s) => norm(s.path) === norm(curPath))) {
        const c = sessions.find((x) => x.current);
        curPath = c ? c.path : null;
      }
      const seen = new Set();
      for (const s of sessions) {
        const n = norm(s.path);
        if (seen.has(n)) continue;
        seen.add(n);
        const item = document.createElement("div");
        item.className = "session-item" + (norm(s.path) === norm(curPath) ? " current" : "");
        item.title = s.firstMessage || "(空对话)";
        item.dataset.path = s.path;

        const text = document.createElement("div");
        text.className = "session-text";
        const title = document.createElement("div");
        title.className = "session-title";
        title.textContent = s.name || s.firstMessage || "(空对话)";
        const meta = document.createElement("div");
        meta.className = "session-meta";
        meta.textContent = `${formatTime(s.modified)} · ${s.messageCount} 条消息`;
        text.appendChild(title);
        text.appendChild(meta);
        item.appendChild(text);

        const del = document.createElement("button");
        del.className = "session-del" + (s.current ? " session-del-current" : "");
        del.title = "删除该对话";
        del.setAttribute("aria-label", "删除该对话");
        del.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.5 9a1 1 0 0 0 1 .9h5a1 1 0 0 0 1-.9l.5-9M6.5 7v4M9.5 7v4"/></svg>';
        del.addEventListener("click", (ev) => App.deleteChat(s.path, ev));
        item.appendChild(del);
        // 重命名按钮（写 session_info，与 pi Ctrl+R 同一机制）
        const ren = document.createElement("button");
        ren.className = "session-ren";
        ren.title = "重命名该对话";
        ren.setAttribute("aria-label", "重命名该对话");
        ren.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 2.5a1.8 1.8 0 0 1 2.5 2.5L6 13l-3.5 1L3.5 10.5l8-8Z"/></svg>';
        ren.addEventListener("click", async (ev) => {
          ev.stopPropagation();
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
        });
        item.appendChild(ren);
        item.addEventListener("click", () => App.switchChat(s.path));
        list.appendChild(item);
      }
    } catch { /* 忽略 */ }
  };

  // ── 顶栏当前会话标题 ──
  App.updateTopbarTitle = function() {
    const el = document.getElementById("topbar-title");
    if (!el) return;
    const norm = (p) => String(p || "").replace(/\\/g, "/").toLowerCase();
    const cur = norm(state.currentPath);
    const s = (state.sessions || []).find((x) => norm(x.path) === cur);
    el.textContent = s ? (s.name || s.firstMessage || "新对话") : "新对话";
    el.title = el.textContent;
  };

  // ── 新建对话按钮 ──
  $("#new-chat-btn").addEventListener("click", App.newChat);
})();
