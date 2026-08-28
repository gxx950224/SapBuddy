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

  // ── 提供商 / 模型下拉框 ──
  let providerList = []; // [{ name, baseUrl, models: [id] }]，来自后端 models.json

  function providerLabel(name) {
    return DOMESTIC_PROVIDERS[name]?.label || name;
  }

  // 填充提供商下拉框（内置厂商用中文标签，自定义显示原名）
  function populateProviderSelect(providers) {
    providerList = Array.isArray(providers) ? providers : providerList;
    const sel = $("#llm-provider");
    sel.innerHTML = "";
    for (const p of providerList) {
      const opt = document.createElement("option");
      opt.value = p.name;
      opt.textContent = providerLabel(p.name);
      sel.appendChild(opt);
    }
    // 兜底：后端暂无数据时用内置清单
    if (!sel.options.length) {
      for (const [key, p] of Object.entries(DOMESTIC_PROVIDERS)) {
        const opt = document.createElement("option");
        opt.value = key;
        opt.textContent = p.label;
        sel.appendChild(opt);
        providerList.push({ name: key, models: [p.defaultModel] });
      }
    }
  }

  // 填充模型下拉框：当前提供商下的模型；当前值不在列表时自动追加一项
  function populateModelSelect(provider, currentModel) {
    const sel = $("#llm-model");
    sel.innerHTML = "";
    const p = providerList.find((x) => x.name === provider);
    const ids = p?.models ? [...p.models] : [];
    if (currentModel && !ids.includes(currentModel)) ids.push(currentModel);
    for (const id of ids) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = id;
      sel.appendChild(opt);
    }
    if (currentModel) sel.value = currentModel;
  }

  // 切换提供商 → 刷新模型下拉 + 同步该提供商的 Key
  $("#llm-provider").addEventListener("change", () => {
    populateModelSelect($("#llm-provider").value, "");
    const p = providerList.find((x) => x.name === $("#llm-provider").value);
    const keyInput = $("#llm-key");
    if (p && p.hasKey && p.key) {
      keyInput.value = p.key;
      keyInput.placeholder = "";
    } else {
      keyInput.value = "";
      keyInput.placeholder = "未配置，请输入 API Key";
    }
  });

  // ── 获取表单值 ──
  function getSettingsFormValues() {
    return {
      provider: $("#llm-provider").value,
      model: $("#llm-model").value,
      apiKey: $("#llm-key").value,
      contextTokens: parseInt($("#llm-context-tokens").value, 10) || 200000,
    };
  }

  // 当前提供商不在列表时，把当前值作为一项加进去（兼容旧配置）
  function ensureProviderOption(provider) {
    if (!provider) return;
    const sel = $("#llm-provider");
    if (![...sel.options].some((o) => o.value === provider)) {
      const opt = document.createElement("option");
      opt.value = provider;
      opt.textContent = providerLabel(provider);
      sel.appendChild(opt);
    }
  }

  // ── 新增连接：模型名称行 ──
  function addModelRow(value) {
    const wrap = $("#llm-new-models");
    const row = document.createElement("div");
    row.className = "llm-model-row";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "模型名称，如 gpt-4o";
    if (value) input.value = value;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn-icon";
    del.title = "删除";
    del.textContent = "×";
    del.addEventListener("click", () => row.remove());
    row.appendChild(input);
    row.appendChild(del);
    wrap.appendChild(row);
    return input;
  }
  let editingProvider = null; // 编辑中的提供商名（null = 新增模式）
  function resetLlmForm() {
    $("#llm-new-name").value = "";
    $("#llm-new-baseurl").value = "";
    $("#llm-new-key").value = "";
    $("#llm-new-key").placeholder = "该提供商的 API Key";
    $("#llm-new-models").innerHTML = "";
    editingProvider = null;
  }
  function showLlmForm() {
    $("#llm-conn-form").style.display = "block";
    $("#llm-conn-manager").style.display = "none";
  }
  function openLlmConnForm() {
    resetLlmForm();
    $("#llm-conn-form-title").textContent = "新增大模型连接（OpenAI 兼容接口）";
    $("#llm-conn-save").textContent = "保存连接";
    showLlmForm();
    addModelRow();
  }
  function openLlmEditForm() {
    const provider = $("#llm-provider").value;
    const p = providerList.find((x) => x.name === provider);
    if (!p) { App.showToast("请先在提供商下拉框选择要编辑的连接"); return; }
    resetLlmForm();
    editingProvider = provider;
    $("#llm-conn-form-title").textContent = "编辑大模型连接（OpenAI 兼容接口）";
    $("#llm-conn-save").textContent = "保存修改";
    $("#llm-new-name").value = p.name;
    $("#llm-new-baseurl").value = p.baseUrl || "";
    $("#llm-new-key").placeholder = p.hasKey ? "已配置 Key（留空保持不变）" : "未配置 Key，可填写";
    const models = p.models && p.models.length ? p.models : [""];
    models.forEach((m) => addModelRow(m));
    showLlmForm();
  }
  function hideLlmConnForm() {
    resetLlmForm();
    $("#llm-conn-form").style.display = "none";
    $("#llm-conn-manager").style.display = "";
  }
  $("#llm-add-conn").addEventListener("click", openLlmConnForm);
  $("#llm-edit-conn").addEventListener("click", openLlmEditForm);
  $("#llm-conn-cancel").addEventListener("click", hideLlmConnForm);
  $("#llm-new-model-add").addEventListener("click", () => addModelRow());
  $("#llm-conn-save").addEventListener("click", async () => {
    const name = $("#llm-new-name").value.trim();
    const baseUrl = $("#llm-new-baseurl").value.trim();
    const apiKey = $("#llm-new-key").value.trim();
    const models = [...document.querySelectorAll("#llm-new-models input")].map((i) => i.value.trim()).filter(Boolean);
    if (!name) { App.showToast("请填写提供商名称"); return; }
    if (!baseUrl) { App.showToast("请填写 API 地址"); return; }
    if (!models.length) { App.showToast("请至少填写一个模型名称"); return; }
    const saveBtn = $("#llm-conn-save");
    saveBtn.disabled = true;
    try {
      const payload = editingProvider
        ? { editProvider: editingProvider, providerName: name, baseUrl, apiKey, models }
        : { providerName: name, baseUrl, apiKey, models };
      const r = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (j.success) {
        App.showToast(editingProvider ? "修改已保存" : "连接已添加，已切换为当前提供商");
        hideLlmConnForm();
        applySettingsToForm(await fetchSettings());
        App.refreshState();
      } else {
        App.showToast("保存失败：" + (j.error || "未知错误"), true);
      }
    } catch (e) {
      App.showToast("保存失败：" + e.message, true);
    } finally {
      saveBtn.disabled = false;
    }
  });

  function applySettingsToForm(settings) {
    const s = settings || DEFAULT_SETTINGS;
    populateProviderSelect(s.providers);
    ensureProviderOption(s.provider);
    $("#llm-provider").value = s.provider || "deepseek";
    populateModelSelect($("#llm-provider").value, s.model || "");
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
    clearSettingsDirty();
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

  // ── 未保存更改跟踪 ──
  let settingsDirty = false;
  function markSettingsDirty() { settingsDirty = true; }
  function clearSettingsDirty() { settingsDirty = false; }

  // 监听大模型配置字段修改
  const dirtyFields = ["#llm-provider", "#llm-model", "#llm-key", "#llm-context-tokens", "#mcp-config"];
  dirtyFields.forEach(selector => {
    const el = $(selector);
    if (el) {
      el.addEventListener("input", markSettingsDirty);
      el.addEventListener("change", markSettingsDirty);
    }
  });

  // 修改closeSettings，添加未保存更改检查
  const originalCloseSettings = closeSettings;
  closeSettings = async function() {
    if (settingsDirty) {
      const ok = await App.confirm({
        title: "未保存的更改",
        message: "您有未保存的更改，是否保存？",
        confirmText: "保存",
        cancelText: "不保存",
      });
      if (ok === null || ok === undefined) return; // 取消
      if (ok) {
        // 保存设置：先清除dirty状态，然后触发保存按钮
        clearSettingsDirty();
        const saveBtn = $("#settings-save");
        if (saveBtn && !saveBtn.disabled) {
          saveBtn.click();
        }
        return; // 保存成功后会自动关闭
      }
    }
    clearSettingsDirty();
    originalCloseSettings();
  };

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

  // MCP 保存（可视化模式与 JSON 模式共用）
  async function saveMcpConfig() {
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
    const jsonBtn = $("#mcp-save");
    const visualBtn = $("#mcp-visual-save");
    if (jsonBtn) jsonBtn.disabled = true;
    if (visualBtn) visualBtn.disabled = true;
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
      if (jsonBtn) jsonBtn.disabled = false;
      if (visualBtn) visualBtn.disabled = false;
    }
  }
  $("#mcp-save").addEventListener("click", saveMcpConfig);
  const mcpVisualSaveBtn = $("#mcp-visual-save");
  if (mcpVisualSaveBtn) mcpVisualSaveBtn.addEventListener("click", saveMcpConfig);

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
      if (target === "about") loadAbout();
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
        clearSettingsDirty();
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

  // ── SAP 多连接配置 ──
  let sapEditingId = "";   // 为空=新增；否则=正在编辑的原连接 id
  let sapConnCache = [];

  function renderConnList(conns) {
    sapConnCache = conns || [];
    const list = $("#sap-conn-list");
    if (!list) return;
    if (!sapConnCache.length) {
      list.innerHTML = '<div class="empty-hint">尚未配置任何 SAP 连接，点「＋ 添加连接」新增。</div>';
      return;
    }
    list.innerHTML = sapConnCache.map((c) => {
      const activeTag = c.active
        ? '<span class="badge-active">使用中</span>'
        : `<button class="btn-mini" data-act="active" data-id="${escapeHtml(c.id)}">设为当前</button>`;
      return `
        <div class="conn-row">
          <div class="conn-info">
            <div class="conn-name">${escapeHtml(c.name)} ${activeTag}</div>
            <div class="conn-host">${escapeHtml(c.host)}:${escapeHtml(c.port)} · ${escapeHtml(c.user)} · Client ${escapeHtml(c.client)}</div>
          </div>
          <div class="conn-actions">
            <button class="btn-mini" data-act="edit" data-id="${escapeHtml(c.id)}">编辑</button>
            <button class="btn-mini danger" data-act="del" data-id="${escapeHtml(c.id)}">删除</button>
          </div>
        </div>`;
    }).join("");
  }

  function openConnForm(conn) {
    sapEditingId = conn ? conn.id : "";
    $("#sap-conn-form-title").textContent = conn ? "编辑连接" : "添加连接";
    $("#sap-name").value = conn ? conn.name : "";
    $("#sap-host").value = conn ? conn.host : "";
    $("#sap-port").value = conn ? (conn.port || "44300") : "44300";
    $("#sap-protocol").value = conn ? (conn.protocol || "https") : "https";
    $("#sap-user").value = conn ? conn.user : "";
    $("#sap-client").value = conn ? (conn.client || "100") : "100";
    const pwd = $("#sap-password");
    pwd.value = "";
    pwd.placeholder = conn && conn.hasPassword ? "密码已配置，如需修改请在此输入" : "输入 SAP 密码";
    $("#sap-cancel").style.display = conn ? "inline-block" : "none";
    const st = $("#sap-status");
    if (st) st.textContent = "";
    $("#sap-conn-form").style.display = "block";
  }

  function hideConnForm() {
    $("#sap-conn-form").style.display = "none";
    sapEditingId = "";
    const st = $("#sap-status");
    if (st) st.textContent = "";
  }

  async function pingActive(verb) {
    const st = $("#sap-status");
    st.textContent = `${verb}，Ping 测试中…`;
    st.style.color = "";
    const stEl = $("#sap-state");
    if (stEl) stEl.innerHTML = '<span class="dot"></span> 正在检测当前连接…';
    App.refreshSapStatus();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const pr = await fetch("/api/sap-status", { signal: controller.signal });
      const pj = await pr.json();
      if (pj.success && pj.data) {
        st.textContent = `${verb} · Ping 成功`;
        st.style.color = "var(--success)";
        const cat = pj.data.clientCategoryLabel ? ` · 客户端类别 ${pj.data.clientCategoryLabel}${pj.data.clientCategory ? `(${pj.data.clientCategory})` : ""}` : "";
        stEl.innerHTML = `<span class="dot ok"></span> 已连接：${pj.data.sid || "SAP"}（用户 ${pj.data.user || ""}${cat}）`;
        return true;
      } else {
        st.textContent = `${verb} · Ping 失败`;
        st.style.color = "var(--error)";
        stEl.innerHTML = `<span class="dot err"></span> Ping 失败：${pj.error || "连接失败"}`;
        return false;
      }
    } catch (e) {
      const isTimeout = e.name === "AbortError";
      st.textContent = isTimeout ? `${verb} · Ping 超时` : `${verb} · Ping 失败`;
      st.style.color = "var(--error)";
      stEl.innerHTML = isTimeout
        ? '<span class="dot err"></span> Ping 超时：SAP 在 15 秒内无响应（请检查地址/端口/网络）'
        : '<span class="dot err"></span> Ping 失败：' + (e?.message || "请求异常");
      return false;
    } finally {
      clearTimeout(timer);
      setTimeout(() => { st.textContent = ""; }, 3000);
    }
  }

  // ── 加载 SAP 连接列表 ──
  async function loadSapConfig() {
    try {
      const r = await fetch("/api/sap-config");
      const j = await r.json();
      if (j.success && j.data) {
        const d = j.data;
        renderConnList(d.connections || []);
        const stEl = $("#sap-state");
        const active = (d.connections || []).find((c) => c.active);
        if (active) {
          stEl.innerHTML = `<span class="dot ok"></span> 当前使用：${escapeHtml(active.name)}（${escapeHtml(active.host)}:${escapeHtml(active.port)} · 用户 ${escapeHtml(active.user)} · Client ${escapeHtml(active.client)}）`;
        } else if (d.connections && d.connections.length) {
          stEl.innerHTML = '<span class="dot"></span> 尚未指定当前连接（默认用第一个）';
        } else {
          stEl.innerHTML = '<span class="dot"></span> 尚未配置 SAP 连接';
        }
      }
    } catch {
      $("#sap-state").innerHTML = '<span class="dot err"></span> 读取配置失败';
    }
  }

  $("#sap-add").addEventListener("click", () => openConnForm(null));
  $("#sap-cancel").addEventListener("click", () => hideConnForm());

  $("#sap-conn-list").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    const id = btn.dataset.id;
    const listSt = $("#sap-list-status");
    if (act === "active") {
      listSt.textContent = "切换中…";
      listSt.style.color = "";
      try {
        const r = await fetch("/api/sap-config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "setActive", id }),
        });
        const j = await r.json();
        if (j.success) {
          listSt.textContent = "";
          await loadSapConfig();
          await pingActive("已切换");
        } else {
          listSt.textContent = "切换失败：" + (j.error || r.status);
          listSt.style.color = "var(--error)";
          setTimeout(() => { listSt.textContent = ""; listSt.style.color = ""; }, 3000);
        }
      } catch (err) {
        listSt.textContent = "切换失败：" + err.message;
        listSt.style.color = "var(--error)";
      }
    } else if (act === "edit") {
      const conn = sapConnCache.find((c) => c.id === id);
      if (conn) openConnForm(conn);
    } else if (act === "del") {
      const conn = sapConnCache.find((c) => c.id === id);
      const nm = conn ? conn.name : id;
      if (!confirm(`确定删除连接「${nm}」？删除后不可恢复。`)) return;
      listSt.textContent = "删除中…";
      listSt.style.color = "";
      try {
        const r = await fetch("/api/sap-config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "delete", id }),
        });
        const j = await r.json();
        if (j.success) {
          listSt.textContent = "";
          await loadSapConfig();
        } else {
          listSt.textContent = "删除失败：" + (j.error || r.status);
          listSt.style.color = "var(--error)";
          setTimeout(() => { listSt.textContent = ""; listSt.style.color = ""; }, 3000);
        }
      } catch (err) {
        listSt.textContent = "删除失败：" + err.message;
        listSt.style.color = "var(--error)";
      }
    }
  });

  // ── 保存 SAP 连接（新增/编辑）──
  $("#sap-save").addEventListener("click", async () => {
    const st = $("#sap-status");
    st.textContent = "保存中…";
    st.style.color = "";
    const name = $("#sap-name").value.trim();
    if (!name) {
      st.textContent = "请填写连接名称（如：开发）";
      st.style.color = "var(--error)";
      return;
    }
    const sapPayload = {
      action: "save",
      connection: {
        origId: sapEditingId || undefined,
        name,
        host: $("#sap-host").value.trim(),
        port: $("#sap-port").value.trim() || "44300",
        protocol: $("#sap-protocol").value || "https",
        user: $("#sap-user").value.trim(),
        client: $("#sap-client").value.trim() || "100",
      },
    };
    const pwd = $("#sap-password").value;
    if (pwd) sapPayload.connection.password = pwd;
    try {
      const r = await fetch("/api/sap-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sapPayload),
      });
      const j = await r.json();
      if (j.success) {
        st.textContent = "";
        await loadSapConfig();
        const ok = await pingActive("已保存");
        if (ok) hideConnForm();   // 测试通过才收起表单；失败则保留供修改
      } else {
        st.textContent = "保存失败：" + (j.error || r.status);
        st.style.color = "var(--error)";
      }
    } catch (e) {
      st.textContent = "保存失败：" + e.message;
      st.style.color = "var(--error)";
    }
  });

  // ============ 关于面板 ============
  function setAboutStatus(msg, cls) {
    const el = $("#about-status");
    if (!el) return;
    el.textContent = msg || "";
    el.className = "settings-status";
    if (cls) el.classList.add(cls);
  }

  function appendAboutLog(line) {
    const el = $("#about-log");
    if (!el) return;
    el.style.display = "";
    const div = document.createElement("div");
    div.textContent = line || "";
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  }

  function clearAboutLog() {
    const el = $("#about-log");
    if (!el) return;
    el.innerHTML = "";
    el.style.display = "none";
  }

  let _aboutChecking = false;
  let _aboutApplying = false;

  async function loadAbout() {
    if (_aboutChecking) return;
    _aboutChecking = true;
    const btnCheck = $("#about-check");
    if (btnCheck) btnCheck.disabled = true;
    setAboutStatus("检查更新中…", "");
    try {
      const r = await fetch("/api/update/check");
      const j = await r.json();
      if (j.success) {
        $("#about-current").textContent = j.current || "unknown";
        $("#about-latest").textContent = j.hasUpdate ? `${j.latest}（有新版本）` : (j.latest || "—");
        if ($("#about-update")) $("#about-update").disabled = !j.hasUpdate || _aboutApplying;
        // 上次一键更新失败 → 优先提示失败原因
        if (j.lastUpdateError) {
          setAboutStatus(j.lastUpdateError, "err");
        } else {
          setAboutStatus(j.hasUpdate ? `发现新版本 v${j.latest}，可一键更新` : "已是最新版本", j.hasUpdate ? "warn" : "ok");
        }
      } else {
        $("#about-latest").textContent = "—";
        if ($("#about-update")) $("#about-update").disabled = true;
        setAboutStatus(j.error || "检查失败", "err");
      }
    } catch (e) {
      $("#about-latest").textContent = "—";
      if ($("#about-update")) $("#about-update").disabled = true;
      setAboutStatus("检查失败：" + e.message, "err");
    } finally {
      _aboutChecking = false;
      if (btnCheck) btnCheck.disabled = _aboutApplying;
    }
  }

  // 更新成功后轮询 /api/state，新服务起来即刷新页面（START_TS 变化，自动拉新版静态资源）
  function startWaitForRestart() {
    let n = 0;
    const timer = setInterval(async () => {
      n++;
      try {
        const r = await fetch("/api/state", { signal: AbortSignal.timeout(3000) });
        if (r.ok) {
          clearInterval(timer);
          setAboutStatus("已更新，刷新页面…", "ok");
          setTimeout(() => location.reload(), 500);
          return;
        }
      } catch { /* 服务还没起来，继续等 */ }
      if (n >= 50) {
        clearInterval(timer);
        setAboutStatus("服务已重启，请手动刷新页面", "");
      }
    }, 1200);
  }

  App.onUpdateEvent = function(payload) {
    if (payload.status === "done") {
      setAboutStatus("更新完成，正在重启服务…", "ok");
    } else if (payload.status === "restarting") {
      setAboutStatus("服务重启中，完成后自动刷新…", "");
      startWaitForRestart();
    } else if (payload.status === "error") {
      _aboutApplying = false;
      $("#about-check").disabled = false;
      $("#about-update").disabled = true;
      setAboutStatus(payload.line || "更新失败", "err");
    } else if (payload.line) {
      appendAboutLog(payload.line);
    }
  };

  $("#about-check").addEventListener("click", loadAbout);

  $("#about-update").addEventListener("click", async () => {
    if (_aboutApplying) return;
    const latest = $("#about-latest").textContent.replace(/（有新版本）/g, "").trim();
    const ok = await App.confirm({
      title: "一键更新",
      message: `将把 SapBuddy 更新到最新版（${latest || "最新版"}）。更新过程中网页会短暂断开，服务更新完成后自动重启并刷新。确定继续？`,
      confirmText: "开始更新",
      danger: true,
    });
    if (!ok) return;
    _aboutApplying = true;
    $("#about-update").disabled = true;
    $("#about-check").disabled = true;
    clearAboutLog();
    setAboutStatus("正在下载并安装新版本…", "");
    try {
      const r = await fetch("/api/update/apply", { method: "POST" });
      const j = await r.json();
      if (!j.success) {
        _aboutApplying = false;
        $("#about-check").disabled = false;
        setAboutStatus("启动更新失败：" + (j.error || ""), "err");
        return;
      }
      // 成功：等待 SSE 推送 npm 进度 → done → restarting → 轮询刷新
    } catch (e) {
      _aboutApplying = false;
      $("#about-check").disabled = false;
      setAboutStatus("启动更新失败：" + e.message, "err");
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

  // ── MCP 可视化配置 ──
  let mcpVisualConfig = {}; // 可视化配置的内存对象
  let mcpEditingServer = null; // 当前编辑的服务器名称（null表示新增）

  // 渲染可视化服务器列表
  function renderMcpVisualList() {
    const list = $("#mcp-server-list");
    if (!list) return;
    const servers = Object.keys(mcpVisualConfig || {});
    if (!servers.length) {
      list.innerHTML = '<div class="empty-hint">暂无 MCP 服务器，点击下方按钮添加</div>';
      return;
    }
    list.innerHTML = "";
    for (const name of servers) {
      const s = mcpVisualConfig[name] || {};
      const card = document.createElement("div");
      card.className = "mcp-server-card";
      card.innerHTML = `
        <div class="mcp-server-card-info">
          <div class="mcp-server-card-name">
            ${escapeHtml(name)}
            <span class="mcp-server-card-type">${escapeHtml(s.type || "")}</span>
          </div>
          <div class="mcp-server-card-url">${escapeHtml(s.url || "")}</div>
        </div>
        <div class="mcp-server-card-actions">
          <button class="btn-mini" data-action="edit" data-name="${escapeHtml(name)}">编辑</button>
          <button class="btn-mini danger" data-action="delete" data-name="${escapeHtml(name)}">删除</button>
        </div>
      `;
      list.appendChild(card);
    }
    // 绑定编辑/删除事件
    list.querySelectorAll("button[data-action]").forEach(btn => {
      btn.addEventListener("click", () => {
        const action = btn.dataset.action;
        const name = btn.dataset.name;
        if (action === "edit") openMcpServerEdit(name);
        else if (action === "delete") deleteMcpServer(name);
      });
    });
  }

  // 打开服务器编辑弹窗
  function openMcpServerEdit(name) {
    mcpEditingServer = name;
    const overlay = $("#mcp-server-edit-overlay");
    const title = $("#mcp-server-edit-title");
    const nameInput = $("#mcp-server-name");
    const typeSelect = $("#mcp-server-type");
    const urlInput = $("#mcp-server-url");
    const headersList = $("#mcp-headers-list");

    if (name && mcpVisualConfig[name]) {
      title.textContent = "编辑 MCP 服务器";
      nameInput.value = name;
      nameInput.disabled = true; // 编辑时不允许修改名称
      typeSelect.value = mcpVisualConfig[name].type || "streamable-http";
      urlInput.value = mcpVisualConfig[name].url || "";
      renderMcpHeaders(mcpVisualConfig[name].headers || {});
    } else {
      title.textContent = "添加 MCP 服务器";
      nameInput.value = "";
      nameInput.disabled = false;
      typeSelect.value = "streamable-http";
      urlInput.value = "";
      renderMcpHeaders({});
    }
    overlay.style.display = "flex";
  }

  // 关闭服务器编辑弹窗
  function closeMcpServerEdit() {
    $("#mcp-server-edit-overlay").style.display = "none";
    mcpEditingServer = null;
  }

  // 渲染Headers列表
  function renderMcpHeaders(headers) {
    const list = $("#mcp-headers-list");
    if (!list) return;
    list.innerHTML = "";
    const keys = Object.keys(headers || {});
    if (!keys.length) return;
    for (const key of keys) {
      addMcpHeaderRow(key, headers[key]);
    }
  }

  // 添加一行Header输入
  function addMcpHeaderRow(key = "", value = "") {
    const list = $("#mcp-headers-list");
    if (!list) return;
    const row = document.createElement("div");
    row.className = "mcp-header-row";
    row.innerHTML = `
      <input type="text" placeholder="Header Key" value="${escapeHtml(key)}" />
      <input type="text" placeholder="Header Value" value="${escapeHtml(value)}" />
      <button class="btn-remove-header" title="删除">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    `;
    list.appendChild(row);
    row.querySelector(".btn-remove-header").addEventListener("click", () => row.remove());
  }

  // 收集Headers输入
  function collectMcpHeaders() {
    const list = $("#mcp-headers-list");
    if (!list) return {};
    const headers = {};
    list.querySelectorAll(".mcp-header-row").forEach(row => {
      const inputs = row.querySelectorAll("input");
      const key = inputs[0]?.value.trim();
      const value = inputs[1]?.value.trim();
      if (key) headers[key] = value;
    });
    return headers;
  }

  // 保存服务器编辑
  function saveMcpServerEdit() {
    const name = $("#mcp-server-name").value.trim();
    const type = $("#mcp-server-type").value;
    const url = $("#mcp-server-url").value.trim();
    if (!name) { App.showToast("请输入服务器名称", true); return; }
    if (!url) { App.showToast("请输入服务器URL", true); return; }
    const headers = collectMcpHeaders();
    const serverConfig = { type, url };
    if (Object.keys(headers).length) serverConfig.headers = headers;
    mcpVisualConfig[name] = serverConfig;
    // 同步到JSON textarea
    $("#mcp-config").value = JSON.stringify(mcpVisualConfig, null, 2);
    renderMcpVisualList();
    closeMcpServerEdit();
    App.showToast("服务器配置已更新，请点击保存并生效");
  }

  // 删除服务器
  function deleteMcpServer(name) {
    App.confirm({
      title: "删除 MCP 服务器",
      message: `确定要删除服务器「${name}」吗？删除后需要点击保存并生效才能实际生效。`,
      confirmText: "删除",
      danger: true,
    }).then(ok => {
      if (!ok) return;
      delete mcpVisualConfig[name];
      $("#mcp-config").value = JSON.stringify(mcpVisualConfig, null, 2);
      renderMcpVisualList();
      App.showToast("服务器已删除，请点击保存并生效");
    });
  }

  // 模式切换
  document.querySelectorAll(".mcp-mode-toggle .mode-toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mcpMode;
      document.querySelectorAll(".mcp-mode-toggle .mode-toggle-btn").forEach(b => b.classList.toggle("active", b === btn));
      const visual = $("#mcp-visual-mode");
      const json = $("#mcp-json-mode");
      if (visual) visual.style.display = mode === "visual" ? "block" : "none";
      if (json) json.style.display = mode === "json" ? "block" : "none";
      // 切换到可视化模式时，从JSON同步
      if (mode === "visual") {
        try {
          mcpVisualConfig = JSON.parse($("#mcp-config").value || "{}");
          renderMcpVisualList();
        } catch (e) {
          App.showToast("JSON格式错误，无法切换到可视化模式", true);
        }
      }
    });
  });

  // 绑定添加服务器按钮
  const addServerBtn = $("#mcp-add-server");
  if (addServerBtn) addServerBtn.addEventListener("click", () => openMcpServerEdit(null));

  // 绑定添加Header按钮
  const addHeaderBtn = $("#mcp-add-header");
  if (addHeaderBtn) addHeaderBtn.addEventListener("click", () => addMcpHeaderRow());

  // 绑定编辑弹窗的取消/保存按钮
  const editCancelBtn = $("#mcp-server-edit-cancel");
  if (editCancelBtn) editCancelBtn.addEventListener("click", closeMcpServerEdit);
  const editSaveBtn = $("#mcp-server-edit-save");
  if (editSaveBtn) editSaveBtn.addEventListener("click", saveMcpServerEdit);

  // 点击弹窗背景关闭
  const editOverlay = $("#mcp-server-edit-overlay");
  if (editOverlay) {
    editOverlay.addEventListener("click", (e) => {
      if (e.target === editOverlay) closeMcpServerEdit();
    });
  }

  // 在loadMcpConfig中同步渲染可视化列表
  const originalLoadMcpConfig = loadMcpConfig;
  loadMcpConfig = async function() {
    await originalLoadMcpConfig();
    try {
      mcpVisualConfig = JSON.parse($("#mcp-config").value || "{}");
      renderMcpVisualList();
    } catch (e) { /* JSON格式错误时忽略 */ }
  };
})();
