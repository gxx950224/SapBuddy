/**
 * 轻量 Markdown 渲染 — 代码块纯文本输出，无高亮
 */
"use strict";

(function() {
  const App = window.SapBuddy;
  const escapeHtml = App.escapeHtml;

  App.renderMarkdown = function(src) {
    const blocks = [];
    const stashBlock = (html) => { blocks.push(html); return "\x01" + (blocks.length - 1) + "\x02"; };

    let text = src.replace(/\r\n/g, "\n");

    // Mermaid 图：```mermaid\n...``` → 渲染为图表（由 App.renderMermaid 异步渲染）
    text = text.replace(/^```mermaid\s*\n([\s\S]*?)^```\s*$/gm, (m, code) => {
      const clean = code.replace(/\n$/, "");
      return "\n\n" + stashBlock('<div class="mermaid" data-code="' + encodeURIComponent(clean) + '"><pre><code>' + escapeHtml(clean) + '</code></pre></div>') + "\n\n";
    });

    // 代码块 ```lang\n...```
    text = text.replace(/^```(\w*)\n([\s\S]*?)^```\s*$/gm, (m, lang, code) => {
      const blockId = 'code-' + Math.random().toString(36).slice(2, 8);
      const langTag = lang ? '<span class="code-lang">' + lang + '</span>' : '';
      // language-{lang} \u7C7B\u9A71\u52A8 highlight.js \u9AD8\u4EAE\uFF08abap \u547D\u4E2D\u7B2C\u4E09\u65B9\u8BED\u6CD5\uFF09
      const langClass = lang ? ' class="language-' + escapeHtml(lang) + '"' : '';
      return stashBlock('<div class="code-block-wrapper">' + langTag + '<button class="code-copy-btn" data-target="' + blockId + '" title="\u590D\u5236\u4EE3\u7801">\u590D\u5236</button><pre id="' + blockId + '"><code' + langClass + '>' + escapeHtml(code.replace(/\n$/, "")) + '</code></pre></div>');
    });

    // 表格 | a | b |
    text = text.replace(/((?:^\|[^\n]+\|\s*$\n?){2,})/gm, (table) => {
      const rows = table.trim().split("\n").filter((r) => !/^\|[\s:\-|]+\|$/.test(r.trim()));
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      let html = "<table>";
      rows.forEach((r, i) => {
        const tag = i === 0 ? "th" : "td";
        html += "<tr>" + cells(r).map((c) => `<${tag}>${inlineMd(c)}</${tag}>`).join("") + "</tr>";
      });
      return "\n\n" + stashBlock(html + "</table>") + "\n\n";
    });

    // 标题
    text = text.replace(/^ {0,3}(#{1,4})\s+(.+)$/gm, (m, h, t) => "\n\n" + stashBlock(`<h${h.length}>${inlineMd(t)}</h${h.length}>`) + "\n\n");

    // 引用
    text = text.replace(/(^ {0,3}> .+(\n|$))+/gm, (q) => {
      const inner = q.split("\n").filter(Boolean).map((l) => l.replace(/^ {0,3}> ?/, "")).join("<br>");
      return "\n\n" + stashBlock(`<blockquote>${inlineMd(inner)}</blockquote>`) + "\n\n";
    });

    // 无序列表
    text = text.replace(/((?:^ {0,3}[-*] .+\n?)+)/gm, (list) => {
      const items = list.trim().split("\n").map((l) => `<li>${inlineMd(l.replace(/^ {0,3}[-*] /, ""))}</li>`).join("");
      return "\n\n" + stashBlock(`<ul>${items}</ul>`) + "\n\n";
    });

    // 有序列表
    text = text.replace(/((?:^ {0,3}\d+[.)] .+\n?)+)/gm, (list) => {
      const items = list.trim().split("\n").map((l) => `<li>${inlineMd(l.replace(/^ {0,3}\d+[.)] /, ""))}</li>`).join("");
      return "\n\n" + stashBlock(`<ol>${items}</ol>`) + "\n\n";
    });

    // 段落
    text = text.split(/\n{2,}/).map((para) => {
      const t = para.trim();
      if (!t) return "";
      if (/^\x01\d+\x02$/.test(t)) return t;
      return `<p>${inlineMd(t).replace(/\n/g, "<br>")}</p>`;
    }).join("\n");

    // 还原块
    text = text.replace(/\x01(\d+)\x02/g, (m, i) => blocks[+i]);

    // 渲染 Mermaid 图（DOM 插入后异步执行）
    if (/class="mermaid"/.test(text)) {
      setTimeout(() => App.renderMermaid(document.body), 0);
    }
    return text;

    function inlineMd(s) {
      let r = escapeHtml(s);
      r = r.replace(/`([^`\n]+)`/g, '<code class="inline">$1</code>');
      r = r.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
      r = r.replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, "<em>$1</em>");
      r = r.replace(/\[([^\]]+)\]\((https?:[^)"\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      return r;
    }
  };

  /**
   * 渲染 markdown 到容器；opts.highlight 时对代码块做语法高亮。
   * 高亮只应在"全文渲染"时机调用（非流式/流结束/历史），流式增量 tick 内绝不调用，
   * 否则增量 textNode 会破坏 hljs 生成的 span 结构。
   */
  App.mountMarkdown = function(container, src, opts) {
    container.innerHTML = App.renderMarkdown(src);
    if (opts?.highlight) App.highlightCodeBlocks(container);
    return container;
  };

  /** 对容器内所有 pre code 做语法高亮（跳过 .mermaid 回退源码与已高亮节点） */
  App.highlightCodeBlocks = function(container) {
    if (!container || !window.hljs) return;
    try { hljs.configure({ ignoreUnescapedHTML: true }); } catch {}
    for (const code of container.querySelectorAll("pre code")) {
      if (code.classList.contains("hljs") || code.dataset.highlighted) continue;
      if (code.closest(".mermaid")) continue;
      try {
        // 未注册语言（如 abap）会让 hljs 走"全语言自动检测"：大代码块（整段程序/长文本）会同步阻塞主线程，
        // 冻结整页滚动与交互（表现为"输出时滚动条卡住、只能刷新"）。未知语言的大块改为按纯文本高亮
        // （毫秒级完成），小片段保留自动检测（快、且能识别多数语言）。
        const langCls = (code.className.match(/language-([a-zA-Z0-9_+-]+)/) || [])[1];
        const big = (code.textContent || "").length > 3000;
        const known = langCls ? hljs.getLanguage(langCls) : null;
        if (big && langCls && !known) {
          code.innerHTML = hljs.highlight(code.textContent, { language: "plaintext" }).value;
          code.classList.remove("language-" + langCls);
          code.dataset.highlighted = "1";
          continue;
        }
        hljs.highlightElement(code);
      } catch { /* 单块失败不影响整体 */ }
    }
  };

  /**
   * Mermaid 容错：对未引号的节点文本自动加引号（AI 生成的图常漏引号导致解析失败）
   * 例：A[入口 IS_DATA (抬头+行项目)] → A["入口 IS_DATA (抬头+行项目)"]
   */
  function fixMermaid(code) {
    // 节点文本含中文/括号/特殊符号但未引号 → 加引号（跳过已引号/含子图/注释行）
    let out = code.replace(/(\b[A-Za-z_][A-Za-z0-9_]*)\[([^\]"\n]*)\]/g, (m, id, txt) => {
      if (txt.includes('"') || txt.includes('<br')) return m
      if (!/[\(\[\{\)\]\}\u4e00-\u9fa5:：;；,，。、+/=]/.test(txt)) return m
      return `${id}["${txt.replace(/"/g, "'")}"]`
    })
    out = out.replace(/(\b[A-Za-z_][A-Za-z0-9_]*)\{([^\}"\n]*)\}/g, (m, id, txt) => {
      if (txt.includes('"') || txt.includes('<br')) return m
      if (!/[\(\[\{\)\]\}\u4e00-\u9fa5:：;；,，。、+/=]/.test(txt)) return m
      return `${id}{"${txt.replace(/"/g, "'")}"}`
    })
    // 边标签 |文本|（中文/括号未引号）
    out = out.replace(/\|([^\|"\n]*[\u4e00-\u9fa5\u0028\u0029][^\|"\n]*)\|/g, (m, txt) => {
      if (txt.includes('"')) return m
      return `|"${txt.replace(/"/g, "'")}"|`
    })
    return out
  }

  /**
   * 渲染容器内所有未渲染的 .mermaid 节点
   * 首次调用初始化 mermaid（theme 跟随页面主题），渲染失败降级显示源码
   */
  App.renderMermaid = async function(container) {
    if (!container) return;
    if (typeof window.mermaid === "undefined") return;
    const nodes = container.querySelectorAll(".mermaid[data-code]:not([data-rendered])");
    if (!nodes.length) return;
    try {
      // v10+：统一初始化并设置主题（跟随页面深色/浅色）
      if (window.mermaid.initialize) {
        window.mermaid.initialize({ startOnLoad: false, theme: App.isDark?.() ? "dark" : "default", securityLevel: "loose", flowchart: { useMaxWidth: true } });
      }
    } catch { /* 忽略 */ }
    for (const el of nodes) {
      const raw = decodeURIComponent(el.dataset.code || "");
      const code = fixMermaid(raw);
      let err = null;
      try {
        // v10 parse 返回 Promise，必须 await 才能真正捕获语法错误
        await window.mermaid.parse(code);
      } catch (e) { err = e; }
      if (err) { markMermaidError(el, raw, err); continue; }
      try {
        const id = "mermaid-" + Math.random().toString(36).slice(2, 8);
        const { svg } = await window.mermaid.render(id, code);
        // v10 render 解析失败不报错，而是 resolve 一张错误 SVG（含 error-text/Syntax error），需识别后降级
        // 先剥掉 <style>：每张正常 SVG 的样式里都定义了 .error-text 类，不剥会误伤所有图
        const svgText = String(svg ?? "").replace(/<style[\s\S]*?<\/style>/gi, "")
        if (!svg || /error-text|Syntax error|Parse error/i.test(svgText)) {
          markMermaidError(el, raw, new Error("语法错误"));
          continue;
        }
        el.innerHTML = svg;
        el.dataset.rendered = "1";
        el.dataset.code = encodeURIComponent(raw); // 保留原始代码供复制
        attachMermaidToolbar(el, raw);
      } catch (e) {
        markMermaidError(el, raw, e);
      }
    }
  };

  /** mermaid 渲染失败：标记并保留源码（不显示错误图），附一行友好提示 */
  function markMermaidError(el, raw, err) {
    el.dataset.rendered = "1";
    el.classList.add("mermaid-error");
    el.setAttribute("title", "Mermaid 渲染失败: " + (err && err.message ? err.message : String(err)));
    if (!el.querySelector(".mermaid-error-hint")) {
      const hint = document.createElement("div");
      hint.className = "mermaid-error-hint";
      hint.textContent = "图未生成成功，已保留源码供查看";
      el.prepend(hint);
    }
  }

  /** 给渲染后的 mermaid 图挂工具栏（放大查看 / 复制代码） */
  function attachMermaidToolbar(el, rawCode) {
    if (el.querySelector(".mermaid-toolbar")) return;
    const bar = document.createElement("div");
    bar.className = "mermaid-toolbar";
    bar.innerHTML =
      '<button class="mermaid-zoom-btn" title="放大查看">放大</button>' +
      '<button class="mermaid-copy-btn" title="复制 Mermaid 源码">复制代码</button>';
    el.prepend(bar);
    bar.querySelector(".mermaid-zoom-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      openMermaidLightbox(el, rawCode);
    });
    bar.querySelector(".mermaid-copy-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      App.copyText(rawCode).then(() => {
        const b = e.currentTarget;
        const old = b.textContent;
        b.textContent = "\u2713 \u5DF2\u590D\u5236";
        setTimeout(() => { b.textContent = old; }, 1500);
      });
    });
  }

  /** 放大查看：全屏 lightbox 重新渲染大图 */
  function openMermaidLightbox(sourceEl, rawCode) {
    const overlay = document.getElementById("mermaid-overlay");
    const body = document.getElementById("mermaid-lightbox-body");
    if (!overlay || !body) return;
    overlay._mermaidRaw = rawCode; // 供 lightbox 复制按钮使用
    body.innerHTML = '<div class="mermaid-lightbox-loading">\u6B63\u5728\u6E32\u67D3\u56FE\u8868\u2026</div>';
    overlay.classList.add("open");
    // 大图重新渲染（theme 同源）
    const code = fixMermaid(rawCode);
    try {
      const id = "mermaid-zoom-" + Math.random().toString(36).slice(2, 8);
      window.mermaid.render(id, code).then(({ svg }) => {
        // 与列表同规则：render 返回的错误 SVG（Syntax error）也要降级显示源码（先剥 <style> 避免误伤正常图）
        if (!svg || /error-text|Syntax error|Parse error/i.test(String(svg ?? "").replace(/<style[\s\S]*?<\/style>/gi, ""))) {
          body.innerHTML = '<pre class="mermaid-lightbox-fallback">' + App.escapeHtml(rawCode) + "</pre>";
          return;
        }
        body.innerHTML = svg || "";
      }).catch(() => {
        body.innerHTML = '<pre class="mermaid-lightbox-fallback">' + App.escapeHtml(rawCode) + "</pre>";
      });
    } catch {
      body.innerHTML = '<pre class="mermaid-lightbox-fallback">' + App.escapeHtml(rawCode) + "</pre>";
    }
  }

  // lightbox 关闭/查看代码：事件委托（markdown.js 先于 overlay div 加载，委托不受 DOM 顺序影响）
  document.addEventListener("click", (e) => {
    const overlay = document.getElementById("mermaid-overlay");
    if (!overlay) return;
    if (e.target === overlay) { overlay.classList.remove("open"); return; }
    // 关闭按钮
    if (e.target.closest("#mermaid-lightbox-close")) {
      overlay.classList.remove("open");
      return;
    }
    // 查看代码：切换右侧源码面板
    if (e.target.closest("#mermaid-lightbox-code")) {
      const panel = document.getElementById("mermaid-lightbox-code-panel");
      const view = document.getElementById("mermaid-code-view");
      if (!panel) return;
      if (panel.classList.contains("open")) {
        panel.classList.remove("open");
      } else {
        if (view && overlay._mermaidRaw) view.textContent = overlay._mermaidRaw;
        panel.classList.add("open");
      }
      return;
    }
    // 源码面板内复制
    if (e.target.closest("#mermaid-code-copy")) {
      const src = overlay._mermaidRaw;
      if (!src) return;
      App.copyText(src).then(() => {
        const btn = document.getElementById("mermaid-code-copy");
        if (!btn) return;
        const old = btn.textContent;
        btn.textContent = "\u2713 \u5DF2\u590D\u5236";
        setTimeout(() => { btn.textContent = old; }, 1500);
      });
    }
  });

  // 全屏画布拖拽平移（在图表上按住拖动）
  let mermaidDrag = { active: false, x: 0, y: 0, sl: 0, st: 0 };
  document.addEventListener("mousedown", (e) => {
    const overlay = document.getElementById("mermaid-overlay");
    if (!overlay?.classList.contains("open")) return;
    if (e.target.closest("button, a, #mermaid-lightbox-code-panel, #mermaid-lightbox-head")) return;
    const body = document.getElementById("mermaid-lightbox-body");
    if (!body) return;
    mermaidDrag = { active: true, x: e.clientX, y: e.clientY, sl: body.scrollLeft, st: body.scrollTop };
    body.style.cursor = "grabbing";
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!mermaidDrag.active) return;
    const body = document.getElementById("mermaid-lightbox-body");
    if (!body) return;
    body.scrollLeft = mermaidDrag.sl - (e.clientX - mermaidDrag.x);
    body.scrollTop = mermaidDrag.st - (e.clientY - mermaidDrag.y);
  });
  document.addEventListener("mouseup", () => {
    if (!mermaidDrag.active) return;
    mermaidDrag.active = false;
    const body = document.getElementById("mermaid-lightbox-body");
    if (body) body.style.cursor = "grab";
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const o = document.getElementById("mermaid-overlay");
      if (o?.classList.contains("open")) o.classList.remove("open");
    }
  });
})();
