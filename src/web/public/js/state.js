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
  currentTextDiv: null,
  pendingTexts: [],
  toolCards: new Map(),
  es: null,
  historyOpen: false,
  processEl: null,
  currentThinkSeg: null,
  messageCount: 0,
};

// ── 工具函数 ──
App.$ = (sel) => document.querySelector(sel);

App.escapeHtml = function(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
