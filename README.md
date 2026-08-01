# AbapBuddy

> SAP ABAP AI 辅助开发助手 —— 用自然语言驱动 42 个 SAP 工具（搜索、读码、分析、ATC、单测、SQL、DDIC 管理……）

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
git clone https://github.com/yourname/abapbuddy.git
cd abapbuddy
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
abapbuddy/
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
└── .pi/                    # pi 运行时配置（auth/settings，已 gitignore）
```

## 🧩 架构

```
用户 ──CLI / Web──► pi SDK (AgentSession)
                       │  42 个 SAP 工具（方案 C：直接函数调用，无 MCP 进程）
                       ▼
                  abap-adt-api ──ADT HTTPS──► SAP /sap/bc/adt
```

## 🔒 安全

- 默认 `security.readOnly: true`，写操作需显式开启
- SAP 密码与模型 Key 不写入代码库（配置模板已脱敏）
- 工具描述内置避坑说明，错误信息可自愈

## 🤝 贡献

欢迎 PR。请保持：

- 代码风格：Prettier、无分号、双引号
- 提交前 `npm run format`（如有）
- 工具遵循"读优先、写需显式授权"原则

## 📄 License

[MIT](./LICENSE)
