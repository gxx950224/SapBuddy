# SapBuddy 工具使用手册（知识图谱版）

按 **场景 → 工具 → 传参示例** 组织。LLM 用工具前先查本手册对应场景。
所有工具参数均用 JSON 传参。写工具需人工确认（用户输入"确认"放行）。

---

## 场景导航（决策树）

```
用户需求
├─ 查对象是否存在 → §1.1 search_abap_objects
├─ 读源码/看逻辑  → §1.2 get_abap_object_lines
├─ 谁调用了我     → §1.3 find_where_used
├─ 创建程序/类    → §2（4 步流程）
├─ 修改代码       → §3（请求处理 + 替换）
├─ 激活           → §2.4 abap_activate
├─ 翻译/多语言    → §4 translate_text_pool
├─ 写文本元素     → §5 manage_text_elements
├─ 数据查询       → §6 execute_data_query
├─ 代码审查       → §7（技能流程）
├─ 性能/崩溃诊断  → §8 analyze_abap_traces/dumps
├─ DDIC 文本/域   → §9 fix_ddic_text / update_domain_properties
├─ 发布/传输请求  → §10 manage_transport_requests
├─ 画图           → §11 create_mermaid_diagram
└─ 单元测试/ATC   → §12 run_unit_tests / run_atc_analysis
```

---

## §1 查询与了解

### 1.1 对象是否存在（精确查）
```json
{ "pattern": "ZAIR004" }              // 精确名，不带 *（模糊搜 ZAIR* 会浪费大量请求）
```
> 确认存在性永远用精确名；`types` 限定时传类型数组；`maxResults` 默认 20。

### 1.2 读源码（大对象分页 / 类提取方法）
```json
{ "objectName": "ZAIR004", "objectType": "PROG" }                    // 全量
{ "objectName": "ZCL_X", "objectType": "CLAS", "methodName": "GET_DATA" }  // 只提取某方法
{ "objectName": "ZAIR004", "objectType": "PROG", "startLine": 100, "lineCount": 50 }  // 分页
```
> 大对象（>200 行）**必须分页**（startLine/lineCount），不要全量拉；工具结果超过 8KB/120 行会截断。

### 1.3 引用分析（谁调用）
```json
{ "objectName": "ZCL_X", "objectType": "CLAS" }
```

---

## §2 创建程序/类/函数（写，需确认）

> **创建前必须收集**：包名（非 $TMP）、对象名、描述、传输请求描述/请求号。报表用 `PROG/P`。

### 2.1 创建对象
```json
{ "objectType": "PROG/P", "name": "ZAIR011", "description": "公司代码查询", "packageName": "ZAI" }
```
> 类型：`CLAS/OC`(类) `INTF/OI`(接口) `PROG/P`(报表) `TABL/DT`(表) `DTEL/DE`(数据元素) `DOMA/DD`(域) `DEVC/K`(包) `FUGR/FF`(函数模块+parentName 函数组)

### 2.2 写入代码（唯一匹配替换）
```json
{ "fileUri": "/sap/bc/adt/programs/programs/zair011", "oldString": "REPORT ZAIR011.", "newString": "REPORT ZAIR011.\n...", "requestText": "AI 创建 ZAIR011" }
```
> `oldString` 必须**唯一匹配**（不唯一先读源码确认，加 3-5 行上下文）；`fileUri` 用 ADT 对象 URI（`/sap/bc/adt/programs/programs/xxx`）；对象无未释放请求时自动建请求（`requestText` 作描述）。

### 2.3 语法检查 → 激活
```json
{ "fileUri": "/sap/bc/adt/programs/programs/zair011/source/main" }   // 语法检查
{ "objectName": "ZAIR011", "objectType": "PROG" }                    // 激活
```

---

## §3 修改已有代码

> **先查请求**：对象有未释放请求直接沿用；无则用户提供请求描述（工具自动建请求）。

```json
// ① 读当前源码（确认 oldString）
{ "objectName": "ZAIR004", "objectType": "PROG", "startLine": 100, "lineCount": 50 }
// ② 查未释放请求
{ "action": "get_object_transport", "objectName": "ZAIR004" }
// ③ 替换（无未释放请求时自动建请求）
{ "fileUri": "/sap/bc/adt/programs/programs/zair004", "oldString": "旧文本(唯一)", "newString": "新文本", "requestText": "修改原因" }
// ④ 语法检查 + 激活
```

