# SapBuddy

> SAP ABAP AI 全能助手 —— 面向**开发顾问与业务顾问**，用自然语言驱动 42 个 SAP 工具（搜索、读码、分析、开发、ATC、单测、SQL、DDIC 管理、程序解读……）

基于 [pi-coding-agent](https://github.com/badlogic/pi-mono)（AI Agent 引擎）与 [abap-adt-api](https://github.com/marcellourbani/abap-adt-api)（SAP ADT 协议）构建，跨平台（Windows / macOS / Linux）。

## ✨ 功能

- 💬 **自然语言开发**：对话完成 SAP 代码查询、分析、修改、测试
- 🛠 **42 个 SAP 工具**：搜索对象、读源码、where-used、ATC 检查、单元测试、SQL 查询、传输请求、版本历史、ST22 dump 分析、DDIC 管理（表/结构/数据元素/域/CDS）、文本元素与 text pool 多语言翻译……
- 🔒 **默认只读**：写操作（创建/编辑/激活）可单独开启，生产安全
- 🖥 **CLI + Web 双模式**：终端交互 / 浏览器界面
- 🔀 **多模型**：支持 DeepSeek、OpenAI、Anthropic、Qwen 等（pi 生态）

## 📦 安装

需要 Node.js ≥ 20。

```bash
git clone https://github.com/yourname/sapbuddy.git
cd sapbuddy
npm install
npm run build
```

## ⚙️ 配置

### 1. AI 模型 Key

```bash
cp config/auth.example.json .pi/auth.json
# 编辑 .pi/auth.json 填入你的 API Key
```

### 2. SAP 连接

```bash
cp config/connections.example.json connections.json
# 编辑 connections.json 填入 SAP 系统信息
# （ADT 需在 SICF 中激活 /sap/bc/adt，自签名证书请设置 ssl.allowSelfSigned）
```

### 3. （可选）模型与思考级别

```bash
cp config/settings.example.json .pi/settings.json
```

## 🚀 使用

```bash
# 交互式对话
npm run chat
# 或 node cli.mjs chat

# 单次提问
node cli.mjs "搜索 ZCL_* 开头的类"

# 启动 Web 版（浏览器打开 http://127.0.0.1:7400）
node cli.mjs web

# 其他
node cli.mjs tools     # 列出 42 个 SAP 工具
node cli.mjs doctor    # 环境自检
```

## 📁 项目结构

```
sapbuddy/
├── cli.mjs                 # CLI 入口（chat / 单次 / web / tools / doctor）
├── src/
│   ├── agent-core.mjs      # pi SDK 会话管理 + 模型解析
│   ├── sap-tools/          # 42 个 SAP 工具（纯 Node，基于 abap-adt-api）
│   │   ├── tools/*.ts         工具实现（zod schema + execute）
│   │   ├── adtManager.ts      SAP 连接池
│   │   ├── config.ts          连接配置加载
│   │   └── register.ts        ★ 工具注册适配（zod → TypeBox → pi.registerTool）
│   └── web/
│       ├── server.mjs      # 本地 Web 服务器（SSE 流式）
│       └── public/         # Web UI（聊天界面）
├── config/                 # 配置模板（不包含真实凭据）
├── docs/                   # 文档（测试指南等）
└── .pi/                    # pi 运行时配置（auth/settings，已 gitignore）
```

## 🧪 测试

完整的测试流程见 [docs/TESTING.md](./docs/TESTING.md)，覆盖 CLI / Web / 42 工具回归矩阵。

## 🧩 架构

```
用户 ──CLI / Web──► pi SDK (AgentSession)
                       │  42 个 SAP 工具（方案 C：直接函数调用，无 MCP 进程）
                       ▼
                  abap-adt-api ──ADT HTTPS──► SAP /sap/bc/adt
```

## 🔌 MCP 集成

- **设置-MCP** 可添加外部 MCP 服务器（如 SAP 端 ZSX_MCP），保存后自动连接测试并**立即生效**
- 轻量 streamable-http 客户端（零依赖），支持 JSON/SSE、自定义 header、自签名证书（tls.rejectUnauthorized）
- MCP 工具以 `mcp_<服务器>_<工具名>` 注册为 customTools，与内置 42 工具同等可用
- 配置保存到 `.pi/mcp.json`（项目）并同步 `~/.pi/agent/mcp.json`（pi mcp gateway）

## 🔒 安全

- 默认 `security.readOnly: true`，写操作需显式开启
- **开发客户端守卫（默认开启）**：写操作前自动查询 `T000.CCCATEGORY` 判断客户端类别，
  仅允许开发类客户端（SAP 角色 `C` 定制/客户开发，默认）修改代码；
  **测试（T）/ 生产（P）/ 演示（D）/ 培训（E）/ SAP参考（S）客户端一律拒绝**，无法确认类别时 fail-closed（拒绝）。
  连接级配置 `security.requireDevClient: false` 可显式放行（不推荐），
  `security.developmentCategories` 可调整放行类别列表。
- SAP 密码与模型 Key 不写入代码库（配置模板已脱敏）
- 工具描述内置避坑说明，错误信息可自愈

## 🤝 贡献

欢迎 PR。请保持：

- 代码风格：Prettier、无分号、双引号
- 提交前 `npm run format`（如有）
- 工具遵循"读优先、写需显式授权"原则

## 🙏 致谢与参考

本项目的 SAP 工具设计与 ADT 交互模式参考了 [marcellourbani/vscode_abap_remote_fs](https://github.com/marcellourbani/vscode_abap_remote_fs)（ABAP Remote FileSystem）及其内置语言模型工具，并基于 [marcellourbani/abap-adt-api](https://github.com/marcellourbani/abap-adt-api) 实现。详见 [CREDITS.md](./CREDITS.md)。

## 📄 License

[MIT](./LICENSE)
