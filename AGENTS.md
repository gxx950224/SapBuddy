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
                    └── register.ts     ★ 注册适配 + 安全拦截（zod → TypeBox → pi.registerTool）
```

- **直接集成**：工具是纯函数模块，直接注册为 pi customTools，不依赖 MCP 框架
- 工具注册在扩展加载期完成（`pi.registerTool` 可用；**不能调 `getAllTools` 等 action method**）

## 安全拦截层（register.ts，★ 扩展层强制、CLI/Web 两端一致）

所有安全规则集中在 `register.ts`（编译产物 dist/sap-tools/register.js，CLI 与 Web 共用同一模块），不依赖 LLM 自觉：

```
工具调用（tool_call 事件）
   │
   ├─ ① installWriteGate（写拦截器）
   │    ├─ write/edit 写 .abap 非 output/  → 路径强制拦截
   │    ├─ write 写 *_CodeReview.html       → 审查报告需确认（TUI 弹窗 / Web 拦截提示）
   │    ├─ 写 SAP 工具（create/replace/activate/文本元素…）
   │    │     ├─ isWriteApproved()?         → 放行（授权窗口内）
   │    │     ├─ TUI/CLI：ctx.ui.confirm    → 原生弹窗
   │    │     └─ Web：block + 提示 AI 展示计划 → 用户手动输入「确认」
   │    └─ replace_string 额外：scanCodeViolations（硬编码中文/裸内置类型）
   │
   ├─ ② execute 层（每个工具）
   │    ├─ assertDevClient（T000.CCCATEGORY）→ 非开发客户端拒绝一切写
   │    └─ 工具输出截断（truncateHead 8KB/120 行）
   │
   └─ ③ handleUserMessage（before_agent_start 每轮）
        ├─ 确认词（确认/同意/可以…）→ 2h 授权窗口（同一需求不重复授权）
        ├─ 拒绝词（拒绝/不要/取消…）→ 清空授权
        └─ 中性/继续消息 → 窗口保持
```

**规则唯一出处**：`handleUserMessage`/`installWriteGate`/`scanCodeViolations` 都在 register.ts；
agent-core（Web）与 pi-extension（CLI）只做挂载调用，不重复实现 → 双端行为永远一致。

**其他安全**：
- `assertDevClient`：读 `T000.CCCATEGORY`（P=生产/T=测试/C=定制/D=演示/E=培训/S=SAP参考），默认只放行 C（定制/客户开发），无法确认 fail-closed
- 凭据隔离：`connections.json`/`.SapBuddy/auth.json` 不入库；连接凭据在内存，仅按 connectionId 取用

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
