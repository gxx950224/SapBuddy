/**
 * 上下文压缩 + tooltip + 深度思考开关
 */
"use strict";

(function() {
  const App = window.SapBuddy;
  const state = App.state;
  const $ = App.$;

  // ── 压缩图标 ──
  const COMPRESS_ICON = `<svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor"><path d="M4 0h8v2H4V0ZM4 4h8v2H4V4ZM2 8h12v2H2V8ZM2 12h12v2H2v-2Z"/></svg>`;
  const SPINNER_ICON = `<svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 0 1 8 8h-2A6 6 0 0 0 8 2V0Zm0 2A6 6 0 0 0 2 8H0a8 8 0 0 1 8-8V2Z"/></svg>`;

  function setCompressIcon(btn) {
    if (!btn) return;
    btn.classList.remove("loading");
    btn.innerHTML = COMPRESS_ICON;
  }
  function setCompressLoading(btn) {
    if (!btn) return;
    btn.classList.add("loading");
    btn.innerHTML = SPINNER_ICON;
  }

  App.setCompressUI = function(loading) {
    const btn = $("#compress-btn");
    const send = $("#send-btn");
    const input = $("#input");
    if (!btn) return;
    if (loading) {
      btn.disabled = true;
      setCompressLoading(btn);
      if (send) send.disabled = true;
      if (input) input.disabled = true;
    } else {
      btn.disabled = false;
      setCompressIcon(btn);
      if (send) send.disabled = false;
      if (input) input.disabled = false;
    }
  };

  // ── 压缩按钮点击 ──
  $("#compress-btn").addEventListener("click", async () => {
    if (state.streaming) {
      App.addSystemNote("生成中，请先停止再压缩");
      return;
    }
    // 不在此拦截"消息太少"：messageCount 是消息条数，会话加载/压缩后可能很小，
    // 但对话 tokens（上下文用量）可能仍很大——以服务器 /api/compress 的真实判断为准
    App.setCompressUI(true);
    try {
      const r = await fetch("/api/compress", { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        App.addSystemNote("压缩失败：" + (j.error || r.status));
        App.setCompressUI(false);
      } else if (!j.success) {
        App.addSystemNote(j.error || "当前对话没有可压缩的内容");
        App.setCompressUI(false);
      } else {
        App.addSystemNote("压缩任务已开始，完成后将通知…");
      }
    } catch (e) {
      App.addSystemNote("压缩请求失败：" + e.message);
      App.setCompressUI(false);
    }
  });

  // ── 上下文用量 tooltip ──
  let ctxTooltip = null;
  let ctxTooltipTimer = null;
  window._ctxTooltip = null;  // 供 events.js 引用

  function ensureCtxTooltip() {
    if (ctxTooltip) return ctxTooltip;
    ctxTooltip = document.createElement("div");
    ctxTooltip.id = "ctx-tooltip";
    ctxTooltip.className = "ctx-tooltip";
    ctxTooltip.innerHTML = '<div class="ctx-loading">加载中…</div>';
    document.body.appendChild(ctxTooltip);
    // 绑定 hover
    ctxTooltip.addEventListener("mouseenter", () => { if (ctxTooltipTimer) { clearTimeout(ctxTooltipTimer); ctxTooltipTimer = null; } });
    ctxTooltip.addEventListener("mouseleave", hideCtxTooltip);
    window._ctxTooltip = ctxTooltip;
    return ctxTooltip;
  }

  function hideCtxTooltip() {
    if (ctxTooltipTimer) { clearTimeout(ctxTooltipTimer); ctxTooltipTimer = null; }
    if (ctxTooltip) ctxTooltip.classList.remove("visible");
  }

  App.refreshCtxTooltip = async function(anchorRect) {
    try {
      const r = await fetch("/api/context-stats");
      const j = await r.json();
      if (!j.success) return;
      const d = j.data;
      const barW = d.pct > 100 ? 100 : d.pct;
      const barColor = d.pct > 90 ? "var(--err)" : d.pct > 70 ? "var(--warn,#f0ad4e)" : "var(--accent)";
      const tip = ensureCtxTooltip();
      tip.innerHTML = `
        <div class="ctx-header">上下文用量 <strong>${d.pct}%</strong>（${App.formatTokens(d.total)} / ${App.formatTokens(d.max)}）${d.cache ? `  <span class="ctx-cache">缓存 ${App.formatTokens(d.cache)}（${d.pctCache}%）</span>` : ""}</div>
        <div class="ctx-bar"><div class="ctx-bar-fill" style="width:${barW}%;background:${barColor}"></div></div>
        <div class="ctx-section-title">系统基础</div>
        <div class="ctx-rows">
          <div class="ctx-row"><span class="ctx-label indent">PI Agent 内置</span><span class="ctx-val">${App.formatTokens(d.piAgent)} <span class="ctx-pct">${d.pctPiAgent}%</span></span></div>
          <div class="ctx-row"><span class="ctx-label indent">PI Extensions</span><span class="ctx-val">${App.formatTokens(d.extensions)} <span class="ctx-pct">${d.pctExtensions}%</span></span></div>
          <div class="ctx-row"><span class="ctx-label indent">MCP 工具</span><span class="ctx-val">${App.formatTokens(d.mcp)} <span class="ctx-pct">${d.pctMcp}%</span></span></div>
        </div>
        <div class="ctx-section-title">项目配置</div>
        <div class="ctx-rows">
          <div class="ctx-row"><span class="ctx-label indent">AGENTS.md</span><span class="ctx-val">${App.formatTokens(d.agents)} <span class="ctx-pct">${d.pctAgents}%</span></span></div>
          <div class="ctx-row"><span class="ctx-label indent">SYSTEM.md</span><span class="ctx-val">${App.formatTokens(d.systemMd)} <span class="ctx-pct">${d.pctSystemMd}%</span></span></div>
          <div class="ctx-row"><span class="ctx-label indent">Memory.md</span><span class="ctx-val">${App.formatTokens(d.memory)} <span class="ctx-pct">${d.pctMemory}%</span></span></div>
          <div class="ctx-row"><span class="ctx-label indent">技能</span><span class="ctx-val">${App.formatTokens(d.skills)} <span class="ctx-pct">${d.pctSkills}%</span></span></div>
        </div>
        <div class="ctx-section-title">对话</div>
        <div class="ctx-rows">
          <div class="ctx-row"><span class="ctx-label indent">历史消息</span><span class="ctx-val">${App.formatTokens(d.conversation)} <span class="ctx-pct">${d.pctConv}%</span></span></div>
        </div>
        <div class="ctx-footer">剩余 ${App.formatTokens(d.remaining)} tokens</div>`;
      // 数据就绪后再显示（鼠标已移开则不弹）
      if (!_ctxHoverActive) return;
      showCtxTooltipAt(anchorRect || _ctxAnchorRect);
      return tip;
    } catch { /* 忽略 */ }
  };

  let _ctxHoverTimer = null;
  let _ctxHoverActive = false;
  let _ctxAnchorRect = null;

  function showCtxTooltipAt(anchorRect) {
    const tip = ensureCtxTooltip();
    const H = 330; // tooltip 完整高度估算
    let top = anchorRect.top - H - 8 >= 8 ? anchorRect.top - H - 8 : anchorRect.bottom + 8;
    tip.style.left = Math.min(Math.max(8, anchorRect.left - 100), window.innerWidth - 260) + "px";
    tip.style.top = Math.min(top, window.innerHeight - 16) + "px";
    tip.classList.add("visible");
  }

  $("#compress-btn").addEventListener("mouseenter", (e) => {
    _ctxHoverActive = true;
    const rect = e.target.getBoundingClientRect();
    _ctxAnchorRect = rect;
    if (_ctxHoverTimer) clearTimeout(_ctxHoverTimer);
    _ctxHoverTimer = setTimeout(() => {
      // 数据就绪后再显示，避免“先上边后下边”的填充跳跃
      App.refreshCtxTooltip(rect);
    }, 200); // 防抖：停留 200ms 后才请求
  });
  $("#compress-btn").addEventListener("mouseleave", () => {
    _ctxHoverActive = false;
    ctxTooltipTimer = setTimeout(hideCtxTooltip, 150);
  });

  // ── 思考等级开关（off / high 两态；deepseek-v4-flash 不支持 medium，故以 off 作轻量默认档）──
  let currentThinkLevel = "off";

  function updateThinkUI(level) {
    currentThinkLevel = level;
    const btn = $("#think-btn");
    if (btn) {
      btn.dataset.level = level;
      if (level === "high") {
        btn.title = "思考等级：高（深度思考）";
        btn.style.color = "#818cf8";
      } else {
        btn.title = "思考等级：关（轻量模式）";
        btn.style.color = "#737373";
      }
    }
  }

  App.syncThinkLevel = function(stateData) {
    if (stateData && stateData.thinkingLevel) {
      updateThinkUI(stateData.thinkingLevel);
    }
  };

  $("#think-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    const next = currentThinkLevel === "high" ? "off" : "high";
    const label = next === "high" ? "高（深度思考）" : "关（轻量）";
    try {
      const r = await fetch("/api/thinking-level", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level: next }),
      });
      const j = await r.json();
      if (j.success) {
        updateThinkUI(next);
        App.addSystemNote("思考等级已切换为：" + label);
      } else {
        App.addSystemNote("切换失败：" + (j.error || r.status));
      }
    } catch (err) {
      App.addSystemNote("切换失败：" + err.message);
    }
  });
})();
