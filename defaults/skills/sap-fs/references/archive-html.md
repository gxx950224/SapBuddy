# HTML 归档交付

企业归档除 Markdown（给 AI / 协作）外，**必须同时**生成一份 HTML。

## 产出物

默认目录：`~/.SapBuddy/output/fs/<需求名>/`

| 文件 | 说明 |
| --- | --- |
| `FS.md` | 主规格（AI 友好） |
| `FS.html` | 归档版：用 `assets/templates/fs-archive.html` 填入 |
| `io-request.json` / `io-response.json`（仅接口类） | 与正文 3.6 样例一致；若有回调可再加 `io-callback.json` |

用户指定路径时，在同一目录并列输出。

## HTML 规则

1. **禁止 logo**：不放公司徽标、项目 Logo、水印、背景品牌图；页眉只用文字标题与元信息。
2. **自包含**：单文件；CSS 内联；无外链脚本/字体 CDN。
3. **内容来源**：由已定稿的 `FS.md` 渲染为 HTML 片段填入 `{{BODY_HTML}}`；表格保留为 `<table>`；代码块用 `<pre>`。
4. **版式**：清晰层级（h1–h3）、可打印（`@media print` 已在模板）；不模仿客户 Word 封面里的企业 VI。
5. **替换占位符**：`{{DOC_TITLE}}` `{{STATUS_LINE}}` `{{PROJECT_MODULE}}` `{{SYSTEM_CLIENT}}` `{{REQUESTER}}` `{{FS_TYPE}}` `{{UPDATED}}` `{{BODY_HTML}}`；交付稿不得残留 `{{...}}`。

## 接口类 JSON

- 字段表（3.2）是权威；JSON 样例必须与路径/类型/必填/空值处理一致。
- 至少各一份请求与响应；异步/回调按 3.1 再补。
- JSON 文件与 HTML 内「样例 JSON」节内容相同，便于联调拷贝。
- 未知字段不编造：留 Q，或从样例省略并在说明里写清。

## 生成顺序

定稿 Markdown →（接口类）整理 JSON 文件 → 填 HTML 模板 → 自检无 logo、无占位符、接口样例齐全。
