# SapBuddy 工具手册（42 个 SAP ABAP 工具）

所有工具通过 pi 扩展注册（CLI/Web 双端一致），可直接调用。
工具输出超 8KB/120 行自动截断（尾部提示），需要更多内容用 `lineCount`/`methodName`/精确 SQL 分页。
写工具（创建/编辑/激活）需用户确认：拦截后展示计划，用户输入「确认」放行（2 小时窗口）。

---

## 一、连接与系统

| 工具 | 用途 | 关键点 |
|---|---|---|
| `get_connected_systems` | 查看可用 SAP 连接 | **第一个动作**：不确定 connectionId 时先调用；返回写权限状态 |
| `get_sap_system_info` | 系统信息（SID/版本/客户端/语言） | 了解系统环境 |
| `adt_discovery_export` | ADT 服务发现 | 高级调试/API 探索用 |
| `abap_fs_documentation` | ABAP ADT 工具文档 | 工具使用参考 |

## 二、搜索与定位

| 工具 | 用途 | 关键点 |
|---|---|---|
| `search_abap_objects` | 按名称搜索对象 | **确认存在性用精确名（不带 \*）**；通配符仅用于找同类（如 `ZCL_*`）|
| `search_abap_object_lines` | 在对象源码内搜索文本（正则） | 定位方法（搜 `METHOD`）、找变量引用、错误行 |
| `find_where_used` | 引用分析（谁调用了它）| 影响面分析、删除前检查 |
| `get_object_by_uri` | 按 ADT URI 读对象 | 已有 URI 时直接用 |
| `get_abap_object_workspace_uri` | 获取工作区 URI | 写操作前定位 |
| `get_abap_object_url` | 获取 ADT 对象 URL | 定位/分享 |

## 三、读取源码

| 工具 | 用途 | 关键点 |
|---|---|---|
| `get_abap_object_lines` | 读对象源码 | 大对象用 `startLine`/`lineCount` 分页；类用 `methodName` 提取方法 |
| `get_batch_lines` | 一次读多个对象（并行）| 批量对比/学习多个对象时用 |
| `get_abap_object_info` | 对象元信息（URI/类型/状态）| 快速确认对象属性 |
| `get_version_history` | 版本历史/某版本源码/版本对比 | 代码回溯、变更审查 |

## 四、创建与编辑（写工具，需确认）

| 工具 | 用途 | 关键点 |
|---|---|---|
| `create_object_programmatically` | 创建对象 | **报表用 `PROG/P`**（不要 `PROG/I` include）；函数模块 `FUGR/FF` + parentName 函数组；DDIC：`TABL/DT`、`DTEL/DE`、`DOMA/DD` |
| `replace_string_in_abap_object` | 替换源码（唯一匹配）| 先用 `get_abap_object_lines` 确认内容；**硬编码中文/裸内置类型会被代码级拦截** |
| `abap_activate` | 激活对象 | 编辑流程最后一步 |
| `create_test_include` | 创建测试 include | ABAP Unit 测试 |
| `update_object_description` | 更新对象描述 | 保持描述同步 |

## 五、质量与诊断

| 工具 | 用途 | 关键点 |
|---|---|---|
| `get_abap_diagnostics` | 语法检查 | 编辑后必查（URI 用 replace 返回的 source/main）|
| `run_atc_analysis` | ATC 静态检查 | 代码质量门禁 |
| `get_atc_decorations` | ATC 结果详情 | 定位具体问题 |
| `run_unit_tests` | 执行 ABAP Unit 测试 | 修改后回归 |
| `analyze_abap_dumps` | ST22 转储分析 | 运行时崩溃诊断 |
| `analyze_abap_traces` | ST05 追踪分析 | SQL 性能问题 |

## 六、数据查询

| 工具 | 用途 | 关键点 |
|---|---|---|
| `execute_data_query` | 执行 SQL 查询（只读 SELECT/WITH）| `limit` 控制行数；大表先验证字段再查 |
| `get_abap_sql_syntax` | SQL 语法检查 | 写 SQL 前验证 |

## 七、DDIC 与文本

| 工具 | 用途 | 关键点 |
|---|---|---|
| `fix_ddic_text` | 补 DDIC 描述/标签语言（copy/set）| 数据元素/域的多语言文本 |
| `update_domain_properties` | 修改域属性 | 值域变更 |
| `manage_text_elements` | **读写文本元素（首选）** | update 前自动合并现有（旧条目保留）；symbols id 用 3 字符 `'001'`（对应 TEXT-001）；对象须为主程序（PROG/P）|
| `translate_text_pool` | 多语言文本池（copy/set）| 批量多语言场景；key：T=标题、I=符号(001)、S=选择文本 |

## 八、传输请求

| 工具 | 用途 | 关键点 |
|---|---|---|
| `manage_transport_requests` | 传输请求列表/创建/释放 | 交付前管理传输号 |

## 九、Mermaid 图表

| 工具 | 用途 | 关键点 |
|---|---|---|
| `create_mermaid_diagram` | 生成 Mermaid 代码 | 流程图/时序图/ER 图 |
| `validate_mermaid_syntax` | 校验语法 | 生成后必验 |
| `get_mermaid_documentation` | Mermaid 语法文档 | 复杂图参考 |
| `detect_mermaid_diagram_type` | 识别图类型 | 自动分类 |

## 十、ABAP 调试

| 工具 | 用途 |
|---|---|
| `abap_debug_session` | 创建/结束调试会话 |
| `abap_debug_breakpoint` | 设置/删除断点 |
| `abap_debug_step` | 单步执行 |
| `abap_debug_variable` | 读写变量 |
| `abap_debug_stack` | 调用栈 |
| `abap_debug_status` | 会话状态 |

---

## 常用组合流程

### 创建报表（最小步骤）
1. `search_abap_objects`（精确名）→ 确认不存在
2. 需求不明确 → **直接问用户**
3. 展示计划 → 用户「确认」
4. `create_object_programmatically`（PROG/P）→ `get_abap_object_lines` 读空壳
5. `replace_string_in_abap_object` 写源码 → `get_abap_diagnostics` 检查 → `abap_activate` 激活
6. `manage_text_elements` 写文本元素（TEXT-xxx/选择文本）

### 修改已有代码
1. `get_abap_object_lines`（或 `methodName`/`lineCount` 定位）
2. `replace_string_in_abap_object`（唯一匹配）
3. `get_abap_diagnostics` → `abap_activate`

### 代码审查
1. `get_abap_object_lines` 全量 + `run_atc_analysis`
2. `search_abap_object_lines` 定位问题行
3. 生成 `output/<对象>_CodeReview.html`（**需用户确认**）

### 数据诊断
- `execute_data_query`（SELECT 验证）→ `analyze_abap_traces`（ST05 性能）

---

## 铁律提示

- **先搜后建**：创建前精确搜索，已存在则告知用户换名
- **写前确认**：写工具被拦截时展示计划，用户输入「确认」放行
- **失败停手**：同一工具连续失败 3 次立即停手，向用户报告
- **源码归位**：生成的 ABAP 源码必须保存到 `output/`（.SapBuddy/output/）
