/**
 * 主题布局 — 浅色/深色切换 + 左右侧栏折叠
 */
"use strict";

(function() {
  const App = window.AbapBuddy;
  const $ = App.$;

  // ── 主题切换 ──
  const themeToggleBtn = document.getElementById("theme-toggle");
  App.applyTheme = function(t) {
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem("abap-studio-theme", t); } catch (e) {}
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

  App.persistPanels = function() {
    try {
      localStorage.setItem("abap-studio-panels", JSON.stringify({
        left: appEl.classList.contains("left-collapsed"),
        right: appEl.classList.contains("right-collapsed"),
      }));
    } catch (e) {}
  };

  if (leftToggle) leftToggle.addEventListener("click", () => {
    appEl.classList.toggle("left-collapsed");
    App.persistPanels();
  });
  if (rightToggle) rightToggle.addEventListener("click", () => {
    appEl.classList.toggle("right-collapsed");
    App.persistPanels();
  });

  // 恢复已保存的折叠状态
  try {
    const saved = JSON.parse(localStorage.getItem("abap-studio-panels") || "{}");
    if (saved.left) appEl.classList.add("left-collapsed");
    if (saved.right) appEl.classList.add("right-collapsed");
  } catch (e) {}
})();
