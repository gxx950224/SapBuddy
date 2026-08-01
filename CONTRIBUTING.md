# Contributing to SapBuddy

感谢你愿意为 SapBuddy 贡献代码！请阅读以下指南，保持项目质量。

## 开发环境

- Node.js ≥ 20（推荐 22+）
- 一个可用的 SAP 系统（ADT 服务已激活）用于联调，非必需——大部分代码可用 `npm test` 离线验证

## 快速开始

```bash
git clone <你的 fork>
cd sapbuddy
npm install
npm run build      # 编译 src/sap-tools → dist/
npm test           # 冒烟测试（不连 SAP）
npm run doctor     # 环境自检
```

## 代码风格

- **TypeScript**（`src/sap-tools/`）：严格模式（`strict: true`）、NodeNext、无分号、双引号
- **JavaScript**（`cli.mjs` / `src/web/*.mjs`）：ESM、清晰注释
- 提交前跑 `npm run check`（tsc --noEmit）确保无类型错误

## 新增 SAP 工具

1. 在 `src/sap-tools/tools/` 新建文件，导出：
   ```ts
   export const myTool = {
     name: "my_tool_name",          // snake_case，全局唯一
     title: "My Tool",
     description: "...",             // 写清用法与避坑
     inputSchema: z.object({ ... }), // zod schema
     write: false,                   // 写操作必须 true
     async execute(args) { return "文本结果" }
   }
   ```
2. 在 `src/sap-tools/tools/index.ts` 注册
3. 写操作必须标记 `write: true`（会被安全守卫自动拦截非开发客户端）
4. 更新 README 工具数量与 `docs/TESTING.md` 回归矩阵

## 安全规则（重要）

- **绝不提交**：`connections.json`、`.pi/auth.json`、`.pi/sessions/`、任何真实凭据
- 写工具默认受「开发客户端守卫」约束（`T000.CCCATEGORY` 非开发类拒绝）
- 新配置模板放 `config/*.example.json`，凭据一律脱敏

## 提交信息

简洁中文或英文均可，建议格式：`类型: 简述`（fix / feat / chore / docs / refactor / test）

## 测试

- `npm test`：冒烟测试（工具加载、CLI、构建产物、配置模板）
- 涉及 SAP 联调的改动，请在 `docs/TESTING.md` 补充对应回归用例

## 发布流程（维护者）

1. 更新版本号（`npm version patch|minor|major`）
2. `git push && git push --tags`
3. GitHub Actions 自动构建测试，tag `v*` 触发 npm 发布
