/**
 * 全局状态 + 工具函数
 * 所有模块通过 window.SapBuddy 命名空间共享
 */
"use strict";

const App = window.SapBuddy || (window.SapBuddy = {});

// ── 全局状态 ──
App.state = {
  streaming: false,
  creating: false,
  rebuilding: false,
  configStatus: "ok",
  currentPath: undefined,
  currentGen: 0,
  currentAssistantEl: null,
  es: null,
  historyOpen: false,
  messageCount: 0,
  sessions: [],
};

// ── 工具函数 ──
App.$ = (sel) => document.querySelector(sel);

// 文件树与「打开位置」沿用同一组线性图标，避免系统 emoji 因平台而变色或变形。
App.treeIcons = {
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
};

App.escapeHtml = function(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
};

App.formatTime = function(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  if (sameDay) return hm;
  return (d.getMonth() + 1) + "/" + d.getDate() + " " + hm;
};

App.formatTokens = function(n) {
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
};
