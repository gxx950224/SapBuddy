---
name: sap-fs
description: >-
  编写 SAP 功能规格书（FS / 功能设计书）。仅在用户明确要求写/改 FS、功能设计书、
  接口设计、报表设计、增强设计，或明确说按 sap-fs 出可交付规格文档时触发。
  日常问答、配置咨询、解释程序、代码审查、写 ABAP 不触发；意图不明时先问是否出 FS。
  确认后：识别需求类型 → 系统取证 → 用 grilling 追问业务决策 → 按模板生成 FS。
  触发关键词：写FS、功能规格、功能设计书、接口设计、报表设计、增强设计、出一份FS。
agent_created: true
disable: false
---

# sap-fs — 写 SAP 功能规格书

> 草稿结构（Codex 第一版目录）。模板在 `assets/templates/`，过程规范在 `references/`。
> 追问逻辑不内嵌：读取 `~/.SapBuddy/skills/grilling/SKILL.md`。上游许可与钉选说明见该文件顶部注释。

## 何时使用

- 用户**明确**要写 / 改 FS、功能设计书、接口 / 报表 / 增强**规格文档**，或明确说按 sap-fs 出可交付文档。
- 用户确认「要出 FS」之后（见 SYSTEM 铁律 FS 意图门禁）。

不触发：日常问答、配置怎么配、表/事务码解释、程序解释（`abap-explain` / `abap-wiki`）、代码审查（`abap-code-review`）、写 ABAP（`dev-write` / `abap-templates`）。
意图不明（只抛业务描述 / 方案讨论、未说要出 FS）：**先问一句**是否要按 sap-fs 产出 `FS.md` + `FS.html`（接口另附 JSON）；未确认前不套模板、不落盘 `~/.SapBuddy/output/fs/`。

## 资源地图（按需加载，勿一次全读）

| 时机 | 读什么 |
| --- | --- |
| 触发后立刻 | 本文件 + `references/fs-contract.md` |
| 需要连系统 | `references/system-verification.md` |
| 需要追问 | `references/grilling-integration.md`，并 **读取** `~/.SapBuddy/skills/grilling/SKILL.md`（含 “grill me” 类触发；直接读文件，没有单独的技能加载工具） |
| 已判定类型 | `references/types/<type>.md` + `assets/templates/fs-base.md` + `assets/templates/<type>.md` |
| 对齐详略 | `references/example-enhancement.md`（仅增强类样例） |
| 交付前 | `references/review-checklist.md` |
| 出归档 HTML / 接口 JSON | `references/archive-html.md` + `assets/templates/fs-archive.html` |

类型文件名：`interface` / `query-report` / `functional-report` / `enhancement`。

## 工作流程

1. **判类型**（混合取主导；ALV 按钮会改业务状态 → 功能报表）。读对应 `types/` 与模板。
2. **整理已知**：用户已说内容分到需求 / 现状 / 规则，先不提问。
3. **取证**：按 `system-verification.md` 只查能查的。
4. **追问**：按 `grilling-integration.md` 读取并执行 `grilling`，只问业务决策。
5. **生成**：拼装 `fs-base` + 类型专项模板；规则 / 验收 / 待确认 / 附录按 `fs-contract.md`。
6. **自检**：`review-checklist.md` 通过后再交付。

## 拼装

```
assets/templates/fs-base.md     # 第1、2、4、5、6、7节 + 附录A
  + assets/templates/<type>.md  # 第3节
  + 头部状态行
= 一份完整 FS
```

默认落盘目录（用户未指定时）：`~/.SapBuddy/output/fs/<需求名>/`（Web 产物树与写路径规则只认该目录）；详见下方交付物。

## 交付物（Markdown + HTML，接口另附 JSON）

同一需求目录默认：`~/.SapBuddy/output/fs/<需求名>/`

1. `FS.md` — 协作 / AI 主规格。
2. `FS.html` — 企业归档：套 `assets/templates/fs-archive.html`，规则见 `references/archive-html.md`。
3. **禁止 logo**（徽标、水印、品牌图都不放）。
4. **接口类**另出：正文 3.6 样例 JSON + 同目录 `io-request.json` / `io-response.json`（及必要的回调文件）。

先定稿 Markdown，再渲染 HTML / 写出 JSON；自检通过后一并交付路径。

## 硬边界

- 本技能流程**只读 SAP**；FS 确认 ≠ 写入许可。
- 正文只写事实与决定；训诫与生成纪律留在技能文件，不进 FS。
- 不虚构表名 / 字段 / 增强点 / 签署与测试结果。
- HTML 归档不使用任何 logo。
