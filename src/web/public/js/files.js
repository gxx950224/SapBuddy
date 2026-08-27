/**
 * 产物面板 — 文件树、预览、打开位置、Toast
 */
"use strict";

(function() {
  const App = window.SapBuddy;
  const state = App.state;
  const $ = App.$;
  const escapeHtml = App.escapeHtml;

  // ── 文件图标 SVG ──
  function fileIconSvg(name) {
    const n = (name || "").toLowerCase();
    let color = "var(--accent)";
    if (n.endsWith(".html") || n.endsWith(".htm")) color = "#e34c26";
    else if (n.endsWith(".json")) color = "#f59e0b";
    else if (n.endsWith(".txt") || n.endsWith(".log")) color = "#8a90a0";
    else if (n.endsWith(".xml") || n.endsWith(".abap")) color = "#2f9e6f";
    return `<svg viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`;
  }

  // ── 二进制文件（不提供网页预览，提示打开位置查看）──
  const BINARY_RE = /\.(xlsx|xls|docx|doc|pptx|ppt|pdf|zip|rar|7z|gz|tar|png|jpe?g|gif|bmp|ico|mp4|mp3|exe|msi|bin|dll|iso)$/i;

  // ── 文件树状态 ──
  const outputExpanded = new Set();

  // ── 刷新文件列表（force=true 时强制重建，如点击刷新按钮） ──
  let _lastFileTreeSig = "";
  App.refreshFiles = async function(force) {
    try {
      const r = await fetch("/api/output-tree", { cache: "no-store" });
      const j = await r.json();
      if (!j || j.success === false) return;
      const list = $("#file-list");
      if (list.querySelector(".file-menu.open")) return;
      const tree = j.data?.tree || [];
      // 计算签名（完整树），数据未变且非强制则跳过 DOM 重建
      const sig = JSON.stringify(tree);
      if (!force && sig === _lastFileTreeSig && tree.length > 0) return;
      _lastFileTreeSig = sig;
      if (!tree.length) {
        list.innerHTML = '<div class="empty-hint">暂无输出文件</div>';
        return;
      }
      list.innerHTML = "";
      for (const node of tree) {
        list.appendChild(createOutputNode(node, 0));
      }
    } catch { /* 忽略 */ }
  };

  function createOutputNode(node, depth) {
    if (node.type === "dir") {
      const el = document.createElement("div");
      el.style.paddingLeft = (depth * 16) + "px";
      el.className = "skill-tree-dir";
      if (outputExpanded.has(node.path)) el.classList.add("open");
      el.innerHTML = `<span class="skill-tree-arrow">▶</span><span class="skill-tree-icon">📁</span><span class="skill-tree-name">${escapeHtml(node.name)}</span>`;
      const childrenWrap = document.createElement("div");
      childrenWrap.className = "skill-tree-children";
      for (const child of (node.children || [])) {
        childrenWrap.appendChild(createOutputNode(child, depth + 1));
      }
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        el.classList.toggle("open");
        if (el.classList.contains("open")) outputExpanded.add(node.path);
        else outputExpanded.delete(node.path);
      });
      const frag = document.createDocumentFragment();
      frag.appendChild(el);
      frag.appendChild(childrenWrap);
      return frag;
    } else {
      const el = document.createElement("div");
      el.style.paddingLeft = (depth * 16) + "px";
      el.className = "skill-tree-file output-file-item";
      el.dataset.name = node.path;
      el.title = node.path;
      el.innerHTML = `<span class="skill-tree-arrow" style="visibility:hidden">▶</span><span class="skill-tree-icon">${fileIconSvg(node.name)}</span><span class="skill-tree-name">${escapeHtml(node.name)}</span>
        <span class="file-actions" style="display:none">
          <button class="file-more" title="更多操作" aria-label="更多操作">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="3" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="8" cy="13" r="1.5"/></svg>
          </button>
        </span>`;
      el.addEventListener("mouseenter", () => {
        const a = el.querySelector(".file-actions");
        if (a) a.style.display = "";
      });
      el.addEventListener("mouseleave", () => {
        if (!el.classList.contains("menu-open")) {
          const a = el.querySelector(".file-actions");
          if (a) a.style.display = "none";
        }
      });
      el.addEventListener("click", (e) => {
        if (e.target.closest(".file-more")) return;
        e.stopPropagation();
        App.previewFile(node.path);
      });
      const moreBtn = el.querySelector(".file-more");
      if (moreBtn) {
        let menuEl = null;
        moreBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          closeAllFileMenus();
          // 菜单可能被 closeAllFileMenus 从 DOM 移除，需重置引用
          if (menuEl && !document.body.contains(menuEl)) menuEl = null;
          if (menuEl && menuEl.classList.contains("open")) { menuEl.classList.remove("open"); return; }
          if (!menuEl) {
            menuEl = document.createElement("div");
            menuEl.className = "file-menu";
            menuEl.innerHTML = `
              <button class="file-menu-item" data-action="open-location">打开文件所在位置</button>
              <button class="file-menu-item" data-action="preview">打开预览</button>`;
            menuEl.querySelector("[data-action='open-location']").addEventListener("click", (ev) => {
              ev.stopPropagation();
              closeAllFileMenus();
              App.openFileLocation(node.path);
            });
            menuEl.querySelector("[data-action='preview']").addEventListener("click", (ev) => {
              ev.stopPropagation();
              closeAllFileMenus();
              App.previewFile(node.path);
            });
            document.body.appendChild(menuEl);
          }
          const rect = moreBtn.getBoundingClientRect();
          menuEl.style.top = (rect.bottom + 2) + "px";
          menuEl.style.left = Math.min(rect.left, window.innerWidth - 160) + "px";
          menuEl.classList.add("open");
          el.classList.add("menu-open");
        });
      }
      return el;
    }
  }

  $("#refresh-files").addEventListener("click", () => App.refreshFiles(true));

  // ── 文件菜单管理 ──
  function closeAllFileMenus() {
    document.querySelectorAll(".file-menu.open").forEach((m) => {
      m.classList.remove("open");
      if (m.parentNode === document.body && !m.dataset.persistent) {
        setTimeout(() => { if (!m.classList.contains("open")) m.remove(); }, 200);
      }
    });
    document.querySelectorAll(".file-item.menu-open, .output-file-item.menu-open").forEach((el) => el.classList.remove("menu-open"));
  }

  function positionFileMenu(menu, btn) {
    menu.style.visibility = "hidden";
    menu.classList.add("open");
    const mw = menu.offsetWidth || 150;
    const mh = menu.offsetHeight || 76;
    let left = Math.min(btn.getBoundingClientRect().right - mw, window.innerWidth - mw - 8);
    left = Math.max(8, left);
    let top = btn.getBoundingClientRect().bottom + 4;
    if (top + mh > window.innerHeight - 8) {
      top = btn.getBoundingClientRect().top - mh - 4;
    }
    menu.style.left = left + "px";
    menu.style.top = Math.max(8, top) + "px";
    menu.style.visibility = "";
  }

  document.addEventListener("click", (e) => {
    const moreBtn = e.target.closest(".file-more");
    if (moreBtn) {
      e.stopPropagation();
      const item = moreBtn.closest(".file-item");
      const menu = moreBtn.closest(".file-actions")?.querySelector(".file-menu");
      if (!menu) return;
      const isOpen = menu.classList.contains("open");
      closeAllFileMenus();
      if (!isOpen) {
        positionFileMenu(menu, moreBtn);
        item?.classList.add("menu-open");
      }
      return;
    }
    if (!e.target.closest(".file-menu")) {
      closeAllFileMenus();
    }
  });

  document.querySelector("#right-panel .panel-scroll")?.addEventListener("scroll", closeAllFileMenus, { passive: true });
  window.addEventListener("resize", closeAllFileMenus);

  // ── 打开文件所在位置 ──
  App.openFileLocation = async function(nameOrOpts) {
    const body = typeof nameOrOpts === "string"
      ? { name: nameOrOpts }
      : (nameOrOpts && nameOrOpts.path ? { path: nameOrOpts.path } : { name: nameOrOpts && nameOrOpts.name });
    try {
      const r = await fetch("/api/open-location", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.success) {
        App.addSystemNote("打开文件位置失败：" + (j.error || r.status));
      }
    } catch (e) {
      App.addSystemNote("打开文件位置请求失败：" + e.message);
    }
  };

  // ── 文件预览 ──
  App.previewFile = async function(name) {
    const url = "/api/output-files/" + encodeURIComponent(name);
    const overlay = $("#preview-overlay");
    const dialog = $("#preview-dialog");
    const frame = $("#preview-frame");
    const openExt = $("#preview-open-external");
    $("#preview-title").textContent = name;
    $("#preview-download").href = url + "?download=1";

    if (/\.html?$/i.test(name)) {
      dialog.classList.add("html-mode");
      openExt.style.display = "";
      openExt.href = url;
      frame.src = url;
      overlay.classList.add("open");
      return;
    }

    dialog.classList.remove("html-mode");
    openExt.style.display = "none";
    $("#preview-body").textContent = "加载中…";
    overlay.classList.add("open");

    // 二进制文件（Excel/Word/PPT/PDF/图片等）：不提供网页预览，提示打开位置查看
    if (BINARY_RE.test(name)) {
      const pb = $("#preview-body");
      pb.classList.remove("md-preview");
      pb.innerHTML = "";
      const box = document.createElement("div");
      box.style.cssText = "padding:4px 2px;";
      box.textContent = "这个文件是二进制格式（Excel / Word / PPT 等），网页里不预览。点击下方「打开位置查看」，在文件夹里直接打开。";
      const btn = document.createElement("button");
      btn.className = "btn-sm";
      btn.textContent = "打开位置查看";
      btn.style.cssText = "margin-top:14px;";
      btn.addEventListener("click", () => App.openFileLocation(name));
      pb.appendChild(box);
      pb.appendChild(btn);
      return;
    }

    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const text = await r.text();
      const pb = $("#preview-body");
      if (/\.md$/i.test(name)) {
        pb.classList.add("md-preview");
        pb.innerHTML = App.renderMarkdown(text || "(空文件)");
      } else {
        pb.classList.remove("md-preview");
        pb.textContent = text || "(空文件)";
      }
    } catch (e) {
      $("#preview-body").textContent = "加载失败：" + e.message;
    }
  };

  function closePreview() {
    $("#preview-overlay").classList.remove("open");
    const frame = $("#preview-frame");
    if (frame) frame.src = "about:blank";
    $("#preview-dialog").classList.remove("html-mode");
  }
  App.closePreview = closePreview;
  $("#preview-close").addEventListener("click", closePreview);
  $("#preview-overlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closePreview();
  });

  // ── Toast 提示 ──
  App.showToast = function(message, isError = false, duration = 2600) {
    let toast = document.getElementById("sapbuddy-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "sapbuddy-toast";
      toast.style.cssText = `
        position: fixed; right: 20px; bottom: 20px; z-index: 200;
        padding: 10px 16px; border-radius: 8px;
        background: var(--bg-surface); color: var(--text);
        border: 1px solid var(--border-strong); box-shadow: var(--shadow-lg);
        font-size: 13px; opacity: 0; transform: translateY(8px);
        transition: opacity 0.18s ease, transform 0.18s ease; pointer-events: none;
      `;
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.style.borderColor = isError ? "#ef4444" : "var(--border-strong)";
    toast.style.color = isError ? "#fca5a5" : "var(--text)";
    toast.style.boxShadow = isError ? "0 6px 20px rgba(239,68,68,.25)" : "var(--shadow-lg)";
    requestAnimationFrame(() => {
      toast.style.opacity = "1";
      toast.style.transform = "translateY(0)";
    });
    clearTimeout(App.showToast._timer);
    App.showToast._timer = setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(8px)";
    }, duration);
  };
})();
