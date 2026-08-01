/**
 * 轻量 Markdown 渲染 — 代码块纯文本输出，无高亮
 */
"use strict";

(function() {
  const App = window.AbapBuddy;
  const escapeHtml = App.escapeHtml;

  App.renderMarkdown = function(src) {
    const blocks = [];
    const stashBlock = (html) => { blocks.push(html); return "\x01" + (blocks.length - 1) + "\x02"; };

    let text = src.replace(/\r\n/g, "\n");

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
})();
