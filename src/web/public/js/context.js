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
    const input = $("#input");
    if (!btn) return;
    App.chatView?.setCompressing(loading);
    if (loading) {
      btn.disabled = true;
      setCompressLoading(btn);
      if (input) input.disabled = true;
    } else {
      btn.disabled = false;
      setCompressIcon(btn);
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
    // 压缩是同步耗时操作，先提示"已开始"，避免压缩期间没有任何反馈
    App.addSystemNote("压缩任务已开始，完成后将通知…");
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
        // success：完成通知"上下文压缩完成，节省约 X tokens"由服务器 compress_result 事件推送，
        // 不再在此重复提示；若该事件因 SSE 异常未送达，兜底释放按钮，避免一直转圈
        setTimeout(() => App.setCompressUI(false), 10000);
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
      const hasBreakdown = Number.isFinite(d.piAgent) && Number.isFinite(d.extensions);
      const row = (label, value) => {
        const known = Number.isFinite(value);
        const pct = d.max ? value / d.max * 100 : 0;
        const share = pct > 0 && pct < 1 ? "<1%" : `${Math.round(pct)}%`;
        return `<div class="ctx-row"><span class="ctx-label indent">${label}</span><span class="ctx-val">${known ? App.formatTokens(value) : "—"} ${known ? `<span class="ctx-pct">${share}</span>` : ""}</span></div>`;
      };
      tip.innerHTML = `
        <div class="ctx-header">上下文用量 <strong>${d.pct}%</strong>（${App.formatTokens(d.total)} / ${App.formatTokens(d.max)}）</div>
        <div class="ctx-bar"><div class="ctx-bar-fill" style="width:${barW}%;background:${barColor}"></div></div>
        <div class="ctx-section-title">系统基础</div>
        <div class="ctx-rows">
          ${row("PI Agent 内置", d.piAgent)}
          ${row("PI Extensions", d.extensions)}
          ${row("MCP 工具", d.mcp)}
        </div>
        <div class="ctx-section-title">项目配置</div>
        <div class="ctx-rows">
          ${row("AGENTS.md", d.agents)}
          ${row("SYSTEM.md", d.systemMd)}
          ${row("Memory.md", d.memory)}
          ${row("技能", d.skills)}
        </div>
        <div class="ctx-section-title">对话</div>
        <div class="ctx-rows">${row("历史消息", d.conversation)}</div>
        <div class="ctx-footer">${d.ready ? `剩余 ${App.formatTokens(d.remaining)} tokens（估算）` : "会话启动后显示实际预算"}${!hasBreakdown ? "<br>后台版本未更新，请重启 SapBuddy 加载用量明细" : ""}${d.autoCompactPct === 80 ? "<br>上下文达到 80% 时自动压缩" : ""}</div>`;
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
    tip.classList.add("visible");
    const { width, height } = tip.getBoundingClientRect();
    const top = anchorRect.top - height - 8 >= 8 ? anchorRect.top - height - 8 : anchorRect.bottom + 8;
    tip.style.left = Math.max(8, Math.min(anchorRect.left - 100, window.innerWidth - width - 8)) + "px";
    tip.style.top = Math.max(8, Math.min(top, window.innerHeight - height - 8)) + "px";
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

  // ── 推理强度（off / high 两态；放在模型下拉菜单中）──
  let currentThinkLevel = "off";

  function updateThinkUI(level) {
    currentThinkLevel = level;
    updateModelButton(); // 更新模型按钮上的推理强度显示
  }

  App.syncThinkLevel = function(stateData) {
    if (stateData && stateData.thinkingLevel) {
      updateThinkUI(stateData.thinkingLevel);
    }
  };

  async function setThinkLevel(level) {
    try {
      const r = await fetch("/api/thinking-level", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level: level }),
      });
      const j = await r.json();
      if (j.success) {
        updateThinkUI(level);
      }
    } catch (err) {
      console.error("切换推理强度失败:", err);
    }
  }

  // ── 模型选择下拉 ──
  let modelSettings = null;
  let currentModel = "";
  let currentProvider = "";

  async function loadModelSettings() {
    try {
      const r = await fetch("/api/settings");
      const j = await r.json();
      if (j.success && j.data) {
        modelSettings = j.data;
        currentProvider = j.data.provider || "deepseek";
        currentModel = j.data.model || "";
        if (j.data.thinkingLevel) currentThinkLevel = j.data.thinkingLevel;
        updateModelButton();
      }
    } catch (e) {
      console.error("加载模型配置失败:", e);
    }
  }

  function updateModelButton() {
    const btn = $("#model-select-btn");
    if (!btn) return;
    const nameEl = btn.querySelector(".model-name");
    if (nameEl) {
      const thinkLabel = currentThinkLevel === "high" ? " · 高" : "";
      nameEl.textContent = (currentModel || currentProvider) + thinkLabel;
    }
  }

  function renderModelDropdown() {
    const dropdown = $("#model-dropdown");
    if (!dropdown || !modelSettings) return;
    dropdown.innerHTML = "";

    // ── 推理强度选项 ──
    const thinkGroup = document.createElement("div");
    const thinkTitle = document.createElement("div");
    thinkTitle.className = "dropdown-group-title";
    thinkTitle.textContent = "推理强度";
    thinkGroup.appendChild(thinkTitle);

    const thinkItem = document.createElement("div");
    thinkItem.className = "dropdown-item dropdown-submenu-trigger";
    thinkItem.innerHTML = `<span>推理强度</span><span class="think-current">${currentThinkLevel === "high" ? "高" : "关"}</span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;
    thinkGroup.appendChild(thinkItem);

    // 推理强度子菜单
    const thinkSubmenu = document.createElement("div");
    thinkSubmenu.className = "dropdown-submenu";
    thinkSubmenu.hidden = true;
    ["off", "high"].forEach((level) => {
      const subItem = document.createElement("div");
      subItem.className = "dropdown-item";
      const label = level === "high" ? "高（深度思考）" : "关（轻量模式）";
      if (currentThinkLevel === level) {
        subItem.classList.add("selected");
        subItem.innerHTML = `<span>${label}</span><span class="check">✓</span>`;
      } else {
        subItem.textContent = label;
      }
      subItem.addEventListener("click", async (e) => {
        e.stopPropagation();
        await setThinkLevel(level);
        dropdown.hidden = true;
      });
      thinkSubmenu.appendChild(subItem);
    });
    thinkGroup.appendChild(thinkSubmenu);

    thinkItem.addEventListener("click", (e) => {
      e.stopPropagation();
      thinkSubmenu.hidden = !thinkSubmenu.hidden;
    });

    dropdown.appendChild(thinkGroup);

    // 分隔线
    const divider = document.createElement("div");
    divider.style.cssText = "height:1px;background:var(--border);margin:6px 4px;";
    dropdown.appendChild(divider);

    // ── 模型列表（仅显示已配置 API key 的提供商）──
    const providers = modelSettings.providers || [];
    for (const p of providers) {
      if (!p.hasKey) continue; // 跳过未配置 API key 的提供商
      if (!p.models || p.models.length === 0) continue;
      const groupTitle = document.createElement("div");
      groupTitle.className = "dropdown-group-title";
      groupTitle.textContent = p.name;
      dropdown.appendChild(groupTitle);
      for (const modelId of p.models) {
        const item = document.createElement("div");
        item.className = "dropdown-item";
        if (p.name === currentProvider && modelId === currentModel) {
          item.classList.add("selected");
          item.innerHTML = `<span>${modelId}</span><span class="check">✓</span>`;
        } else {
          item.textContent = modelId;
        }
        item.addEventListener("click", async () => {
          dropdown.hidden = true;
          try {
            const r = await fetch("/api/settings", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ provider: p.name, model: modelId }),
            });
            const j = await r.json();
            if (j.success) {
              currentProvider = p.name;
              currentModel = modelId;
              updateModelButton();
            }
          } catch (err) {
            console.error("切换模型失败:", err);
          }
        });
        dropdown.appendChild(item);
      }
    }
  }

  const modelSelectBtn = $("#model-select-btn");
  const modelDropdown = $("#model-dropdown");
  if (modelSelectBtn && modelDropdown) {
    modelSelectBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (modelDropdown.hidden) {
        renderModelDropdown();
        modelDropdown.hidden = false;
      } else {
        modelDropdown.hidden = true;
      }
    });
    document.addEventListener("click", (e) => {
      if (!modelDropdown.hidden && !e.target.closest(".model-selector")) {
        modelDropdown.hidden = true;
      }
    });
  }

  // 页面加载时获取模型配置
  App.loadModelSettings = loadModelSettings;
  loadModelSettings();
})();
