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
   ├─ ② execute 层（每个写工具）
   │    └─ assertDevClient（T000.CCCATEGORY）→ 非开发客户端拒绝一切写
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


### 强制规则 → 代码位置映射

| 规则 | 位置 | 层 |
|---|---|---|
| 写工具名单 / 授权窗口 / 只读模式 | `src/sap-tools/register.ts`（isWriteTool/handleUserMessage/isReadOnly）| 硬强制 |
| 写操作拦截（确认/路径/HTML 确认/查询放行）| `register.ts` `installWriteGate`（挂 pi.on("tool_call")）| 硬强制 |
| 敏感配置禁止 AI 读写（connections/auth/settings/models/mcp）| `register.ts` `installWriteGate`（read/glob/grep 拦读取、write/edit 拦写入，防泄露密钥/放开只读绕过总闸）| 硬强制 |
| SapBuddy 自身源码/规则文件禁止 AI 读写（src/、cli.mjs、test/、AGENTS.md、SYSTEM.md 等）| `register.ts` `installWriteGate`（保留 Memory.md、.SapBuddy/skills、output/ 可编辑区）| 硬强制 |
| 代码规则扫描（硬编码中文/裸类型 d/t）| `register.ts` `scanCodeViolations` | 硬强制 |
| 开发客户端守卫（T000 类别）| `src/sap-tools/adtManager.ts` `assertDevClient` | 硬强制 |
| 创建：包名/描述必填、禁 $TMP、requestText 建请求 | `tools/writeTools.ts` create_object_programmatically | 硬强制 |
| 修改：自动沿用/创建请求、请求描述格式 | `tools/writeTools.ts` replace_string_in_abap_object | 硬强制 |
| 传输请求：状态码中文、底表 E070/E071、只读放行 | `tools/transportText.ts` manage_transport_requests | 硬强制 |
| 创建/修改流程、避坑记录、请求描述格式（行为层）| `SYSTEM.md` 铁律 6b / 输出约定 | 提示层（AI 执行，工具已兜底）|

**编译产物** `dist/sap-tools/register.js` —— Web（agent-core）与 CLI（pi-extension）加载同一模块，规则两端一致。

## 安全

- `connections.json`（SAP 凭据）与 `.SapBuddy/auth.json`（API Key）**已被 .gitignore 排除**，绝不提交
- 配置模板在 `config/*.example.json`
- **默认只读**：connections.json 未显式设置 `security.readOnly: false` 即视为只读（所有写工具拒绝）；要允许写操作需在 connections.json 显式 `"security": { "readOnly": false }`
- 写操作另有双层保护：**人工确认**（拦截 → 用户输入"确认"放行）+ **开发客户端守卫**（T000.CCCATEGORY 非 C 类拒绝）

## 提交

- 提交前 `npm run build` 确保编译通过
- 不提交：node_modules/、dist/、connections.json、.pi/（旧版目录）、.SapBuddy/ 下个人配置（auth/connections/settings/sessions/output/mcp/memory 等）
- `.SapBuddy/skills/`、`.SapBuddy/models.json` 为默认内容**随仓库跟踪**（供安装包分发）
- 提交信息简洁中文或英文均可
