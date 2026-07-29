# /abap-webide — 打开网页版 ABAP Code Studio

## 触发条件
用户要求打开网页版开发工具、Web IDE、ABAP Code Studio，或希望在浏览器中以对话方式进行 ABAP 开发。

## 工作流程

1. 调用 `abap_webide` 工具（无参数）。
2. 工具会自动：检测本地服务（127.0.0.1:7400）→ 未运行则启动 → 打开浏览器。
3. 将返回的地址告知用户，并简述网页版能力：
   - 与 PI Agent 对话（同一套 gxx-abap CLI 工具、AGENTS.md 铁律、AbapBuddy 规范）
   - 工具调用过程可视化（ls / meta / put 等操作卡片）
   - 生成的代码文件落盘 `output/`，可在网页中下载
   - 支持停止生成、历史恢复、双主题

## 注意

- 服务独立运行（`node webide/server.mjs`），不依赖当前 CLI 会话存活。
- 若启动超时，提示用户手动执行 `node webide/server.mjs` 排查。