---

## §4 翻译 / 多语言（文本池）

### 4.1 整池复制（copy）
```json
{ "objectName": "ZAIR004", "mode": "copy", "sourceLanguage": "1", "targetLanguage": "E" }
```
> 把中文文本池整体复制为英文；语言键：`1`=中文、`E`=英文；其他语言用户指定。

### 4.2 按 key 写条目（set）
```json
{ "objectName": "ZAIR004", "mode": "set", "targetLanguage": "1",
  "texts": [ { "key": "001", "text": "物料不存在" }, { "key": "T", "text": "程序标题" } ] }
```
> key：`T`=程序标题、`I`/数字=文本符号（`001` 对应 TEXT-001）、`S`=选择文本（P_COMP）。

---

## §5 文本元素（manage_text_elements）

```json
// 读
{ "action": "read", "objectName": "ZAIR004", "objectType": "PROG" }
// 写（自动合并现有，不会覆盖旧条目）
{ "action": "update", "objectName": "ZAIR004", "objectType": "PROG", "category": "symbols",
  "elements": [ { "id": "001", "text": "场景选择" } ] }
```
> `category`：symbols（TEXT-xxx）/ selections（选择文本，id=参数名）/ headings；symbols 的 id 用 3 字符 `'001'`；对象必须是主程序（PROG/P）。

---

## §6 数据查询

```json
{ "sqlQuery": "SELECT BUKRS, BUTXT FROM T001 WHERE BUKRS = '1000'", "limit": 50 }
```
> 仅 SELECT/WITH；禁止 INSERT/UPDATE/DELETE 等（会被拦截）；`limit` 默认 50 最大 1000。

---

## §7 代码审查（abap-code-review 技能）

流程：`get_abap_object_lines` 全量 → `run_atc_analysis` → `search_abap_object_lines` 定位 → 生成 HTML 报告（**需用户确认**）。

---

## §8 诊断（崩溃 / 性能）

```json
// ST22 崩溃转储
{ "action": "list", "maxResults": 10 }                    // 列最近 dumps
{ "action": "get", "dumpId": "20260802000000" }           // 查单个
// ST05 性能追踪
{ "action": "list" }                                      // 列追踪请求
{ "action": "get", "traceId": "..." }                     // 查命中明细
```

---

## §9 DDIC

```json
// 批量修 DDIC 文本（数据元素/域描述，copy 模式按 prefix）
{ "mode": "copy", "sourceLanguage": "1", "targetLanguage": "E", "prefix": "ZMM", "types": ["DTEL", "DOMA"] }
// 改域属性
{ "domainName": "ZMATNR", "conversionExit": "MATN1", "lowercase": true }
```

---

## §10 传输请求（发布）

```json
// 查用户请求
{ "action": "list_user_transports" }
// 查详情（对象列表）
{ "action": "get_transport_details", "transportNumber": "DS4K940228" }
// 查对象所在请求
{ "action": "get_object_transport", "objectName": "ZAIR004" }
// 改描述（未释放请求）
{ "action": "update_description", "transportNumber": "DS4K940228", "description": "ai test" }
// 释放（自动先释放任务）
{ "action": "release", "transportNumber": "DS4K940228" }
```

---

## §11 Mermaid 图

```json
{ "diagramType": "flowchart", "title": "流程", "direction": "TD",
  "nodes": [ {"id": "A", "label": "开始"}, {"id": "B", "label": "处理"} ],
  "edges": [ {"from": "A", "to": "B"} ] }
```

---

## §12 质量

```json
// 单元测试
{ "objectName": "ZCL_X", "objectType": "CLAS" }
// ATC 静态检查
{ "objectName": "ZCL_X", "objectType": "CLAS", "maxResults": 50 }
```

---

## 通用铁律

1. **精确搜索**：查重用精确名（不带 `*`）
2. **分页**：大对象用 startLine/lineCount/methodName
3. **oldString 唯一**：替换前先读源码确认匹配
4. **请求**：修改/创建先确认请求（有沿用、无自动建）
5. **确认**：写工具被拦 → 展示计划 → 用户"确认"放行
6. **失败停手**：同一工具连续失败 3 次停手报告
7. **源码归位**：生成文件存 `output/<程序名>/`（不平铺）
