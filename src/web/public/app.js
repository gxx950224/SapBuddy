/**
 * AbapBuddy — 入口（初始化 + 全局事件绑定）
 * 各功能模块均已拆分至 js/ 目录，通过 window.AbapBuddy 命名空间通信
 */
"use strict";

(function() {
  const App = window.AbapBuddy;
  const state = App.state;
  const $ = App.$;

  // ── 会话搜索过滤 ──
  const searchInput = document.getElementById("sidebar-search");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      const q = searchInput.value.trim().toLowerCase();
      document.querySelectorAll("#session-list .session-item").forEach((item) => {
        const t = (item.querySelector(".session-title")?.textContent || "").toLowerCase();
        item.style.display = !q || t.includes(q) ? "" : "none";
      });
    });
  }

  // ── 快捷指令卡片 ──
  document.querySelectorAll(".cmd-card").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cmd = btn.dataset.cmd || btn.dataset.fill || "";
      $("#input").value = cmd;
      App.autoGrow();
      App.sendMessage();
    });
  });

  // ── 左侧快捷指令 ──
  document.querySelectorAll(".cmd-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cmd = btn.dataset.cmd || btn.dataset.fill || "";
      $("#input").value = cmd;
      App.autoGrow();
      $("#input").focus();
    });
  });

  // ── 代码块复制（事件委托） ──
  document.addEventListener("click", (e) => {
    if (e.target.classList.contains("code-copy-btn")) {
      const pre = document.getElementById(e.target.dataset.target);
      if (pre) {
        navigator.clipboard.writeText(pre.textContent).then(() => {
          e.target.textContent = "已复制";
          setTimeout(() => e.target.textContent = "复制", 1500);
        }).catch(() => {
          const range = document.createRange();
          range.selectNodeContents(pre);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand("copy");
          e.target.textContent = "已复制";
          setTimeout(() => e.target.textContent = "复制", 1500);
        });
      }
    }
  });

  // ── 快捷指令弹出菜单 ──
  const cmdMenuOverlay = document.getElementById("cmd-menu-overlay");
  const toolbarCmdBtn = document.getElementById("toolbar-cmd");

  if (toolbarCmdBtn) {
    toolbarCmdBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const rect = toolbarCmdBtn.getBoundingClientRect();
      const menu = document.getElementById("cmd-menu");
      if (menu) {
        const menuHeight = Math.min(menu.offsetHeight || 260, 360);
        const spaceAbove = rect.top - 12;
        const spaceBelow = window.innerHeight - rect.bottom - 12;
        let left = Math.max(12, Math.min(rect.left, window.innerWidth - (menu.offsetWidth || 240) - 12));
        menu.style.left = left + "px";
        menu.style.right = "auto";
        if (spaceAbove >= menuHeight || spaceAbove >= spaceBelow) {
          menu.style.top = "auto";
          menu.style.bottom = (window.innerHeight - rect.top + 8) + "px";
          menu.style.transformOrigin = "bottom left";
        } else {
          menu.style.top = (rect.bottom + 8) + "px";
          menu.style.bottom = "auto";
          menu.style.transformOrigin = "top left";
        }
      }
      cmdMenuOverlay.classList.toggle("open");
    });
  }

  if (cmdMenuOverlay) {
    cmdMenuOverlay.addEventListener("click", (e) => {
      if (e.target === cmdMenuOverlay) cmdMenuOverlay.classList.remove("open");
    });
    cmdMenuOverlay.querySelectorAll(".cmd-menu-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const cmd = btn.dataset.cmd || btn.dataset.fill || "";
        $("#input").value = cmd;
        App.autoGrow();
        cmdMenuOverlay.classList.remove("open");
        $("#input").focus();
      });
    });
  }

  document.addEventListener("click", (e) => {
    if (cmdMenuOverlay && !cmdMenuOverlay.contains(e.target) && e.target !== toolbarCmdBtn) {
      cmdMenuOverlay.classList.remove("open");
    }
  });

  // ── 会话 ID 复制（点击状态栏） ──
  const sessionIdEl = document.getElementById("chat-session-id");
  if (sessionIdEl) {
    sessionIdEl.addEventListener("click", () => {
      const sid = sessionIdEl.dataset.kernelId || sessionIdEl.textContent;
      if (sid && sid !== "-" && navigator.clipboard) {
        navigator.clipboard.writeText(sid).then(() => {
          sessionIdEl.classList.add("copied");
          setTimeout(() => sessionIdEl.classList.remove("copied"), 900);
        });
      }
    });
  }

  // ── 共享下载安装函数（供 settings.js 和本模块共用） ──
  App.downloadAndInstall = async function(downloadUrl, statusEl) {
    try {
      const r = await fetch(`/api/download-update?url=${encodeURIComponent(downloadUrl)}`);
      if (!r.ok) { statusEl.textContent = "下载请求失败"; return false; }
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let doneDownload = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === "progress") {
              statusEl.textContent = `下载中… ${msg.percent}% (${(msg.loaded / 1048576).toFixed(1)}MB${msg.total ? "/" + (msg.total / 1048576).toFixed(1) + "MB" : ""})`;
            } else if (msg.type === "complete") {
              statusEl.textContent = "下载完成，正在安装…";
              doneDownload = true;
              if (window.electronAPI && window.electronAPI.installUpdate) {
                statusEl.textContent = "正在安装…安装向导即将弹出";
                const result = await window.electronAPI.installUpdate(msg.filePath);
                if (!result || !result.success) {
                  statusEl.textContent = "安装失败：" + (result?.error || "未知错误");
                  return false;
                }
                return true;
              } else {
                statusEl.textContent = "下载完成。请手动运行安装程序。";
                return true;
              }
            } else if (msg.type === "error") {
              statusEl.textContent = "下载失败：" + msg.message;
              return false;
            }
          } catch {}
        }
      }
      if (!doneDownload) {
        statusEl.textContent = "下载中断";
        return false;
      }
    } catch (e) {
      statusEl.textContent = "下载失败：" + e.message;
      return false;
    }
  };

  // ── 初始化 ──
  App.connectEvents();
  App.loadHistory();
  App.refreshState();
  App.refreshSapStatus();
  App.refreshFiles();
  App.refreshSessions();
  // 轮询：15 秒一次，减少无用请求
  let _heartbeatTick = 0;
  setInterval(() => {
    _heartbeatTick++;
    App.refreshState().catch(() => {});
    // 会话列表每 60 秒刷新一次
    if (!state.currentPath || _heartbeatTick % 4 === 0) App.refreshSessions().catch(() => {});
    // 文件树每 60 秒刷新一次（后台重建时多刷一次）
    if (_heartbeatTick % 4 === 0) App.refreshFiles().catch(() => {});
  }, 15000);
})();
