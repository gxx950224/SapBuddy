# ABAP 代码审查通用清单

每次审查按以下维度逐条核对，记录：编号、严重度、位置（FORM/方法/区域）、现象、建议修复。
适用对象：所有 ABAP 程序（报表、INCLUDE、函数模块、类），尤其含外部接口（HTTP/CRM）调用、可编辑 ALV 回写、JSON 序列化场景的程序。
本清单为通用基线，不绑定某次具体审查结果；针对特定程序可临时增删条目。

## 1. 文档与规范
- [ ] 程序头（名称 / 创建者 / 申请者 / 概要）与变更记录是否填写完整。
- [ ] `MESSAGE-ID` 声明后是否在代码中使用消息类，而非硬编码字面量；同一消息是否重复多处以致难以维护。
- [ ] 命名规范：Z/Y 前缀、变量/类型/常量命名是否清晰自解释。
- [ ] 注释是否说明「为什么」（业务意图），而非复述「做了什么」。

## 2. 语法与版本兼容
- [ ] 内联声明 `DATA(...)` / `FINAL(...)` 是否被目标系统版本支持（7.40 SP08+；`FINAL` 需 7.50+）。
- [ ] 表表达式 `itab[...]`、构造运算符 `VALUE`/`NEW`/`CONV`/`COND`/`SWITCH`/`REDUCE`/`FILTER` 使用是否兼容目标版本。
- [ ] ABAP SQL 宿主变量 `@`、逗号分隔列表、SELECT 内 SQL 表达式需 7.40 SP05+。
- [ ] 避免使用已废弃写法：`TABLES` 语句、`MOVE...TO`、动态 `PERFORM`、云环境禁用的 `WRITE`/`DESCRIBE TABLE`/`sy-datum` 直接引用。
- [ ] 云/ steer 环境优先 released API（如 `xco_cp`），避免未发布对象。

## 3. ABAP SQL（开放性 SQL）
- [ ] 一律使用宿主变量 `@`，杜绝字符串拼接 SQL（防注入）。
- [ ] 避免在循环内 `SELECT`（应改用 `FOR ALL ENTRIES` / `JOIN` / 临时内表）。
- [ ] `FOR ALL ENTRIES` 前检查驱动内表非空，避免退化为全表扫描。
- [ ] 大结果集使用 `PACKAGE SIZE` / `UP TO n ROWS` 限流。
- [ ] `JOIN` 类型（INNER/LEFT/RIGHT）与 `ON` 条件完整正确。
- [ ] 聚合、`GROUP BY`、`HAVING` 逻辑正确；避免 `SELECT *`，只取所需字段。

## 4. 内表与数据结构
- [ ] 高频键值访问优先 `SORTED` / `HASHED` 表或辅助键。
- [ ] 循环内修改优先 `FIELD-SYMBOL` 而非工作区拷贝（性能与一致性）。
- [ ] 判存在用 `line_exists()` / `line_index()` 替代仅判 `READ TABLE` 的 `sy-subrc`。
- [ ] `MOVE-CORRESPONDING` 字段对齐正确；通用场景显式赋值更清晰更快。
- [ ] 表对表 `MOVE-CORRESPONDING` 要求行类型一致。

## 5. 外部接口 / HTTP / JSON（对接类程序重点）
- [ ] 反序列化前校验返回数据非空/格式；解析失败有 `TRY/CATCH` 兜底，避免 `CX_SY_*` 短 dump。
- [ ] URL 查询参数做 URL 编码（`CL_HTTP_UTILITY=>ESCAPE_URL`），防请求被破坏或参数注入。
- [ ] HTTP 状态码 / 通信异常有处理，且失败提示明确、非空白。
- [ ] 序列化 `PRETTY_NAME`（驼峰 / 下划线 / 用户格式）与对端约定一致。
- [ ] 视场景评估超时、重试、熔断等健壮性。

## 6. 数据处理与展平
- [ ] 嵌套 `LOOP` 中修改内表应使用 `MODIFY ... INDEX` / `TRANSPORTING`。
- [ ] 数值计算防除零（`CX_SY_ZERODIVIDE`）。
- [ ] 字符串转数字前校验格式（`CX_SY_CONVERSION_NO_NUMBER`）。
- [ ] 子串 / 偏移访问前校验长度（`CX_SY_RANGE_OUT_OF_BOUNDS`）。

## 7. 错误处理与异常
- [ ] 关键操作包 `TRY/CATCH`，捕获 `cx_root` 兜底，避免裸奔。
- [ ] 动态 `ASSIGN (lv_name)` 字段名非法会短 dump，需 `TRY/CATCH` 或先校验字段名合法性。
- [ ] 解引用引用变量 / 对象前做 `IS BOUND` 检查。
- [ ] 业务校验失败给出明确消息，不静默吞掉错误。

## 8. ALV 与用户交互
- [ ] 可编辑 ALV 单元格回写优先 `MODIFY ... TRANSPORTING (fieldname)`，避免脆弱的动态 `ASSIGN`。
- [ ] 事件类（如 `DATA_CHANGED`）必须实例化并 `SET HANDLER`，否则为死代码（常带 `##NEEDED` 抑制）。
- [ ] 下拉、复选框、选择框的字段名与内表结构一致。
- [ ] 刷新使用 `IS_STABLE` 避免光标跳变。
- [ ] 用户命令（`USER_COMMAND`）对未选行给出提示而非 dump。

## 9. 授权与安全
- [ ] 敏感操作 / 数据读写字前 `AUTHORITY-CHECK`（事务码、业务对象权限）。
- [ ] SQL 注入：一律宿主变量，禁止拼接。
- [ ] 凭据（token / secret / key / 账号）不在配置表明文存储；评估加密与权限收敛。
- [ ] 对外回写 / 发送前确认权限与可追溯性。

## 10. 性能
- [ ] 避免循环内数据库访问。
- [ ] 内表访问选对表类型（SORTED / HASHED）。
- [ ] 大批量 `MODIFY` / `INSERT` 用内表整批而非单条。
- [ ] 避免重复 `SORT` / 重复查询。
- [ ] 大结果集用 `PACKAGE SIZE` 流式处理。

## 11. 代码质量与可维护性
- [ ] 无死代码：未实例化类、未调用 FORM、`##NEEDED`/`##CALLED` 抑制项。
- [ ] 无未使用变量；`FORM` 内不重复定义 `TYPES`。
- [ ] 模块化：过长 `FORM` 拆分；新需求优先 OO 方法而非过程式堆叠。
- [ ] 消息统一用消息类，避免字面量。
- [ ] 常量抽取到 `INCLUDE` / 接口，避免魔法值散落。

## 12. 亮点记录
- [ ] 记录值得保留的设计：统一常量 INCLUDE、合理 ALV 交互、宿主变量防注入、公共能力复用等。

## 严重度定义
| 级别 | 含义 | 处理 |
|------|------|------|
| 高 / 高需核实 | 导致功能完全失效、数据丢失或致命误判 | 投产前必须处理（P0） |
| 中 | 健壮性 / 安全 / 可维护性缺口 | 尽快（P1） |
| 低 | 整洁度、规范、非缺陷改进 | 择机（P2） |
