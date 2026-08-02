/**
 * 工具调用卡片 — 幂等：同一 toolCallId 复用同一张卡片
 */
"use strict";

(function() {
  const App = window.SapBuddy;
  const state = App.state;
  const escapeHtml = App.escapeHtml;

  // ── 图标映射 ──
  const TOOL_ICONS = {
    abap_ping: "⚡", abap_ls: "🔍", abap_cat: "📄", abap_create: "➕",
    abap_put: "💾", abap_check: "✔", abap_activate: "▶", abap_meta: "▦",
    abap_refs: "↗", abap_dump: "⚠", abap_transport: "📦", abap_status: "ℹ",
    abap_message: "✉", abap_texts: "𝐓", abap_system: "⚙", abap_run: "»",
    read: "📖", bash: "$", edit: "✎", write: "✎", grep: "🔍", find: "🔍", ls: "☰",
  };

  // ── 参数摘要 ──
  App.summarizeArgs = function(args) {
    if (!args) return "";
    let obj = args;
    if (typeof args === "string") {
      try { obj = JSON.parse(args); } catch { return args.length > 90 ? args.slice(0, 90) + "…" : args; }
    }
    if (typeof obj !== "object" || obj === null) return String(obj).slice(0, 90);
    const keys = Object.keys(obj);
    if (!keys.length) return "";
    const parts = keys.map((k) => {
      let v = obj[k];
      if (typeof v === "string" && v.length > 40) v = v.slice(0, 40) + "…";
      return `${k}: ${JSON.stringify(v)}`;
    });
    const s = parts.join(", ");
    return s.length > 90 ? s.slice(0, 90) + "…" : s;
  };

  // ── Skill 识别：read 调用读取 .SapBuddy/skills/xxx/SKILL.md → Skill 卡 ──
  function isSkillRead(name, args) {
    if (name !== "read") return false;
    const s = typeof args === "string" ? args : JSON.stringify(args || {});
    return /skills[\/\\][^\/\\"]+[\/\\]SKILL\.md/i.test(s) || /\.SapBuddy[\/\\]skills[\/\\]/i.test(s);
  }
  function skillNameFrom(args) {
    const s = typeof args === "string" ? args : JSON.stringify(args || {});
    const m = s.match(/skills[\/\\]([^\/\\"]+)/i);
    if (m) return m[1].replace(/\.md$/i, "");
    const m2 = s.match(/([^\/\\"]+)[\/\\]SKILL\.md/i);
    return m2 ? m2[1] : "skill";
  }

  // ── 创建工具卡片 ──
  App.createToolCard = function(id, name, args) {
    if (id && state.toolCards.has(id)) {
      return state.toolCards.get(id);
    }
    const isSkill = isSkillRead(name, args);
    const skillName = isSkill ? skillNameFrom(args) : "";
    const card = document.createElement("div");
    card.className = "tool-card" + (isSkill ? " skill-card" : "");
    card.dataset.toolName = name || "";
    card.innerHTML = `
      <div class="tool-head">
        <span class="tool-caret">▸</span>
        <span class="tool-icon">${isSkill ? "📘" : (TOOL_ICONS[name] || "🔧")}</span>
        <span class="tool-name"></span>
        <span class="tool-args"></span>
        <span class="tool-state running"><span class="spinner"></span> 执行中</span>
      </div>
      <div class="tool-body"></div>`;
    card.querySelector(".tool-name").textContent = isSkill ? ("Skill: " + skillName) : (name || "tool");
    card.querySelector(".tool-args").textContent = isSkill ? "加载技能说明" : App.summarizeArgs(args);
    const bodyEl = card.querySelector(".tool-body");
    bodyEl.style.display = "none"; // 内联兜底：折叠必隐藏（不依赖 CSS）
    if (isSkill) {
      // Skill 卡：只显示调用了哪个 skill，不可展开看内容
      bodyEl.innerHTML = "";
      card.querySelector(".tool-head").style.cursor = "default";
      card.querySelector(".tool-head").title = "Skill 调用";
    } else {
      card.querySelector(".tool-head").addEventListener("click", () => {
        const expanded = card.classList.toggle("expanded");
        bodyEl.style.display = expanded ? "block" : "none"; // JS 直接控制展开/折叠
      });
    }
    if (id) state.toolCards.set(id, card);
    // 强制兜底：非展开状态 body 必隐藏（定时扫描也兜底）
    bodyEl.style.display = "none";
    return card;
  };

  // ── 全局强制：非展开卡片 body 一律隐藏（防任何 CSS/JS 意外）──
  function enforceToolCollapse() {
    document.querySelectorAll(".tool-card").forEach((c) => {
      const b = c.querySelector(".tool-body");
      if (!b) return;
      if (c.classList.contains("expanded")) {
        b.style.display = "block";
      } else {
        b.style.display = "none";
      }
    });
  }
  App.enforceToolCollapse = enforceToolCollapse;
  // 渲染完成后立即执行 + 定时扫描兜底
  setInterval(enforceToolCollapse, 1200);

  // ── 完成工具卡片 ──
  App.finishToolCard = function(id, resultContent, isError) {
    const card = state.toolCards.get(id);
    if (!card) return;
    const stateEl = card.querySelector(".tool-state");
    stateEl.className = "tool-state " + (isError ? "failed" : "done");
    stateEl.textContent = isError ? "✗ 失败" : "✓ 完成";
    const body = card.querySelector(".tool-body");
    let text = "";
    if (Array.isArray(resultContent)) {
      text = resultContent.map((c) => c.text || "").join("\n");
    } else if (typeof resultContent === "string") {
      text = resultContent;
    }
    if (text.length > 8000) text = text.slice(0, 8000) + "\n…（结果过长已截断）";
    body.innerHTML = "";
    const pre = document.createElement("pre");
    pre.className = "tool-code";
    pre.textContent = text || "(无输出)";
    body.appendChild(pre);
    // 完成时不改变折叠状态（保持 JS 内联控制）
  };
})();
