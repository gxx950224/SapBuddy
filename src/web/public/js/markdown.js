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
      return stashBlock('<div class="code-block-wrapper">' + langTag + '<button class="code-copy-btn" data-target="' + blockId + '" title="\u590D\u5236\u4EE3\u7801">\u590D\u5236</button><pre id="' + blockId + '"><code>' + escapeHtml(code.replace(/\n$/, "")) + '</code></pre></div>');
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
      r = r.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      return r;
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
  App.renderMermaid = function(container) {
    if (!container) return;
    if (typeof window.mermaid === "undefined") return;
    const nodes = container.querySelectorAll(".mermaid[data-code]:not([data-rendered])");
    if (!nodes.length) return;
    try {
      if (!window.mermaid.initialize) {
        // v10+：mermaid 自动初始化，设置主题
        window.mermaid.initialize({ startOnLoad: false, theme: App.isDark?.() ? "dark" : "default", securityLevel: "loose", flowchart: { useMaxWidth: true } });
      }
    } catch { /* 忽略 */ }
    nodes.forEach((el) => {
      const raw = decodeURIComponent(el.dataset.code || "");
      const code = fixMermaid(raw)
      try {
        window.mermaid.parse(code);
        const id = "mermaid-" + Math.random().toString(36).slice(2, 8);
        window.mermaid.render(id, code).then(({ svg }) => {
          if (svg) {
            el.innerHTML = svg;
            el.dataset.rendered = "1";
            el.dataset.code = encodeURIComponent(raw); // 保留原始代码供复制
            attachMermaidToolbar(el, raw);
          }
        }).catch((err) => {
          el.dataset.rendered = "1";
          el.classList.add("mermaid-error");
          el.setAttribute("title", "Mermaid 渲染失败: " + (err && err.message ? err.message : String(err)));
        });
      } catch (err) {
        el.dataset.rendered = "1";
        el.classList.add("mermaid-error");
        el.setAttribute("title", "Mermaid 渲染失败: " + (err && err.message ? err.message : String(err)));
      }
    });
  };

  /** 给渲染后的 mermaid 图挂工具栏（放大查看 / 复制代码） */
  function attachMermaidToolbar(el, rawCode) {
    if (el.querySelector(".mermaid-toolbar")) return;
    const bar = document.createElement("div");
    bar.className = "mermaid-toolbar";
    bar.innerHTML =
      '<button class="mermaid-zoom-btn" title="放大查看">\u26F0\uFE0F \u653E\u5927</button>' +
      '<button class="mermaid-copy-btn" title="复制 Mermaid 源码">\u{1F4CB} \u590D\u5236\u4EE3\u7801</button>';
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
        body.innerHTML = svg || "";
      }).catch(() => {
        body.innerHTML = '<pre class="mermaid-lightbox-fallback">' + App.escapeHtml(rawCode) + "</pre>";
      });
    } catch {
      body.innerHTML = '<pre class="mermaid-lightbox-fallback">' + App.escapeHtml(rawCode) + "</pre>";
    }
  }

  // lightbox 关闭
  document.addEventListener("click", (e) => {
    const overlay = document.getElementById("mermaid-overlay");
    if (!overlay) return;
    if (e.target === overlay) overlay.classList.remove("open");
  });
  const closeBtn = document.getElementById("mermaid-lightbox-close");
  if (closeBtn) closeBtn.addEventListener("click", () => {
    const o = document.getElementById("mermaid-overlay");
    if (o) o.classList.remove("open");
  });
  const copyBtn = document.getElementById("mermaid-lightbox-copy");
  if (copyBtn) copyBtn.addEventListener("click", () => {
    const overlay = document.getElementById("mermaid-overlay");
    const body = document.getElementById("mermaid-lightbox-body");
    const svgEl = body?.querySelector("svg");
    // 从 lightbox 的 svg 回找源码：存于 sourceEl 引用
    const src = overlay?._mermaidRaw;
    if (src) {
      App.copyText(src).then(() => {
        const old = copyBtn.textContent;
        copyBtn.textContent = "\u2713 \u5DF2\u590D\u5236";
        setTimeout(() => { copyBtn.textContent = old; }, 1500);
      });
    } else if (svgEl) { /* 无源码时忽略 */ }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const o = document.getElementById("mermaid-overlay");
      if (o?.classList.contains("open")) o.classList.remove("open");
    }
  });
})();
