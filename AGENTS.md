# AGENTS.md — 项目开发指南（面向 AI 编码代理与贡献者）

## 项目简介

SapBuddy：SAP ABAP AI 全能助手，面向开发顾问与业务顾问。基于 pi-coding-agent（AI Agent 引擎）与 abap-adt-api（SAP ADT 协议），通过自然语言驱动 42 个 SAP 工具。CLI + Web 双模式，跨平台。

## 核心架构

```
cli.mjs ──► src/agent-core.mjs ──► pi SDK (AgentSession)
               │
               └── src/sap-tools/    # 42 个 SAP 工具（纯 Node）
                    ├── tools/*.ts      工具实现（zod schema + execute）
                    ├── adtManager.ts   SAP 连接池（basic/OAuth2）
                    ├── config.ts       连接配置加载
                    └── register.ts     ★ 注册适配（zod → TypeBox → pi.registerTool）
```

- **方案 C 直接集成**：工具是纯函数模块，无 MCP 服务器/进程/端口
- 工具注册在扩展加载期完成（`pi.registerTool` 可用；**不能调 `getAllTools` 等 action method**）

## 开发命令

```bash
npm install          # 安装依赖
npm run build        # 编译 src/sap-tools（tsc → dist/）
node cli.mjs chat    # 交互式对话
node cli.mjs web     # Web 版
node cli.mjs tools   # 工具列表
```

## 代码规范

- 工具代码（TS）：严格模式、NodeNext、无分号、双引号（见 tsconfig.json）
- CLI/服务端（mjs）：ESM，清晰注释
- 新增 SAP 工具：在 `src/sap-tools/tools/` 新建文件，导出 `{ name, title, description, inputSchema(zod), execute() }`，并在 `tools/index.ts` 注册
- 工具遵循"读优先、写需显式授权"：写操作必须标记 `write: true`

## 安全

- `connections.json`（SAP 凭据）与 `.pi/auth.json`（API Key）**已被 .gitignore 排除**，绝不提交
- 配置模板在 `config/*.example.json`
- 默认 `security.readOnly: true`，写操作需显式开启

## 提交

- 提交前 `npm run build` 确保编译通过
- 不提交：node_modules/、dist/、connections.json、.pi/auth.json、.pi/sessions/
- 提交信息简洁中文或英文均可
