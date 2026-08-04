/**
 * 设置弹窗 — LLM/SAP/MCP/Memory/Skills/Prompts 面板 + 编辑/预览切换
 */
"use strict";

(function() {
  const App = window.SapBuddy;
  const state = App.state;
  const $ = App.$;
  const escapeHtml = App.escapeHtml;
  const renderMarkdown = App.renderMarkdown;

  const DEFAULT_SETTINGS = { provider: "deepseek", model: "", apiKey: "", contextTokens: 200000 };

  // 模型供应商清单（对应 .SapBuddy/models.json 的 providers，即 pi SDK 支持的全部厂商）
  const DOMESTIC_PROVIDERS = {
    qwen: { label: "通义千问（Qwen）", defaultModel: "qwen-plus" },
    moonshot: { label: "Moonshot（Kimi）", defaultModel: "moonshot-v1-8k" },
    zhipu: { label: "智谱（GLM）", defaultModel: "glm-4-plus" },
    doubao: { label: "豆包（Doubao）", defaultModel: "doubao-pro-32k" },
    minimax: { label: "MiniMax", defaultModel: "MiniMax-M2.7" },
    hunyuan: { label: "腾讯混元", defaultModel: "hunyuan-turbo" },
    ernie: { label: "百度文心（ERNIE）", defaultModel: "ernie-4.5" },
    deepseek: { label: "DeepSeek（深度求索）", defaultModel: "deepseek-v4-flash" },
  };

  // ── 从后端读取大模型配置 ──
  async function fetchSettings() {
    try {
      const r = await fetch("/api/settings");
      const j = await r.json();
      if (j.success && j.data) return { ...DEFAULT_SETTINGS, ...j.data };
    } catch { /* 忽略 */ }
    return { ...DEFAULT_SETTINGS };
  }

  // ── 填充提供商下拉框 ──
  function populateProviderSelect() {
    const sel = $("#llm-provider");
    sel.innerHTML = "";
    for (const [key, p] of Object.entries(DOMESTIC_PROVIDERS)) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = p.label;
      sel.appendChild(opt);
    }
  }
  populateProviderSelect();

  // ── 获取表单值 ──
  function getSettingsFormValues() {
    return {
      provider: $("#llm-provider").value,
      model: $("#llm-model").value.trim(),
      apiKey: $("#llm-key").value,
      contextTokens: parseInt($("#llm-context-tokens").value, 10) || 200000,
    };
  }

  function ensureProviderOption(provider) {
    if (!provider) return;
    const sel = $("#llm-provider");
    if (![...sel.options].some((o) => o.value === provider)) {
      const opt = document.createElement("option");
      opt.value = provider;
      opt.textContent = provider;
      sel.appendChild(opt);
    }
  }

  function applySettingsToForm(settings) {
    const s = settings || DEFAULT_SETTINGS;
    ensureProviderOption(s.provider);
    $("#llm-provider").value = s.provider || "deepseek";
    $("#llm-model").value = s.model || "";
    const keyInput = $("#llm-key");
    const keyToggle = $("#llm-key-toggle");
    if (s.apiKey) {
      keyInput.value = s.apiKey;
      keyInput.placeholder = "";
    } else {
      keyInput.value = "";
      keyInput.placeholder = "未配置，请输入 API Key";
    }
    // 空值或占位符时明文显示，真实 key 时密码隐藏
    const isPlaceholder = !s.apiKey || s.apiKey === "请输入你的API_KEY";
    keyInput.type = isPlaceholder ? "text" : "password";
    if (keyToggle) {
      keyToggle.innerHTML = isPlaceholder
        ? '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 5a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3Zm0 5a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z"/><path d="M8 2C4.5 2 1.5 4.5.5 8c1 3.5 4 6 7.5 6s6.5-2.5 7.5-6c-1-3.5-4-6-7.5-6ZM8 12c-2.8 0-5.2-2-6-4 .8-2 3.2-4 6-4s5.2 2 6 4c-.8 2-3.2 4-6 4Z"/></svg>'
        : '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3c-3.5 0-6.5 2.5-7.5 6 1 3.5 4 6 7.5 6s6.5-2.5 7.5-6c-1-3.5-4-6-7.5-6Zm0 10c-2.8 0-5.2-2-6-4 .8-2 3.2-4 6-4s5.2 2 6 4c-.8 2-3.2 4-6 4Zm0-7a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3Zm0 5a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z"/><path d="M2.5 1.5l12 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
      keyToggle.title = isPlaceholder ? "隐藏 Key" : "显示 Key";
    }
    $("#llm-context-tokens").value = s.contextTokens || 200000;
  }

  // ── 打开/关闭设置 ──
  async function openSettings() {
    clearKeyError();
    $("#settings-overlay").classList.add("open");
    applySettingsToForm(await fetchSettings());
    loadMcpConfig();
    startMcpPolling();
    loadMemory();
    loadSkillTree();
    App.loadPrompt("AGENTS.md");
    loadSapConfig();
  }

  function closeSettings() {
    stopMcpPolling();
    $("#settings-overlay").classList.remove("open");
  }

  // ============ MCP 设置面板 ============
  const mcpExpanded = new Set();
  let mcpPollTimer = null;

  async function loadMcpConfig() {
    try {
      const r = await fetch("/api/mcp");
      const j = await r.json();
      if (!j.success) return;
      $("#mcp-config").value = JSON.stringify(j.config || {}, null, 2);
      clearMcpError();
      renderMcpStatus(j.status || []);
    } catch (e) { /* 忽略 */ }
  }

  function renderMcpStatus(status) {
    const wrap = $("#mcp-servers");
    if (!status.length) {
      wrap.innerHTML = '<div class="empty-hint">暂无 MCP 服务</div>';
      return;
    }
    wrap.innerHTML = "";
    for (const s of status) {
      const el = document.createElement("div");
      el.className = "mcp-server" + (mcpExpanded.has(s.name) ? " open" : "");
      const stateClass = s.connecting ? "pending" : (s.connected ? "ok" : "err");
      const stateText = s.connecting ? "连接中…" : (s.connected ? "已连接" : "未连接");
      const dotClass = s.connected ? "ok" : (s.connecting ? "" : "err");
      const toolsHtml = (s.tools && s.tools.length)
        ? s.tools.map((t) => `<div class="mcp-tool"><div class="mcp-tool-name">${escapeHtml(t.name)}</div><div class="mcp-tool-desc">${escapeHtml(t.description || "（无描述）")}</div></div>`).join("")
        : '<div class="mcp-empty-tools">无可用工具</div>';
      el.innerHTML = `
        <div class="mcp-server-row">
          <span class="mcp-server-chevron">▶</span>
          <span class="dot ${dotClass}"></span>
          <span class="mcp-server-name">${escapeHtml(s.name)}</span>
          <span class="mcp-server-url">${escapeHtml(s.url || "")}</span>
          <span class="mcp-server-state ${stateClass}">${stateText}</span>
        </div>
        ${s.error && !s.connected ? `<div class="mcp-server-error">${escapeHtml(s.error)}</div>` : ""}
        <div class="mcp-server-tools">${toolsHtml}</div>`;
      const row = el.querySelector(".mcp-server-row");
      row.addEventListener("click", () => {
        if (mcpExpanded.has(s.name)) mcpExpanded.delete(s.name);
        else mcpExpanded.add(s.name);
        el.classList.toggle("open");
      });
      wrap.appendChild(el);
    }
  }

  let _mcpPollingBusy = false;
  async function refreshMcpStatus() {
    if (_mcpPollingBusy) return; // 防止请求堆积
    _mcpPollingBusy = true;
    try {
      const r = await fetch("/api/mcp");
      const j = await r.json();
      if (j.success) renderMcpStatus(j.status || []);
    } catch (e) { /* 忽略 */ }
    finally { _mcpPollingBusy = false; }
  }

  function startMcpPolling() {
    stopMcpPolling();
    mcpPollTimer = setInterval(refreshMcpStatus, 3000);
  }
  function stopMcpPolling() {
    if (mcpPollTimer) { clearInterval(mcpPollTimer); mcpPollTimer = null; }
  }

  function clearMcpError() {
    const el = $("#mcp-config-error");
    if (el) { el.style.display = "none"; el.textContent = ""; }
    $("#mcp-config").classList.remove("invalid");
  }
  function showMcpError(msg) {
    const el = $("#mcp-config-error");
    if (el) { el.textContent = msg; el.style.display = "block"; }
    $("#mcp-config").classList.add("invalid");
  }

  // MCP 保存
  $("#mcp-save").addEventListener("click", async () => {
    const ta = $("#mcp-config");
    const raw = ta.value.trim();
    let config;
    try { config = JSON.parse(raw); } catch (e) {
      showMcpError("JSON 解析失败：" + e.message);
      return;
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      showMcpError("MCP 配置必须是一个对象（键=服务器名，值=配置），不能是数组");
      return;
    }
    for (const [name, cfg] of Object.entries(config)) {
      if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
        showMcpError(`服务器「${name}」的配置必须是一个对象`);
        return;
      }
      if (!cfg.url || typeof cfg.url !== "string") {
        // 已禁用的服务器允许无 url（历史数据展示），启用中的必须可连
        if (!cfg.disabled) {
          showMcpError(`服务器「${name}」缺少 url`);
          return;
        }
      }
    }
    clearMcpError();
    const btn = $("#mcp-save");
    btn.disabled = true;
    try {
      const r = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });
      const j = await r.json();
      if (j.success) {
        App.showToast(j.message || "MCP 配置已保存并立即生效");
        setTimeout(refreshMcpStatus, 600);
      } else {
        showMcpError(j.error || "保存失败");
      }
    } catch (e) {
      showMcpError("保存失败：" + e.message);
    } finally {
      btn.disabled = false;
    }
  });

  // MCP 格式化
  $("#mcp-format").addEventListener("click", () => {
    const ta = $("#mcp-config");
    try {
      const cfg = JSON.parse(ta.value.trim());
      if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
        showMcpError("MCP 配置必须是一个 JSON 对象（非数组）");
        return;
      }
      ta.value = JSON.stringify(cfg, null, 2);
      clearMcpError();
    } catch (e) {
      showMcpError("无法格式化（JSON 非法）：" + e.message);
    }
  });

  // ============ 记忆面板 ============
  async function loadMemory() {
    try {
      const r = await fetch("/api/memory");
      const j = await r.json();
      if (j.success) {
        $("#memory-editor").value = j.data.content;
        $("#memory-path").textContent = j.data.path || "Memory.md";
        setEditorStatus("memory-status", "ok", "");
        activatePreview("memory-editor", "memory-preview");
      }
    } catch (e) {
      setEditorStatus("memory-status", "err", "加载失败：" + e.message);
    }
  }

  $("#memory-save").addEventListener("click", async () => {
    const content = $("#memory-editor").value;
    const btn = $("#memory-save");
    btn.disabled = true;
    try {
      const r = await fetch("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const j = await r.json();
      if (j.success) {
        setEditorStatus("memory-status", "ok", j.message);
      } else {
        setEditorStatus("memory-status", "err", j.error);
      }
    } catch (e) {
      setEditorStatus("memory-status", "err", "保存失败：" + e.message);
    } finally {
      btn.disabled = false;
    }
  });

  $("#memory-open-location").addEventListener("click", () => {
    fetch("/api/memory").then(r => r.json()).then(j => {
      if (j.success && j.data && j.data.path) App.openFileLocation({ path: j.data.path });
    });
  });

  // ============ 技能面板 ============
  let skillTreeData = null;

  async function loadSkillTree() {
    try {
      const r = await fetch("/api/skills");
      const j = await r.json();
      if (j.success) {
        skillTreeData = j.data.tree;
        renderSkillTree(skillTreeData);
      }
    } catch (e) { /* 忽略 */ }
  }

  function renderSkillTree(tree) {
    const wrap = $("#skill-tree");
    wrap.innerHTML = "";
    for (const node of tree) {
      wrap.appendChild(createSkillTreeNode(node, 0));
    }
  }

  function createSkillTreeNode(node, depth) {
    if (node.type === "dir") {
      const el = document.createElement("div");
      el.style.paddingLeft = (depth * 16) + "px";
      el.className = "skill-tree-dir";
      el.innerHTML = `<span class="skill-tree-arrow">▶</span><span class="skill-tree-icon">📁</span><span class="skill-tree-name">${escapeHtml(node.name)}</span>`;
      const childrenWrap = document.createElement("div");
      childrenWrap.className = "skill-tree-children";
      for (const child of (node.children || [])) {
        childrenWrap.appendChild(createSkillTreeNode(child, depth + 1));
      }
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        el.classList.toggle("open");
      });
      const frag = document.createDocumentFragment();
      frag.appendChild(el);
      frag.appendChild(childrenWrap);
      return frag;
    } else {
      const el = document.createElement("div");
      el.style.paddingLeft = (depth * 16) + "px";
      el.className = "skill-tree-file";
      el.dataset.path = node.path;
      el.innerHTML = `<span class="skill-tree-arrow" style="visibility:hidden">▶</span><span class="skill-tree-icon">📄</span><span class="skill-tree-name">${escapeHtml(node.name)}</span>`;
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        selectSkillFile(node.path, node.name, el);
      });
      return el;
    }
  }

  function selectSkillFile(filePath, fileName, el) {
    document.querySelectorAll(".skill-tree-file.active").forEach((f) => f.classList.remove("active"));
    if (el) el.classList.add("active");
    $("#skill-editor-empty").style.display = "none";
    $("#skill-editor-area").style.display = "";
    $("#skill-file-path").textContent = filePath;
    setEditorStatus("skill-status", "", "");
    fetch(`/api/skills?file=${encodeURIComponent(filePath)}`)
      .then(r => r.json())
      .then(j => {
        if (j.success) {
          $("#skill-editor").value = j.data.content;
          $("#skill-editor").dataset.file = filePath;
          setEditorStatus("skill-status", "ok", "");
          activatePreview("skill-editor", "skill-preview");
        } else {
          setEditorStatus("skill-status", "err", j.error);
        }
      })
      .catch(e => setEditorStatus("skill-status", "err", "加载失败：" + e.message));
  }

  $("#skill-save").addEventListener("click", async () => {
    const filePath = $("#skill-editor").dataset.file;
    if (!filePath) return;
    const content = $("#skill-editor").value;
    const btn = $("#skill-save");
    btn.disabled = true;
    try {
      const r = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: filePath, content }),
      });
      const j = await r.json();
      if (j.success) {
        setEditorStatus("skill-status", "ok", j.message);
      } else {
        setEditorStatus("skill-status", "err", j.error);
      }
    } catch (e) {
      setEditorStatus("skill-status", "err", "保存失败：" + e.message);
    } finally {
      btn.disabled = false;
    }
  });

  $("#skill-open-location").addEventListener("click", () => {
    const filePath = $("#skill-editor").dataset.file;
    if (!filePath) return;
    fetch(`/api/skills?file=${encodeURIComponent(filePath)}`)
      .then(r => r.json())
      .then(j => { if (j.success && j.data && j.data.path) App.openFileLocation({ path: j.data.path }); });
  });

  // ============ 提示词面板 ============
  let currentPromptFile = "AGENTS.md";

  App.loadPrompt = async function(fileName) {
    currentPromptFile = fileName;
    $("#prompt-file-path").textContent = fileName;
    setEditorStatus("prompt-status", "", "");
    try {
      const r = await fetch(`/api/prompt?file=${encodeURIComponent(fileName)}`);
      const j = await r.json();
      if (j.success) {
        $("#prompt-editor").value = j.data.content;
        if ($("#prompt-preview").style.display !== "none") {
          $("#prompt-preview").innerHTML = renderMarkdown(j.data.content);
        }
        setEditorStatus("prompt-status", "ok", "");
        activatePreview("prompt-editor", "prompt-preview");
      }
    } catch (e) {
      setEditorStatus("prompt-status", "err", "加载失败：" + e.message);
    }
  };

  $("#prompt-save").addEventListener("click", async () => {
    const content = $("#prompt-editor").value;
    const btn = $("#prompt-save");
    btn.disabled = true;
    try {
      const r = await fetch("/api/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: currentPromptFile, content }),
      });
      const j = await r.json();
      if (j.success) {
        setEditorStatus("prompt-status", "ok", j.message);
        $("#prompt-restart").style.display = "";
      } else {
        setEditorStatus("prompt-status", "err", j.error);
      }
    } catch (e) {
      setEditorStatus("prompt-status", "err", "保存失败：" + e.message);
    } finally {
      btn.disabled = false;
    }
  });

  $("#prompt-open-location").addEventListener("click", () => {
    fetch(`/api/prompt?file=${encodeURIComponent(currentPromptFile)}`)
      .then(r => r.json())
      .then(j => { if (j.success && j.data && j.data.path) App.openFileLocation({ path: j.data.path }); });
  });

  // 技能面板折叠
  $("#skill-tree-collapse").addEventListener("click", () => {
    const panel = $("#skill-tree-panel");
    panel.classList.toggle("collapsed");
  });

  // 提示词子标签
  document.querySelectorAll(".prompt-subtab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".prompt-subtab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const fileName = tab.dataset.prompt;
      if (fileName) {
        currentPromptFile = fileName;
        App.loadPrompt(fileName);
      }
    });
  });

  // ============ 通用编辑器工具 ============
  function setEditorStatus(id, cls, msg) {
    const el = $("#" + id);
    if (!el) return;
    el.textContent = msg;
    el.className = "editor-status";
    if (cls) el.classList.add(cls);
  }

  // 编辑/预览模式切换
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".mode-toggle-btn");
    if (!btn) return;
    e.preventDefault();
    const toggle = btn.closest(".mode-toggle");
    if (!toggle) return;
    toggle.querySelectorAll(".mode-toggle-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const editorId = btn.dataset.editor;
    const previewId = btn.dataset.preview;
    const editorEl = editorId ? $("#" + editorId) : null;
    const previewEl = previewId ? $("#" + previewId) : null;
    if (btn.dataset.mode === "preview") {
      if (previewEl && editorEl) {
        previewEl.innerHTML = renderMarkdown(editorEl.value);
        editorEl.style.display = "none";
        previewEl.style.display = "";
      }
    } else {
      if (previewEl && editorEl) {
        previewEl.style.display = "none";
        editorEl.style.display = "";
      }
    }
  });

  function activatePreview(editorId, previewId) {
    const editorEl = editorId ? $("#" + editorId) : null;
    const previewEl = previewId ? $("#" + previewId) : null;
    if (!editorEl || !previewEl) return;
    previewEl.innerHTML = renderMarkdown(editorEl.value);
    editorEl.style.display = "none";
    previewEl.style.display = "";
    const toggle = document.querySelector(`.mode-toggle:has([data-editor="${editorId}"])`);
    if (toggle) {
      toggle.querySelectorAll(".mode-toggle-btn").forEach((b) => b.classList.remove("active"));
      const previewBtn = toggle.querySelector(".mode-toggle-btn[data-mode='preview']");
      if (previewBtn) previewBtn.classList.add("active");
    }
  }

  // ============ 设置 Tab 切换 ============
  document.querySelectorAll(".settings-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      document.querySelectorAll(".settings-tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".settings-panel").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      const panel = document.querySelector(`.settings-panel[data-panel="${target}"]`);
      if (panel) panel.classList.add("active");
      if (target === "mcp") { loadMcpConfig(); startMcpPolling(); } else { stopMcpPolling(); }
      if (target === "memory") loadMemory();
      if (target === "skills") loadSkillTree();
    });
  });

  // ============ 设置按钮 ============
  $("#sidebar-settings").addEventListener("click", openSettings);
  $("#settings-close").addEventListener("click", closeSettings);
  $("#settings-cancel").addEventListener("click", closeSettings);
  $("#settings-overlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeSettings();
  });

  $("#settings-save").addEventListener("click", async () => {
    const settings = getSettingsFormValues();
    if (!settings.provider) { App.showToast("请选择提供商"); return; }
    const saveBtn = $("#settings-save");
    saveBtn.disabled = true;
    try {
      const r = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const j = await r.json();
      if (j.success) {
        if (j.keyValid === false) {
          showKeyError(j.warning || "API Key 无效，请检查后重试");
          App.showToast(j.warning || "API Key 无效，已保存但 Agent 无法使用", true);
        } else {
          closeSettings();
          App.showToast(j.warning || "设置已保存，已立即生效");
        }
        App.refreshState();
      } else {
        App.showToast("保存失败：" + (j.error || "未知错误"));
      }
    } catch (e) {
      App.showToast("保存失败：" + e.message);
    } finally {
      saveBtn.disabled = false;
    }
  });

  // ── API Key 显示/隐藏 ──
  const keyInput = $("#llm-key");
  const keyToggle = $("#llm-key-toggle");
  keyToggle.addEventListener("click", () => {
    const isHidden = keyInput.type === "password";
    keyInput.type = isHidden ? "text" : "password";
    keyToggle.title = isHidden ? "隐藏 Key" : "显示 Key";
    keyToggle.innerHTML = isHidden
      ? '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 5a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3Zm0 5a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z"/><path d="M8 2C4.5 2 1.5 4.5.5 8c1 3.5 4 6 7.5 6s6.5-2.5 7.5-6c-1-3.5-4-6-7.5-6ZM8 12c-2.8 0-5.2-2-6-4 .8-2 3.2-4 6-4s5.2 2 6 4c-.8 2-3.2 4-6 4Z"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3c-3.5 0-6.5 2.5-7.5 6 1 3.5 4 6 7.5 6s6.5-2.5 7.5-6c-1-3.5-4-6-7.5-6Zm0 10c-2.8 0-5.2-2-6-4 .8-2 3.2-4 6-4s5.2 2 6 4c-.8 2-3.2 4-6 4Zm0-7a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3Zm0 5a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z"/><path d="M2.5 1.5l12 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  });

  function showKeyError(msg) {
    let el = document.getElementById("llm-key-error");
    if (!el) {
      el = document.createElement("div");
      el.id = "llm-key-error";
      el.className = "key-error";
      keyInput.parentElement.insertAdjacentElement("afterend", el);
    }
    el.textContent = msg;
    el.style.display = "block";
    keyInput.classList.add("invalid");
  }

  function clearKeyError() {
    const el = document.getElementById("llm-key-error");
    if (el) el.style.display = "none";
    keyInput.classList.remove("invalid");
  }

  keyInput.addEventListener("input", clearKeyError);

  // ── SAP 密码显示/隐藏 ──
  $("#sap-password-toggle").addEventListener("click", () => {
    const inp = $("#sap-password");
    const btn = $("#sap-password-toggle");
    const isHidden = inp.type === "password";
    inp.type = isHidden ? "text" : "password";
    btn.title = isHidden ? "隐藏密码" : "显示密码";
  });

  // ── 加载 SAP 配置 ──
  async function loadSapConfig() {
    try {
      const r = await fetch("/api/sap-config");
      const j = await r.json();
      if (j.success && j.data) {
        const d = j.data;
        $("#sap-host").value = d.host || "";
        $("#sap-port").value = d.port || "44300";
        $("#sap-protocol").value = d.protocol || "https";
        $("#sap-user").value = d.user || "";
        $("#sap-client").value = d.client || "100";
        $("#sap-state").innerHTML = d.host
          ? `<span class="dot ok"></span> 已配置：${d.host}:${d.port}（用户 ${d.user}，Client ${d.client}）`
          : '<span class="dot"></span> 尚未配置 SAP 连接';
        const pwdInput = $("#sap-password");
        pwdInput.value = "";
        pwdInput.placeholder = d.host ? "密码已配置，如需修改请在此输入" : "未配置，请输入 SAP 密码";
      }
    } catch {
      $("#sap-state").innerHTML = '<span class="dot err"></span> 读取配置失败';
    }
  }

  // ── 保存 SAP 配置 ──
  $("#sap-save").addEventListener("click", async () => {
    const st = $("#sap-status");
    st.textContent = "保存中…";
    st.style.color = "";
    try {
      const sapPayload = {
        host: $("#sap-host").value.trim(),
        port: $("#sap-port").value.trim(),
        protocol: $("#sap-protocol").value,
        user: $("#sap-user").value.trim(),
        client: $("#sap-client").value.trim(),
      };
      const pwd = $("#sap-password").value;
      if (pwd) sapPayload.password = pwd;
      const r = await fetch("/api/sap-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sapPayload),
      });
      const j = await r.json();
      if (j.success) {
        st.textContent = "已保存，Ping 测试中…";
        st.style.color = "";
        loadSapConfig();
        // 立即清旧状态：避免显示上一次连接的成功结果误导
        const stEl0 = $("#sap-state");
        if (stEl0) stEl0.innerHTML = '<span class="dot"></span> 正在检测新连接…';
        App.refreshSapStatus();
        // Ping 加超时控制（15s，避免 SAP 不可达时长时间挂起）
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
          const pr = await fetch("/api/sap-status", { signal: controller.signal });
          const pj = await pr.json();
          const stEl = $("#sap-state");
          if (pj.success && pj.data) {
            st.textContent = "已保存 · Ping 成功";
            st.style.color = "var(--success)";
            const cat = pj.data.clientCategoryLabel ? ` · 客户端类别 ${pj.data.clientCategoryLabel}${pj.data.clientCategory ? `(${pj.data.clientCategory})` : ""}` : "";
            stEl.innerHTML = `<span class="dot ok"></span> 已连接：${pj.data.sid || "SAP"}（用户 ${pj.data.user || ""}${cat}）`;
          } else {
            st.textContent = "已保存 · Ping 失败";
            st.style.color = "var(--error)";
            stEl.innerHTML = `<span class="dot err"></span> Ping 失败：${pj.error || "连接失败"}`;
          }
        } catch (e) {
          const isTimeout = e.name === "AbortError";
          st.textContent = isTimeout ? "已保存 · Ping 超时" : "已保存 · Ping 失败";
          st.style.color = "var(--error)";
          $("#sap-state").innerHTML = isTimeout
            ? '<span class="dot err"></span> Ping 超时：SAP 在 15 秒内无响应（请检查地址/端口/网络）'
            : '<span class="dot err"></span> Ping 失败：' + (e?.message || "请求异常");
        } finally {
          clearTimeout(timer);
        }
        setTimeout(() => { st.textContent = ""; }, 3000);
      } else {
        st.textContent = "保存失败：" + (j.error || r.status);
        st.style.color = "var(--error)";
      }
    } catch (e) {
      st.textContent = "保存失败：" + e.message;
      st.style.color = "var(--error)";
    }
  });

  // ── ESC 关闭设置/预览 ──
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if ($("#settings-overlay").classList.contains("open")) {
      e.preventDefault();
      closeSettings();
      return;
    }
    if ($("#preview-overlay").classList.contains("open")) {
      e.preventDefault();
      App.closePreview();
    }
  });
})();
