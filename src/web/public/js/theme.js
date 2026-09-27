/**
 * 主题布局 — 浅色/深色切换 + 左右侧栏折叠
 */
"use strict";

(function() {
  const App = window.SapBuddy;
  const $ = App.$;

  // ── 主题切换 ──
  const themeToggleBtn = document.getElementById("theme-toggle");
  App.applyTheme = function(t) {
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem("abap-studio-theme", t); } catch (e) {}
  };
  // 当前是否深色（markdown/Mermaid 等模块用）
  App.isDark = function() {
    return document.documentElement.getAttribute("data-theme") === "dark";
  };
  if (themeToggleBtn) {
    themeToggleBtn.addEventListener("click", () => {
      const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      App.applyTheme(next);
    });
  }

  // ── 左右侧栏折叠 ──
  const leftToggle = document.getElementById("left-toggle");
  const rightToggle = document.getElementById("right-toggle");
  const appEl = document.getElementById("app");
  const narrow = window.matchMedia("(max-width: 900px)");
  const backdrop = document.createElement("button");
  backdrop.type = "button";
  backdrop.className = "panel-backdrop";
  backdrop.setAttribute("aria-label", "关闭侧栏");
  appEl.appendChild(backdrop);
  function syncPanels() {
    for (const [side, button, id] of [["left", leftToggle, "sidebar"], ["right", rightToggle, "right-panel"]]) {
      const open = narrow.matches ? appEl.classList.contains(`mobile-${side}-open`) : !appEl.classList.contains(`${side}-collapsed`);
      button?.setAttribute("aria-expanded", String(open));
      button?.setAttribute("aria-controls", id);
      document.getElementById(id).inert = !open;
    }
  }
  function closeMobilePanels() {
    appEl.classList.remove("mobile-left-open", "mobile-right-open");
    syncPanels();
  }
  backdrop.addEventListener("click", () => {
    const opener = appEl.classList.contains("mobile-left-open") ? leftToggle : rightToggle;
    closeMobilePanels(); opener?.focus();
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && narrow.matches && (appEl.classList.contains("mobile-left-open") || appEl.classList.contains("mobile-right-open"))) backdrop.click();
  });
  narrow.addEventListener("change", closeMobilePanels);
  function togglePanel(side) {
    if (narrow.matches) {
      const open = appEl.classList.contains(`mobile-${side}-open`);
      closeMobilePanels();
      if (!open) appEl.classList.add(`mobile-${side}-open`);
      syncPanels();
    } else {
      appEl.classList.toggle(`${side}-collapsed`);
      App.persistPanels(); syncPanels();
    }
  }
  document.getElementById("sidebar").addEventListener("click", event => {
    if (narrow.matches && event.target.closest(".session-item, #new-chat-btn, #sidebar-settings")) closeMobilePanels();
  });

  App.persistPanels = function() {
    try {
      localStorage.setItem("abap-studio-panels", JSON.stringify({
        left: appEl.classList.contains("left-collapsed"),
        right: appEl.classList.contains("right-collapsed"),
      }));
    } catch (e) {}
  };

  if (leftToggle) leftToggle.addEventListener("click", () => {
    togglePanel("left");
  });
  if (rightToggle) rightToggle.addEventListener("click", () => {
    togglePanel("right");
  });

  // 恢复已保存的折叠状态
  try {
    const saved = JSON.parse(localStorage.getItem("abap-studio-panels") || "{}");
    if (saved.left) appEl.classList.add("left-collapsed");
    if (saved.right) appEl.classList.add("right-collapsed");
  } catch (e) {}
  syncPanels();
})();
