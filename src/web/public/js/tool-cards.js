/**
 * 工具调用条目 — 豆包工作风格：行式紧凑条目，可展开查看参数与结果
 * 幂等：同一 toolCallId 复用同一条目
 */
"use strict";

(function() {
  const App = window.SapBuddy;
  const state = App.state;

  // ── 参数摘要（保持原接口）──
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

  // ── Skill 识别（保持原逻辑）──
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

  // ── 格式化 JSON 用于展开区显示 ──
  function formatArgs(args) {
    if (!args) return "(无参数)";
    let obj = args;
    if (typeof args === "string") {
      try { obj = JSON.parse(args); } catch { return args; }
    }
    try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
  }

  // ── 判断参数是否非空 ──
  function hasNonEmptyArgs(args) {
    if (!args) return false;
    if (typeof args === "string") return args.trim().length > 0 && args.trim() !== "{}";
    if (typeof args === "object") {
      try { return Object.keys(args).length > 0; } catch { return false; }
    }
    return false;
  }

  // ── 更新卡片的输入参数（创建和复用时都调用，修复流式中先空后有值的问题）──
  function updateCardArgs(item, args) {
    const hasArgs = hasNonEmptyArgs(args);
    // 输入参数区域：无参时隐藏
    const inputSection = item.querySelector(".invoke-section:first-child");
    if (inputSection) inputSection.style.display = hasArgs ? "" : "none";
    if (hasArgs) {
      const inputEl = item.querySelector(".invoke-input");
      if (inputEl) inputEl.textContent = formatArgs(args);
      const argsEl = item.querySelector(".invoke-args");
      if (argsEl && !item._isSkill) argsEl.textContent = App.summarizeArgs(args);
    }
  }

  // ── 创建工具调用条目（行式）──
  App.createToolCard = function(id, name, args) {
    if (id && state.toolCards.has(id)) {
      const existing = state.toolCards.get(id);
      // 复用时更新输入参数（流式中 tool_execution_start 先触发时 args 可能为空，
      // 后续 message_update 带真实参数时需要更新，否则展开区永远显示 {}）
      updateCardArgs(existing, args);
      return existing;
    }
    const isSkill = isSkillRead(name, args);
    const skillName = isSkill ? skillNameFrom(args) : "";
    const displayName = isSkill ? ("Skill: " + skillName) : (name || "tool");

    const item = document.createElement("div");
    item.className = "tool-invoke-item" + (isSkill ? " skill-item" : "");
    item.dataset.toolName = name || "";
    item.innerHTML = `
      <div class="invoke-row">
        <span class="invoke-status running"><span class="invoke-spinner"></span></span>
        <span class="invoke-name"></span>
        <span class="invoke-args"></span>
        <span class="invoke-meta">
          <span class="invoke-duration"></span>
          <span class="invoke-caret"></span>
        </span>
      </div>
      <div class="invoke-detail">
        <div class="invoke-section">
          <div class="invoke-section-title">输入参数</div>
          <pre class="invoke-input"></pre>
        </div>
        <div class="invoke-section">
          <div class="invoke-section-title">执行结果</div>
          <div class="invoke-output"><span class="invoke-pending">执行中…</span></div>
        </div>
      </div>`;

    item.querySelector(".invoke-name").textContent = displayName;
    item._isSkill = isSkill;
    // 统一通过 updateCardArgs 设置参数摘要和展开区输入参数
    updateCardArgs(item, args);
    if (isSkill) item.querySelector(".invoke-args").textContent = "加载技能说明";

    // 点击行展开/收起
    item.querySelector(".invoke-row").addEventListener("click", () => {
      item.classList.toggle("expanded");
    });

    // 记录开始时间（用于耗时统计）
    item._startTime = Date.now();

    if (id) state.toolCards.set(id, item);
    return item;
  };

  // ── 中断未完成的工具调用（点停止时本地立即生效）──
  App.markToolCardsInterrupted = function() {
    state.toolCards.forEach((item) => {
      const status = item.querySelector(".invoke-status");
      if (status && status.classList.contains("running")) {
        status.className = "invoke-status interrupted";
        status.textContent = "⏹";
        const pending = item.querySelector(".invoke-pending");
        if (pending) { pending.textContent = "已中断"; pending.classList.add("interrupted"); }
      }
    });
  };

  // ── 错误类型识别与友好提示 ──
  function classifyError(text, toolName) {
    const t = (text || "").toLowerCase();
    const name = (toolName || "").toLowerCase();
    // 安全拦截
    if (/拦截|已拦截|需确认|确认词|放行|人工确认|write.*block|blocked|security/i.test(text)) {
      return {
        type: "security",
        icon: "🔒",
        title: "操作被安全策略拦截",
        color: "var(--warning)",
        tips: [
          "这是写操作，SapBuddy 默认需要人工确认后才会执行",
          "请在对话中回复「确认」「同意」「可以」「执行」等确认词放行",
          "如确认词无效，检查是否包含完整的确认词（不要加多余标点）",
        ],
      };
    }
    // 连接失败/超时
    if (/超时|timeout|econnrefused|econnreset|enotfound|连接失败|无法连接|network error|fetch failed/i.test(text)) {
      return {
        type: "connection",
        icon: "🔌",
        title: "SAP 连接失败或超时",
        color: "var(--error)",
        tips: [
          "检查 SAP 系统是否可访问（VPN/网络是否正常）",
          "在设置 → SAP连接 中检查主机地址、端口、客户端号是否正确",
          "点击「测试连接」验证连通性，必要时切换到其他 SAP 系统",
          "如频繁超时，可能是 SAP 系统负载高，稍后重试",
        ],
      };
    }
    // 权限不足
    if (/权限|authority|no authorization|s_tcode|s_rs_icom|权限不足|没有权限|forbidden|403/i.test(text)) {
      return {
        type: "permission",
        icon: "🚫",
        title: "SAP 权限不足",
        color: "var(--error)",
        tips: [
          "当前 SAP 用户缺少执行该操作所需的权限对象",
          "联系 SAP  Basis 管理员分配相应权限（如 S_TCODE、S_DEVELOP 等）",
          "尝试切换到有更高权限的 SAP 用户连接",
          "如为查询操作，确认是否有该表/对象的读取权限",
        ],
      };
    }
    // 语法错误
    if (/语法错误|syntax error|语法不正确|parse error|invalid syntax/i.test(text)) {
      return {
        type: "syntax",
        icon: "⚠️",
        title: "语法错误",
        color: "var(--warning)",
        tips: [
          "检查 ABAP 代码语法是否正确（大小写、关键字拼写）",
          "确认使用的语法是否符合当前 SAP 系统版本（7.40+ 支持新语法）",
          "如为 SQL 查询，检查表名、字段名是否正确",
          "可使用「代码审查」工具（abap-code-review）做全面语法检查",
        ],
      };
    }
    // 对象不存在
    if (/不存在|not found|no such|does not exist|404|找不到/i.test(text)) {
      return {
        type: "notfound",
        icon: "🔍",
        title: "对象不存在",
        color: "var(--text-dim)",
        tips: [
          "检查对象名称是否正确（事务码/程序/表/函数名）",
          "确认该对象是否存在于当前 SAP 系统（不同系统对象可能不同）",
          "如为事务码，先用 tstc 表查询确认对应程序名",
          "注意 SAP 对象名大小写敏感（通常为大写）",
        ],
      };
    }
    // 开发客户端守卫
    if (/开发客户端|非开发|cccategori|生产客户端|test client|dev client/i.test(text)) {
      return {
        type: "devclient",
        icon: "🏢",
        title: "非开发客户端，写操作被拒绝",
        color: "var(--warning)",
        tips: [
          "SapBuddy 安全策略：仅允许在开发客户端（C 类）执行写操作",
          "当前连接的 SAP 客户端可能是生产/测试/演示客户端",
          "在设置 → SAP连接 中切换到开发客户端（通常为 100/200/300 中的开发环境）",
          "如确需在当前客户端操作，请联系管理员确认客户端类别",
        ],
      };
    }
    // 默认错误
    return {
      type: "unknown",
      icon: "❌",
      title: "工具执行出错",
      color: "var(--error)",
      tips: [
        "查看下方错误详情了解具体原因",
        "如问题持续，可尝试重新生成回复或切换 SAP 连接",
        "复制错误信息反馈给开发者以便排查",
      ],
    };
  }

  // ── 耗时格式化：毫秒 → 时/分/秒/毫秒友好显示 ──
  function formatDuration(ms) {
    if (ms < 0) ms = 0;
    if (ms < 1000) return ms + "ms";
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const millis = ms % 1000;
    if (hours > 0) {
      return hours + "h " + minutes + "m " + seconds + "s";
    }
    if (minutes > 0) {
      return minutes + "m " + seconds + "s";
    }
    // 小于1分钟，显示秒（保留1位小数）+ 毫秒（如果有）
    const secs = (ms / 1000).toFixed(1);
    return secs + "s";
  }

  // ── 完成工具调用条目 ──
  App.finishToolCard = function(id, resultContent, isError, duration) {
    const item = state.toolCards.get(id);
    if (!item) return;

    // 耗时：优先用传入的 duration（历史会话），否则实时计算
    const dur = duration != null ? duration : (Date.now() - (item._startTime || Date.now()));
    const durEl = item.querySelector(".invoke-duration");
    if (durEl) durEl.textContent = formatDuration(dur);

    // 状态
    const status = item.querySelector(".invoke-status");
    status.className = "invoke-status " + (isError ? "failed" : "done");
    status.textContent = isError ? "✕" : "✓";

    // 结果内容
    let text = "";
    if (Array.isArray(resultContent)) {
      text = resultContent.map((c) => c.text || "").join("\n");
    } else if (typeof resultContent === "string") {
      text = resultContent;
    }
    if (text.length > 8000) text = text.slice(0, 8000) + "\n…（结果过长已截断）";

    const output = item.querySelector(".invoke-output");
    output.innerHTML = "";

    if (isError && text) {
      // 错误友好化：识别错误类型 + 友好提示 + 解决方案 + 可折叠错误详情
      const toolName = item.dataset.toolName || "";
      const errInfo = classifyError(text, toolName);
      item.dataset.errorType = errInfo.type;

      const friendly = document.createElement("div");
      friendly.className = "invoke-error-friendly";
      friendly.innerHTML =
        '<div class="error-friendly-head" style="border-left:3px solid ' + errInfo.color + '">' +
          '<span class="error-icon">' + errInfo.icon + '</span>' +
          '<span class="error-title">' + errInfo.title + '</span>' +
        '</div>' +
        '<div class="error-friendly-tips">' +
          errInfo.tips.map((tip) => '<div class="error-tip">• ' + tip + '</div>').join("") +
        '</div>' +
        '<details class="error-detail-wrap">' +
          '<summary class="error-detail-summary">查看原始错误详情</summary>' +
          '<pre class="invoke-result error-raw"></pre>' +
        '</details>' +
        '<div class="error-actions">' +
          '<button class="btn-sm error-copy-btn" type="button">📋 复制错误信息</button>' +
        '</div>';
      friendly.querySelector(".error-raw").textContent = text;
      friendly.querySelector(".error-copy-btn").addEventListener("click", () => {
        navigator.clipboard.writeText("[" + toolName + "] " + text).then(() => {
          const btn = friendly.querySelector(".error-copy-btn");
          const orig = btn.textContent;
          btn.textContent = "✓ 已复制";
          setTimeout(() => { btn.textContent = orig; }, 1500);
        }).catch(() => {});
      });
      output.appendChild(friendly);
    } else {
      // 正常结果
      const pre = document.createElement("pre");
      pre.className = "invoke-result";
      pre.textContent = text || "(无输出)";
      output.appendChild(pre);
    }
  };

  // 兼容旧接口：保留 enforceToolCollapse（新结构用 CSS max-height，无需 JS 兜底）
  App.enforceToolCollapse = function() {};
})();
