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
├─ 变量/方法定义在哪儿 → §1.4 find_code_definition
├─ 类的父类/子类  → §1.4 get_class_hierarchy
├─ 对象信息/激活状态 → §1.5 get_abap_object_info
├─ 某语句/方法用法文档 → §1.6 get_abap_documentation
├─ 直接读表内容   → §1.7 read_table_contents
├─ 创建程序/类    → §2（4 步流程）
├─ 修改代码       → §3（请求处理 + 替换）
├─ 激活           → §2.4 abap_activate
├─ 翻译文本池     → §4 translate_text_pool（TEXT-xxx/标题/选择文本）
├─ 翻译消息类     → §4.3 translate_message_class（SE91/T100）
├─ 翻译屏幕文字   → §4.4 translate_screen_text（D020T/D021T）
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
{ "pattern": "ZITS014A" }             // 不确定类型就不要传 types（多类型搜，事务码 TRAN 也能命中）
```
> 确认存在性永远用精确名；`types` 限定时传类型数组；**不确定对象类型时不要传 `types`**（限定 PROG 会漏掉事务码/函数组/类）；`maxResults` 默认 20。

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
> 返回调用方清单（含调用片段）。**先查知识库对象页的 `used_by`** 拿已整理的影响清单，再实测核实。

### 1.4 代码定位 / 类结构
```json
// 定位某行某个标识符（变量/方法/类）的定义处（先 get_abap_object_lines 拿行号，再传 line+token）
{ "objectName": "ZCL_X", "objectType": "CLAS", "line": 42, "token": "GET_DATA" }
// 类继承链：superTypes=true 查父类/接口，false 查子类
{ "objectName": "ZCL_X", "objectType": "CLAS", "superTypes": true }
```
> `find_code_definition` 需要行号 + 该行标识符文字；`get_class_hierarchy` 只需类名。两者都只读。

### 1.5 对象信息 / 激活状态
```json
{ "objectName": "ZCL_X", "objectType": "CLAS", "withStructure": true }
```
> `withStructure=true` 列出组件清单（类→组件/表→字段）。**报完成前用它核对激活状态**（active/inactive）。

### 1.6 ABAP 文档说明
```json
{ "objectName": "ZAIR004", "objectType": "PROG", "line": 15, "token": "CALL FUNCTION" }
```
> 给源码对象 + 行号 + 标识符，返回该元素（语句/方法/类/函数）的 ADT 官方说明，无需读全量源码。

### 1.7 直接读表内容
```json
{ "tableName": "T001", "rowLimit": 20 }
{ "tableName": "MARC", "filter": "WERKS = '1000' AND MATNR LIKE 'Z%'", "rowLimit": 50 }
```
> 只读，默认 50 行、最大 500。`filter` 是 WHERE 子句内容（不带 WHERE 关键字）。

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

### 4.3 消息类翻译（SE91 / T100）
```json
// copy：把源语言消息文本复制为目标语言（messageClass 可带 % 通配批量）
{ "messageClass": "ZFI%", "mode": "copy", "sourceLanguage": "E", "targetLanguage": "V" }
// set：按消息号直接写翻译文本
{ "messageClass": "ZBC_ITS001", "mode": "set", "targetLanguage": "V",
  "messages": [ { "msgNumber": "001", "text": "物料不存在" } ] }
```
> 只用于**消息类**（SE91 对象）；文本符号/屏幕文字别用错工具。消息号自动补 3 位（'1'/'01'→'001'）；`targetLanguage` 传语言键（VI 越南语由 T002 反查自动解析，传 `VI` 或「越南」）。set 前会自动校验消息号在 T100 存在，不存在报 NOMSG 并回滚；写入后自检读回核对，对不上回滚不落库。copy 模式通配批量仅限 Z*/Y* 开头的消息类。

### 4.4 屏幕文字翻译（D020T / D021T）
```json
// ① 先 list 拿 dynr（屏幕号）与 fldn（字段名）
{ "objectName": "ZITS004A", "mode": "list", "targetLanguage": "V" }
// ② 再 set 写字段文本与屏幕标题
{ "objectName": "ZITS004A", "mode": "set", "targetLanguage": "V",
  "fields": [ { "dynr": "0100", "fldn": "P_COMP", "text": "公司代码" } ],
  "titles": [ { "dynr": "0100", "text": "查询" } ] }
