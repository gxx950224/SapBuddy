# sap-fs 行为评测场景

> SapBuddy：技能在 `defaults/skills/`（`syncDefaultSkills` 补发到 `~/.SapBuddy/skills`）。交付物默认 `~/.SapBuddy/output/fs/<需求名>/`。没有 DSH 的 Skill 工具；追问时读取 `grilling/SKILL.md`。

判定看四件事：是否读对应类型片段、每条 R 能否判真假、每条 E 是否写限制、有无残留槽位。

## 正例（四类各一）

| ID | 输入摘要 | 期望类型 | 期望 |
| --- | --- | --- | --- |
| P1 | 与外部 WMS 同步交货 | interface | 读 interface 模板；成功层次分清；有增量/重复策略 |
| P2 | 采购订单查询清单导出 | query-report | 只读；有粒度与实现方式取舍 |
| P3 | 批量过账收货 | functional-report | 执行单元/部分成功/结果未知；3.2 有字段 |
| P4 | 保存采购订单时校验交期 | enhancement | 第2/3节分工；可对照 example-enhancement 详略 |

## 反例

| ID | 输入 | 期望行为 |
| --- | --- | --- |
| N1 | 「做个报表」 | 先追问粒度与用途，不直接开写完整 FS |
| N2 | 接口 + 增强混合 | 主导类型一份文档，另一行为补小节，不拆两份 |
| N3 | 查的表不存在 | 附录记失败/零行，正文 Q，不编表名 |
| N4 | 用户连说三次「不知道」 | 全部转 Q，继续不依赖部分，不替用户补值 |
| N5 | 中途改需求 | 只改受影响处；状态行 Q 数与实际一致 |

## 加载依赖

| ID | 检查 |
| --- | --- |
| L1 | `defaults/skills` 可发现 `sap-fs`、`grilling` |
| L2 | 生成时能解析 `assets/templates/*` 与 `references/*` 相对路径 |
| L3 | 追问阶段读取 `~/.SapBuddy/skills/grilling/SKILL.md`（含 grill me；读不到则按合同降级并说明） |

## 归档交付

| ID | 检查 |
| --- | --- |
| A1 | 每份 FS 同时有 `FS.md` 与无 logo 的 `FS.html` |
| A2 | 接口类另有可解析的 `io-request.json` / `io-response.json`，与正文 3.6 一致 |
