<div align="center">

# 🛠 SapBuddy

**SAP ABAP AI 全能助手** —— 面向开发顾问与业务顾问

用自然语言驱动 **42 个 SAP 工具**：搜索、读码、开发、审查、ATC、单测、SQL、DDIC 管理、程序解读……

[![npm version](https://img.shields.io/npm/v/sapbuddy.svg)](https://www.npmjs.com/package/sapbuddy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/gxx950224/sapbuddy/ci.yml?branch=main)](https://github.com/gxx950224/sapbuddy/actions)
[![Node](https://img.shields.io/badge/node-%3E%3D20-green)](package.json)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

</div>

---

## ✨ 为什么用 SapBuddy？

| 场景 | 传统方式 | SapBuddy |
|---|---|---|
| 查一个 Z 报表逻辑 | SE38 打开 → 逐行读 → 查表查字段 | 💬 "解释 ZPPR006 在做什么" |
| 开发新报表 | 手写选择屏幕/ALV/查询模板 | 💬 "创建报表 ZAIR007，读取 XXX" |
| 代码审查 | 人工逐条核对规范 | 💬 "审查 ZPPR085" → 4 页签 HTML 报告 |
| 查表数据 | SE16N 手动查询 | 💬 "查 T000 全部客户端类别" |
| DDIC 变更 | SE11 一步步建域/元素/表 | 💬 "创建数据元素+域"（自动补文本） |

## 🎯 核心特性

- 💬 **自然语言开发**：对话完成 SAP 对象查询、分析、开发、审查、测试
- 🛠 **42 个内置 SAP 工具**：对象搜索 / 源码读取 / where-used / ATC 质量门禁 / 单元测试 / SQL 查询 / 传输请求 / 版本历史 / ST22 dump 分析 / DDIC 管理（表/结构/数据元素/域/CDS）/ 文本元素与多语言翻译 / 调试辅助
- 🔒 **安全三重防线**：默认只读 + **开发客户端守卫**（`T000.CCCATEGORY` 非开发类自动拦截写操作）+ 生产环境 fail-closed
- 🖥 **CLI + Web 双模式**：终端交互 / 浏览器界面（SSE 流式）
- 🔀 **多模型**：DeepSeek / OpenAI / Anthropic / Qwen 等（pi 生态）
- 🔌 **MCP 兼容**：可接入外部 MCP 服务器（如 SAP 端 ZSX_MCP），CLI 与 Web 双端自动注册，工具即时可用

## 📸 截图

> 截图待补充（提交 PR 或 issue 贡献截图）——CLI 对话 / Web 界面 / 代码审查报告

## 🚀 快速开始

### 方式 A：npm 全局安装（推荐）

```bash
npm install -g sapbuddy
sapbuddy doctor    # 环境自检
```

### 方式 B：源码运行

```bash
git clone https://github.com/gxx950224/sapbuddy.git
cd sapbuddy
npm install
npm run build
```

### 首次配置（两种方式相同）

> 所有配置保存在 `.SapBuddy/`（隐藏目录）：auth.json / connections.json / settings.json / sessions / skills / prompts / output。首次运行自动初始化默认技能与提示词。

```bash
# 1. AI 模型 API Key
mkdir -p .SapBuddy
cp config/auth.example.json .SapBuddy/auth.json
#    编辑 .SapBuddy/auth.json 填入你的 Key

# 2. SAP 连接（ADT 需在 SICF 激活 /sap/bc/adt）
cp config/connections.example.json .SapBuddy/connections.json
#    编辑 .SapBuddy/connections.json 填入系统地址/客户端/账号

# 3.（可选）模型与思考级别
cp config/settings.example.json .SapBuddy/settings.json
```

### 开始对话

```bash
sapbuddy chat                      # 交互式对话
sapbuddy web                       # Web 版（http://127.0.0.1:7400）
sapbuddy "搜索 ZCL_* 开头的类"      # 单次提问
sapbuddy tools                     # 列出 42 个 SAP 工具 + 已配置的 MCP 工具
```

## 🧩 架构

```
用户 ──CLI / Web──► pi SDK (AgentSession)
                       │  42 个 SAP 工具（直接函数调用）
                       ▼
                  abap-adt-api ──ADT HTTPS──► SAP /sap/bc/adt
```

- **直接集成**：42 个工具是纯函数模块，直接注册为 Agent customTools，不依赖 MCP 框架
- 工具注册在扩展加载期完成；MCP 服务器（可选）通过 async factory 动态注册

## 📁 项目结构

```
sapbuddy/
├── cli.mjs                 # CLI 入口（chat / 单次 / web / tools / doctor）
├── src/
│   ├── agent-core.mjs      # pi SDK 会话管理 + 模型解析 + 运行时初始化
│   ├── sap-tools/          # 42 个 SAP 工具（TypeScript，基于 abap-adt-api）
│   └── web/                # 本地 Web 服务器 + UI + MCP 客户端
├── defaults/               # 默认技能与 models.json（随包发布，首次运行拷贝到 .SapBuddy/）
├── config/                 # 配置模板（不含真实凭据）
├── test/                   # 冒烟测试（node --test）
└── docs/                   # 文档
```

> 运行时配置（`.SapBuddy/`：auth/连接/会话/技能/产物/MCP）由程序自动初始化，不随仓库与 npm 包分发。

## 🔒 安全

- **默认只读**：`security.readOnly: true`，写操作需显式开启
- **开发客户端守卫（默认开启）**：写操作前查询 `T000.CCCATEGORY`，仅开发类客户端（`C` 定制/客户开发）允许修改代码；测试（T）/生产（P）/演示（D）/培训（E）/SAP 参考（S）**一律拒绝**；无法确认时 fail-closed
- SAP 密码与 API Key 永不入库（模板脱敏，`.gitignore` 排除）
- 写操作需用户**先审核改动内容**后才执行（Agent 强制门禁）

## 🧪 测试

```bash
npm test        # 冒烟测试：工具加载 / CLI / 构建产物 / 配置模板
npm run check   # TypeScript 类型检查
```

完整回归矩阵见 [docs/TESTING.md](./docs/TESTING.md)。

## ❓ FAQ

**Q：需要什么 SAP 权限？**
ADT 服务（`/sap/bc/adt`）访问权限 + 目标对象读写权限；查询类工具需要相应授权对象。

**Q：如何接入自己的模型？**
编辑 `.SapBuddy/auth.json` 配置 API Key，`.SapBuddy/models.json` 添加模型，设置页（Web）可直接切换。

**Q：MCP 工具如何使用？**
设置-MCP 添加服务器（streamable-http，兼容 SSE 响应），保存后自动连接测试并注册为 `mcp_<服务器>_<工具名>`，CLI 与 Web 双端同等可用。服务器名来自 mcp.json 的 key，引用时需全小写下划线写法（如 `mcp_sap-mcp-dev_GET_TCODE_INFO`）。

**Q：为什么在测试机上写操作被拒绝？**
开发客户端守卫拦截——这是设计意图。仅开发类客户端（默认 C）可写，见 [安全](#-安全)。

## 🗺 Roadmap

- [x] 42 个 SAP 工具（搜索/读码/写/ATC/单测/SQL/DDIC/文本/翻译/调试）
- [x] CLI + Web 双模式
- [x] 开发客户端守卫 + 写前审核门禁
- [x] MCP 服务器接入
- [ ] 批量代码审查报告（多对象）
- [ ] 自定义工具脚本（SAP 端 JS 插件）
- [ ] 团队协作（共享技能/规范包）

## 🤝 贡献

欢迎 PR！见 [CONTRIBUTING.md](./CONTRIBUTING.md)。代码风格：无分号、双引号、严格 TS。

## 🙏 致谢

SAP 工具设计与 ADT 交互参考 [marcellourbani/vscode_abap_remote_fs](https://github.com/marcellourbani/vscode_abap_remote_fs) 及其 LM Tools，基于 [abap-adt-api](https://github.com/marcellourbani/abap-adt-api) 实现。详见 [CREDITS.md](./CREDITS.md)。

## 📄 License

[MIT](./LICENSE)
