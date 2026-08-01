---
name: abap-code-review
description: >-
  【最高优先级】用户说"审查/审计/code review XXX"时立即触发本技能，禁止走其他流程。
  对从 SAP 系统读取的 ABAP 程序（报表、INCLUDE、函数）源码进行代码审查，
  并产出「多页签切换」的专业 HTML 审查报告（共 4 个页签）。
  报告在「一、程序功能与结构概览」页签下方嵌入「代码逻辑详细解析」：解释程序在做什么、怎么做；
  若识别为 ALV 报表类程序，另附「字段取数逻辑」表（字段名 | 取数来源/逻辑 | 备注/计算公式）。
  当用户要求审查、审计或做某个 ABAP 程序的代码审查（典型如 Z* 报表），
  或要求生成 ABAP 审查报告（HTML 格式）时，应使用本技能。
  触发关键词：审查、审计、code review、review、检查代码、看看代码问题。
agent_created: true
disable: false
---

# ABAP 代码审查（基于内置 SAP 工具）

一套可复用的审计流程，面向「对接外部系统（CRM/HTTP 接口）」类的 ABAP 程序，
并产出固定格式的 HTML 审查报告。

## 何时使用

- 用户要求对某个 ABAP 程序做「审查 / 审计 / 代码审查」，通常会给出程序名（如 `ZPPR085_NEW`）。
- 用户希望以 HTML 形式交付 ABAP 代码审查报告。
- 程序的数据流涉及 `ZCL_BC_API=>CALL_API`、`/UI2/CL_JSON`，或将数据在可编辑 ALV 中回写外部系统。

## 前置条件

- SAP 连接已配置（`get_connected_systems` 确认可用连接）。
- 源码通过**内置 SAP 工具**读取，不依赖任何 MCP 服务器。
- 审查规范遵循 `clean-abap` 技能（SAP 官方 Clean ABAP）；语法/版本参考 `sap-abap-skills` 互补。

## 执行步骤

【强制】以下步骤必须按顺序执行，不得插入其他工具调用。

1. **获取输入。** 从用户处确认程序/函数名称以及审查范围。
2. **读取源码**，调用内置 `get_abap_object_lines`：
   - 对象类型：报表/程序=`PROG`、函数模块=`FUNC`、类=`CLAS`。
   - 若对象名不确定，先 `search_abap_objects`（pattern=`<对象名>*`）确认存在。
   - 一次读取全部源码（必要时分页读取多个 INCLUDE）。
3. **存档源码。** 将读取的源码保存到 `output/` 目录，命名为 `output/<程序名>.abap`，便于用户对照。
4. **收集关联对象。** 留意被 INCLUDE 的程序、配置表（`ZBCT_OUTF_CONFIG`）、
   结构（`ZCRMS_*`、`ZBCS_*`）等引用对象，可继续用内置工具读取或向用户索取。
5. **静态走查。** 自顶向下逐段核对 `references/checklist.md` 的每一项：
   选择屏幕 → `INITIALIZATION` → GET_DATA（接口调用 + JSON 反序列化 + 展平）
   → ALV 展示 → 可编辑处理 → 发送/更新命令。
   - **逻辑解析准备**：同时梳理「程序在做什么 / 怎么做」的脉络，作为「代码逻辑详细解析」子节（挂在「一、程序功能与结构概览」页签下方）的 `{{LOGIC_SECTION}}`。
   - **ALV 字段取数逻辑（仅 ALV 报表类程序）**：若程序输出为 ALV 报表，逐字段整理取数逻辑，
     一并写入 `{{LOGIC_SECTION}}`——格式为含 `<h3>ALV 字段取数逻辑</h3>` 与
     `<table>`（列：字段名 | 取数来源/逻辑 | 备注/计算公式）的整块 HTML；
     非 ALV 程序（函数 / 接口类）的 `{{LOGIC_SECTION}}` 仅含文字解析、不含取数表。
6. **问题定级。** 每条问题记录：`id`、严重度（高/中/低）、
   `位置`（FORM 或区域）、`现象`、`建议修复`。
   严重度配色：红=高，黄=中，蓝=低，绿=OK。
7. **生成 HTML 报告。** 将 `assets/report-template.html` 复制到 `output/` 目录，
   把每个 `{{TOKEN}}` 占位符替换为真实内容（保留现有 CSS，不要改样式），
   保存为 `output/<程序名或函数名>_CodeReview.html`。
   - 报告顶部元信息常驻；下方为「多页签」切换，**共 4 个页签**，章节顺序：
     **一、程序功能与结构概览（下方嵌入「代码逻辑详细解析」子节）→
     二、审查发现汇总 → 三、问题详解（内含 重点问题详解 / 中危问题 / 低危与改进建议 三个子节）→
     四、亮点与结论（内含 亮点 / 结论与修复优先级 两个子节）**。
   - 各页签占位符：`{{OVERVIEW_SECTION}}`（概览段落+列表）、`{{LOGIC_SECTION}}`（逻辑解析+ALV 取数表）、
     `{{SUMMARY_SECTION}}`（统计+汇总表）、`{{DETAIL_ITEMS}}`/`{{MEDIUM_ITEMS}}`/`{{LOW_ITEMS}}`（重点/中危/低危）、
     `{{POSITIVES}}`（亮点）、`{{CONCLUSION_SECTION}}`（结论表+脚注）。
   - 页签切换为纯原生 JS（模板自带 `showTab()`），无外部依赖，单文件可离线打开。
8. **交付结果。** 告知用户报告位置 `output/<程序名或函数名>_CodeReview.html`（Web 端产物面板可预览），并简要总结发现问题数量。

完整清单见 `references/checklist.md`，
交付模板见 `assets/report-template.html`。