```
> 只用于**屏幕文字**（函数组 `SAPL` 前缀自动补，传 `ZITS004A` 或 `SAPLZITS004A` 均可）。list 返回值含 `PROG` 行与每屏标题/字段行；set 前校验屏幕/字段存在，不存在报 NOSCREEN/NOFIELD 并回滚。**直接写表，不自动挂传输请求**——屏幕（DYNP）对象需手工把请求号插进传输（同 SAPLZBCG014 经验）。language 传 `VI` 越南语。

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
> 仅 SELECT/WITH；禁止 INSERT/UPDATE/DELETE 等（会被拦截）；`limit` 默认 50 最大 1000。简单读表（不 join 不聚合）也可用 §1.7 `read_table_contents`。

### 6.1 高频标准表真实列名（防猜列名）

| 表 | 用途 | 关键列（注意大小写） |
|---|---|---|
| `tstc` | 事务码 → 程序 | **`PGMNA`（不是 PNAME）**、`TCODE`、`DYPNO`、`CINFO` |
| `tstct` | 事务码文本 | `TCODE`、`SPRSL`（语言）、`STEXT`（短文本） |
| `tfdir` | 函数模块 → 主程序 | **`PNAME`**、`FUNCNAME`、`INCLUDE` |

> 别搞混：**`tstc` 用 `PGMNA`、`tfdir` 用 `PNAME`**，两者相反。查表列名没把握时，先 `SELECT * FROM <表> LIMIT 1` 或 §1.7 `read_table_contents` 看真实列名，禁止猜。

---

## §7 代码审查（abap-code-review 技能）

流程：`get_abap_object_lines` 全量 → `run_atc_analysis` → `search_abap_object_lines` 定位 → 生成 HTML 报告（**需用户确认**）。

---

## §8 诊断（崩溃 / 性能）

```json
// ST22 崩溃转储（analyze_abap_dumps）
{ "action": "list_dumps", "maxResults": 10 }              // 列最近 dumps（dumpId 从结果复制）
{ "action": "analyze_dump", "dumpId": "20260802000000..." }  // 查单个 dump 详情

// ST05 性能追踪（analyze_abap_traces）
{ "action": "list_traces" }                               // 列当前用户的追踪请求
{ "action": "analyze_trace", "traceId": "..." }           // 命中列表（粗粒度）
{ "action": "statements", "traceId": "..." }              // SQL 语句明细（哪条慢）
{ "action": "db_access", "traceId": "..." }               // DB 表访问明细（哪张表慢，按耗时降序）
{ "action": "delete_trace", "traceId": "..." }            // 删除追踪
```

---

## §9 DDIC

```json
// 批量修 DDIC 文本（数据元素/域描述，copy 模式按 prefix 限定 Z*/Y* 范围）
{ "mode": "copy", "sourceLanguage": "1", "targetLanguage": "E", "prefix": "ZMM", "types": ["data_element", "domain"] }
// set 模式按对象名逐条写入
{ "mode": "set", "targetLanguage": "1", "types": ["data_element"],
  "texts": [ { "name": "ZE_AI004_DOCDATE", "text": "单据日期" } ] }
// 改域属性（仅 Z*/Y* 开头的二开域）
{ "domainName": "ZD_AI004_SCENARIO", "conversionExit": "ALPHA", "lowercase": true, "sign": false }
```
> `types` 取值 `data_element`（数据元素 DD04T）/ `domain`（域 DD01T），默认两个都处理；`fix_ddic_text` 写文本只允许 Z*/Y* 二开对象范围，`update_domain_properties` 只允许 Z*/Y* 二开域，标准对象只读不写。

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
