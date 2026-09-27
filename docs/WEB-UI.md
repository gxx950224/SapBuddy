# Web 对话界面

Web 对话区由 React 组件渲染，Node 服务、pi Agent、SAP 工具和会话 JSONL 格式保持原有结构。组件源码位于 `src/web/ui/`，`npm run build` 会将单文件脚本和样式生成到 `src/web/public/ui/`，由现有静态服务提供。npm 生命周期在打包前执行同一构建，因此安装包包含可运行的界面资源。

`src/web/ui/main.jsx` 负责会话消息状态及对话组件；`src/web/ui/ProcessTrace.jsx` 和 `process-trace.css` 承载 Beautiful UI 风格的 Thinking、Loading State、Tool Chips 和真实事件映射；`src/web/ui/styles.css` 提供其余对话样式；`vite.config.js` 配置构建。React 只管理 `#messages` 和 `#send-control-root` 两个挂载区，旧脚本通过 `App.chatView` 适配层提交消息、历史、流式事件和操作，不再直接改写这两个区域的子节点。侧栏、设置和文件面板仍由原页面负责。

界面借鉴并适配 [Beautiful UI](https://www.beautifului.dev/) 的卡片、输入栏和状态展示方式。当前是按项目事件流实现的 React 组件，不加载其演示应用或付费图标。参考源码固定在 commit `44a274e598395ab61e7c96c26fda2758780253b7`，MIT 许可证见 `src/web/public/vendor/beautiful-ui-LICENSE.txt`。

## 对话组件

- Thinking、Tool Chips、等待状态和回复正文由 pi 的真实消息及工具事件驱动；文本、思考和工具调用沿原消息顺序显示。
- 代码块保留 Markdown 和 ABAP 高亮，支持复制、行号以及 Diff/代码视图。结束前不对每个流式快照重复运行高亮和 Mermaid。
- 写入确认显示后端拦截的工具名和已脱敏参数。确认词仍通过聊天输入发送，是否授权由现有写入门禁决定。
- 澄清选项、选中内容操作会填入原输入框，不绕过消息发送路径。
- 结构化工具结果若包含记录数组会呈现表格；非结构化结果仍以文本展示。来源引用卡片和多步骤任务没有后端数据时不显示。
- `src/web/session-store.mjs` 维护可重建的会话摘要索引，列表分页、历史分页、搜索和消息原始轮次位置保持不变。
- 原文件树、文本/Markdown/HTML/二进制预览及设置面板继续由现有页面脚本管理；浏览器回归覆盖各设置页签（大模型、SAP、MCP、Memory、Skills、Prompts、About）、模型设置保存和 SAP 密码不回显，不会改动测试机上的真实连接配置。

## 历史和流式更新

按 Beautiful UI 示例映射：01 Loading State 为九宫格像素动画、文字扫光及耗时；02 Thinking 只展示真实 reasoning，并根据内容选择布局；工具调用统一由 05 Tool Chips 展示，不在 Thinking 中重复列出；纯网页检索没有 reasoning 时不额外生成 Thinking 卡片；03 Streaming Text 保留流式 Markdown、原文链接、复制/重试操作和后续提问入口；04 Approval Card 使用单选项、自定义回答及“继续”按钮；05 Tool Chips 按整轮工具调用分组，参数显示为紧凑标签，展开查看结果。

普通提问由 `src/question-tool.mjs` 的 `ask_user` 工具产生，调用及参数随原会话保存，刷新后恢复卡片。选择“继续”先填入输入框，发送后才提交答案。工具返回明确标记为等待用户，不代表已获得回答或写入授权。写操作仍走原有服务端门禁。未提供的引用来源不会凭空生成。

模拟浏览器验收截图保存在 `docs/ui-preview/`，包括思考加载、展开、工具执行、问题卡片和窄屏状态。

- `GET /api/sessions?limit=50&offset=0&q=关键词&pin=会话路径` 返回分页和搜索结果；固定会话先排序再分页。
- `GET /api/history?path=会话路径&limit=20&before=轮次` 默认读取最后 20 个用户轮次及相关回复、工具结果。更早历史按字节范围读取。
- SSE 事件按会话路径隔离；相邻完整消息快照合并，消息身份复用，文本界面状态按动画帧合并更新。
- 浏览器断线后由 EventSource 重连，并重载当前会话状态。用户滚动离开底部时，流式内容更新不会强制拉回底部。
- 分页后的编辑、重新生成和批量删除使用历史原始轮次；浏览器回归覆盖跨页轮次 0 和 25。历史编辑使用原生键盘事件判断输入法组合状态，选词 Enter 不提交消息。

首次建立索引需要扫描会话文件；索引损坏或文件签名变化时会重建相应条目，不修改 JSONL 历史。可用 `npm run bench:web` 重跑索引和历史分页基准：脚本生成独立合成数据并在结束时清理。当前记录环境为 Node.js 24.20、Windows 11、Ryzen 7 7800X3D，数据集为 1,000 个会话，其中一个会话含 2,500 轮、约 2.24 MB 历史；冷建索引 247.56 ms、热刷新 47.01 ms、重启读取缓存 49.42 ms、最近历史页 37.79 ms。热刷新和重启均没有重新扫描历史文件。该基准衡量服务端索引和历史读取，不代表浏览器首屏或实际用户环境耗时。

同一轮浏览器基准使用 Node.js 24.20、Chromium 149、1,000 个合成会话和 1440×1000 / 390×844 视口：DOMContentLoaded 399 ms、包含首批会话列表 440 ms、翻页 57 ms、全局搜索 224 ms、首个流式回复 28 ms、最近历史页 5 ms、112,000 字符回复渲染 102 ms，连续切换 10 个会话 32 ms。SSE 重连快照约 3 秒主要由 EventSource 重试间隔决定，不作为页面渲染性能指标。

## 构建和验证

```powershell
npm run build
npm test
npm run bench:web
```

开发时直接启动前先执行 `npm run build`，再使用 `npm run web`（或 `node cli.mjs web`）。本次构建在 Node.js 24.20 上通过；实际 SAP 只读查询和真实写入门禁仍需连接到对应 SAP 开发环境验证。

## 原版样式对齐

Thinking 和 Tool Chips 对照 Beautiful UI 源码提交 44a274e598395ab61e7c96c26fda2758780253b7 移植：输出流宽度自适应消息卡片、28px 调用行、22px 参数标签、Inter 字体、中性色和 SVG 图标，以及展开和悬停交互。Thinking 只读取真实 reasoning；工具名称、参数和结果由 Tool Chips 统一承载，避免同一工具在两个区域重复；纯 URL 检索且没有 reasoning 时不生成 Thinking 卡片；移除了 demo 的固定计时与虚构数据，状态由 pi 事件驱动；没有真实 diff 时不显示增删数字。长记录默认显示四项，可展开全部。

浏览器回归可设置 SAPBUDDY_REPLAY_SESSION 为本地 JSONL 路径，使用隔离服务回放真实历史，不发送模型请求，不修改会话文件。此次额外验证了指定会话的 42 次调用归并、reasoning 与工具列表不重复渲染及窄屏无页面溢出。
