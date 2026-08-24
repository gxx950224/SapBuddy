/**
 * SapBuddy — 入口（初始化 + 全局事件绑定）
 * 各功能模块均已拆分至 js/ 目录，通过 window.SapBuddy 命名空间通信
 */
"use strict";

(function() {
  const App = window.SapBuddy;
  const state = App.state;
  const $ = App.$;

  // ── 通用复制（navigator.clipboard + 降级 execCommand）──
  App.copyText = async function(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return;
      }
    } catch { /* 降级 */ }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch { /* 忽略 */ }
    document.body.removeChild(ta);
  };

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

  // ── 代码块复制（事件委托，走通用复制=clipboard+execCommand 降级，内网 HTTP 可用） ──
  document.addEventListener("click", (e) => {
    if (e.target.classList.contains("code-copy-btn")) {
      const pre = document.getElementById(e.target.dataset.target);
      if (pre) {
        App.copyText(pre.textContent).then(() => {
          e.target.textContent = "已复制";
          setTimeout(() => e.target.textContent = "复制", 1500);
        });
      }
    }
  });

  // ── 图片查看器：双击缩略图放大（对话气泡 / 历史 / 发送前的缩略图 chip） ──
  App.openImageViewer = function(src) {
    let lb = document.getElementById("image-viewer");
    if (!lb) {
      lb = document.createElement("div");
      lb.id = "image-viewer";
      lb.className = "image-viewer";
      lb.innerHTML =
        '<div class="viewer-backdrop"></div><img class="viewer-img" alt="图片放大查看" /><button class="viewer-close" title="关闭" type="button">×</button>';
      document.body.appendChild(lb);
      lb.addEventListener("click", (e) => {
        if (e.target === lb || e.target.classList.contains("viewer-backdrop") || e.target.classList.contains("viewer-close")) {
          App.closeImageViewer();
        }
      });
    }
    lb.querySelector(".viewer-img").src = src;
    lb.classList.add("open");
  };
  App.closeImageViewer = function() {
    const lb = document.getElementById("image-viewer");
    if (lb) lb.classList.remove("open");
  };
  document.addEventListener("dblclick", (e) => {
    const img = e.target.closest && e.target.closest(".msg-img, .img-chip img");
    if (img && img.src) App.openImageViewer(img.src);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") App.closeImageViewer();
  });

  // ── 上传文件（AI 可读取）──
  const attachBtn = document.getElementById("attach-btn");
  const fileInput = document.getElementById("file-input");
  if (attachBtn && fileInput) {
    attachBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async () => {
      const files = Array.from(fileInput.files || []);
      fileInput.value = "";
      for (const f of files) await App.attachFile(f);
    });
  }

  // 附件状态与渲染
  App.state.attachments = App.state.attachments || [];
  App.attachFile = async function(file) {
    const isBin = /\.(docx|xlsx|pptx)$/i.test(file.name);
    const MAX = isBin ? 10 * 1024 * 1024 : 2 * 1024 * 1024; // 二进制 10MB / 文本 2MB
    if (file.size > MAX) { App.addSystemNote("文件过大（>" + (MAX/1024/1024) + "MB）：" + file.name); return; }
    try {
      let content, base64 = false;
      if (isBin) {
        const buf = new Uint8Array(await file.arrayBuffer());
        let b = "";
        for (let i = 0; i < buf.length; i += 0x8000) b += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        content = btoa(b);
        base64 = true;
      } else {
        content = await file.text();
      }
      const r = await fetch("/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, content, base64 }),
      });
      const j = await r.json();
      if (!j.success) { App.addSystemNote("上传失败：" + (j.error || r.status)); return; }
      App.state.attachments.push({ name: file.name, path: j.path, isOffice: !!j.isOffice });
      renderAttachments();
      App.addSystemNote("已上传：" + file.name + (j.isOffice ? "（已提取文本）" : ""));
    } catch (e) { App.addSystemNote("上传失败：" + e.message); }
  };
  App.clearAttachments = function() {
    App.state.attachments = [];
    renderAttachments();
  };
  function renderAttachments() {
    const wrap = document.getElementById("attachments");
    if (!wrap) return;
    wrap.innerHTML = "";
    for (const a of App.state.attachments) {
      const chip = document.createElement("span");
      chip.className = "attach-chip";
      chip.innerHTML = App.escapeHtml(a.name) + " <button class='attach-remove' title='移除'>×</button>";
      chip.querySelector(".attach-remove").addEventListener("click", () => {
        App.state.attachments = App.state.attachments.filter((x) => x !== a);
        renderAttachments();
      });
      wrap.appendChild(chip);
    }
  }

  // ── 图片（视觉输入：AI 可看图）──
  App.state.images = App.state.images || [];
  const imgBtn = document.getElementById("img-btn");
  const imgInput = document.getElementById("img-input");
  if (imgBtn && imgInput) {
    imgBtn.addEventListener("click", () => imgInput.click());
    imgInput.addEventListener("change", async () => {
      const files = Array.from(imgInput.files || []);
      imgInput.value = "";
      for (const f of files) await App.addImage(f);
    });
  }
  // 粘贴截图（Ctrl+V / 右键粘贴）
  const chatInput = document.getElementById("input");
  if (chatInput) {
    chatInput.addEventListener("paste", (e) => {
      const items = e.clipboardData?.items || [];
      for (const it of items) {
        if (it.kind === "file" && it.type && it.type.startsWith("image/")) {
          e.preventDefault();
          App.addImage(it.getAsFile());
          return;
        }
      }
    });
  }

  App.addImage = async function(file) {
    if (!file) return;
    if (!/^image\/(png|jpeg|gif|webp|bmp)$/i.test(file.type || "")) {
      App.addSystemNote("不支持的图片类型：" + (file.type || "未知"));
      return;
    }
    if (file.size > 8 * 1024 * 1024) { App.addSystemNote("图片过大（>8MB）：" + (file.name || "")); return; }
    try {
      const { mimeType, data, preview } = await compressImage(file);
      App.state.images.push({ name: file.name || "粘贴的图片", mimeType, data, preview });
      renderImageChips();
    } catch (e) { App.addSystemNote("图片处理失败：" + e.message); }
  };
  App.clearImages = function() {
    App.state.images = [];
    renderImageChips();
  };
  function renderImageChips() {
    const wrap = document.getElementById("images");
    if (!wrap) return;
    wrap.innerHTML = "";
    for (const img of App.state.images) {
      const chip = document.createElement("span");
      chip.className = "img-chip";
      const thumb = document.createElement("img");
      thumb.src = img.preview;
      thumb.alt = img.name;
      chip.appendChild(thumb);
      const rm = document.createElement("button");
      rm.className = "attach-remove";
      rm.title = "移除";
      rm.textContent = "×";
      rm.addEventListener("click", () => {
        App.state.images = App.state.images.filter((x) => x !== img);
        renderImageChips();
      });
      chip.appendChild(rm);
      wrap.appendChild(chip);
    }
  }
  // 压缩到最长边 ≤1024px（截图/照片保持清晰，base64 体积小）
  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("读取失败"));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("解码失败"));
        img.onload = () => {
          const MAX = 1024;
          const w0 = img.naturalWidth, h0 = img.naturalHeight;
          if (w0 <= MAX && h0 <= MAX) {
            resolve({ mimeType: file.type || "image/png", data: String(reader.result).split(",")[1], preview: reader.result });
            return;
          }
          const scale = Math.min(1, MAX / Math.max(w0, h0));
          const w = Math.round(w0 * scale), h = Math.round(h0 * scale);
          const canvas = document.createElement("canvas");
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, w, h);
          const outType = file.type === "image/png" ? "image/png" : "image/jpeg";
          const out = canvas.toDataURL(outType, 0.85);
          resolve({ mimeType: outType, data: out.split(",")[1], preview: out });
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

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
