---
name: dev-write
description: >-
  编写/修改 ABAP 对象时必须遵循的项目规范：命名（匈牙利前缀）、编码规范（Clean ABAP）、
  函数模块（FUGR/FF）写入、结构（TABL/DS）写入、函数组 include（FUGR/I）写入、
  禁止硬编码中文、文本元素写法。用户要求创建/新建/修改/编写/重构 ABAP 代码、
  函数模块、表/结构、函数组 include、写 FORM、激活对象、写消息类/文本元素时触发本技能。
  触发关键词：创建/新建/修改/写代码/写函数模块/建表/建结构/函数组/FORM/消息类/
  文本元素/激活/匈牙利前缀/编码规范/硬编码中文。
disable: false
---

# 开发写入规范（dev-write）

> 本技能为项目**编码与写入规范**的唯一权威（从 SYSTEM.md 迁出）。写代码/写 SAP 对象前必须先遵循本技能。
> 相关：代码**风格/质量审查**见 `clean-abap` 技能；批量**翻译**见 `translate-workflow` 技能。

## 禁止硬编码中文提示（强制）

- 代码内不允许出现硬编码中文文案（提示/错误/说明文字）。
- 面向用户的提示/错误 → **消息类**（`MESSAGE e001(zmsg) WITH ...`；`MESSAGE ... INTO DATA(lv_msg)` 供 BAPIRET2 等返回）。
- 选择屏幕标签/块标题/ALV 列文本 → **文本元素**（`TEXT-001`、Selection Text）。**新增/修改文本元素用 `manage_text_elements`**（写入自动把程序对象 `R3TR PROG`（含文本池）挂载进传输请求）；翻译成其它语言用 `translate_text_pool`（文本池随程序对象 `R3TR PROG` 传输，写前请确认程序已在可修改请求里）。
- 找不到合适消息类/文本元素时，创建 Z 消息类（`create_object_programmatically` MSAG/N）或维护文本元素。
- 技术性注释可用中文（注释非运行时文案），但用户可见文案必须走消息类/文本元素（此"禁硬编码中文"指**代码里**的文案，非文本元素的中文翻译）。

## 编码规范（默认：SAP 官方 Clean ABAP）

**默认开发规范采用 SAP 官方 Clean ABAP 风格指南**（Clean Code for ABAP，源自 Robert C. Martin《Clean Code》），技能见 `~/.SapBuddy/skills/clean-abap/`（含 4300+ 行中文指南 `references/CleanABAP_zh.md`）。

核心规则（默认生效）：

- **命名（保留匈牙利前缀，企业通行惯例）**：
  - 局部变量：`lv_`（基础类型）、`ls_`（结构/行）、`lt_`（内表）；`mv_` 实例属性、`gv_`/`gs_`/`gt_` 全局、`cv_`/`cs_`/`ct_` 常量。
  - 方法/函数模块接口参数：`iv_`/`ev_`/`et_`/`es_`/`is_`/`it_`/`cv_`/`ct_`（SAP 通行惯例）。
  - 命名仍要描述性、自解释：`lv_matnr` 而非 `lv_x`；`lt_items` 而非 `lt_data1`；`ls_fieldcat`/`lt_fieldcat` 等。
  - **覆盖说明**：本项目**保留匈牙利前缀**，替代 Clean ABAP 的"无前缀"命名建议；
    Clean ABAP 其余规范（方法短小、OO 优先、错误处理、SQL 规范、注释、单测等）仍然适用。
- **方法**：短小单一职责；3 个以内导入参数；超过 3 个用结构；不写超长方法。
- **数据声明**：尽量使用 `DATA(...)` 行内声明；`SELECT` 显式字段列表（禁止 `SELECT *`）；禁止未检查的 `FOR ALL ENTRIES`。
- **字段类型（强制，分两类）**：
  - **自建表/结构字段必须用 DDIC 类型**：`TYPES` 定义的结构/表类型字段、DDIC 表/结构（`define structure/table`）字段，禁止内置基本类型（`c`/`n`/`i`/`p`/`string`/`xstring`/`char1` 等裸类型）。
  - 优先使用**标准数据元素**（如 `matnr`、`bukrs`、`dmbtr`、`menge_d`、`datum`、`abap_bool`、`sy-*` 对应元素）。
  - 找不到合适标准元素时：**创建 Z 数据元素 + 域**（DDIC 工具：`create_object_programmatically` DTEL/DOMA），域定取值范围/长度，数据元素定业务语义（`get_sap_system_info` 可查类型清单）。
  - 结构字段唯一裸写例外：客户端键（`abap.clnt`/`abap.cust`）。
  - **程序内局部变量/临时量允许裸类型**：`DATA` 变量、方法/函数参数、循环索引等可用 `string`/`i`/`char10`，不必为中间量建数据元素。
  - 内表行类型优先用 DDIC 结构（如 `lvc_s_fcat`、自定义 `Z*_S_*`）。
- **错误处理**：用异常（`RAISE EXCEPTION`）而非返回码；异常语义化命名；`CATCH` 只捕可处理异常。
- **对象**：优先面向对象；函数模块/报表逐步迁移为类与方法；`IF_OO_*` 接口解耦。
- **注释**：解释「为什么」而非「做什么」；代码自解释，注释不冗余。
- **单元测试**：ABAP 单元测试（`cl_abap_unit_assert`）覆盖关键逻辑。
- **模板程序结构（TOP/CLS/IMP 拆分，强制）**：创建拆 INCLUDE 的可执行报表时：
  - 本地类**定义+实现必须在同一个 INCLUDE**（如 `*_CLS` 同时含 DEFINITION 与 IMPLEMENTATION），不能拆两个 INCLUDE（否则激活报 "CLASS ... DEFINITION does not have a IMPLEMENTATION statement"）。
  - 主程序**薄壳化**：只留 `REPORT` + INCLUDE 语句；`DATA`/事件块/屏幕 MODULE 全部放实现 INCLUDE（如 `*_IMP`）——避免主程序引用未激活 INCLUDE 类型造成激活死循环（$TMP 新建 INCLUDE 场景）；激活方式：**只激活主程序（PROG/P）**，`abap_activate` 会自动读主程序源码枚举其全部 INCLUDE，先批量激活全部 INCLUDE、再单独激活主程序（两步），使整套一致编译。**禁止单独激活 INCLUDE**（PROG/I 无法独立编译，单独激活会对着兄弟 INCLUDE 的旧版本编译，必报 "类型/字段 unknown"——属工具已兜底的正常现象，直接激活主程序即可）。
  - 本地类方法内 **MESSAGE 不用 WITH 子句**（`MESSAGE TEXT-xxx TYPE 'S'`），否则报 "'.' expected after 'S'"。
- **Mermaid 图规范（生成时必须遵守）**：
  - 节点文本含中文、空格、括号、特殊符号（`→` `/` `+` 等）时**必须用双引号包裹**：`A["入口 IS_DATA (抬头+行项目)"]`、`D{"判断 TCODE"}`。
  - 边标签含中文用引号：`A -->|"调用接口"| B`。
  - 节点间用清晰方向；图首行声明类型（`flowchart TD` / `sequenceDiagram` 等）。
  - 生成后用 `validate_mermaid_syntax` 校验；渲染失败时检查引号。

写作/重构/审查代码时遇到规则歧义，先查 `clean-abap` 技能的 `CleanABAP_zh.md`；
英文原版：https://github.com/SAP/styleguides/blob/main/clean-abap/CleanABAP.md

## 函数模块写入规范（FUGR/FF，强制）

> 创建/修改函数模块按此规范，直接复制下面的完整模板，**不要让大模型临场设计模板结构**。

- **对象**：函数组（FUGR）与函数模块（FF）是两个对象。先 `create_object_programmatically`（objectType=FUGR）建函数组，再建函数模块（objectType=FF + parentName=<函数组名>）。
- **写源码用 fullSource 一步写入**：`replace_string_in_abap_object` 传 **fullSource=完整源码**（FUNCTION 行 + 参数段 + 独立 . + 函数体 + ENDFUNCTION.）。**不要**先读模板、不要构造 oldString、不要数模板空行——服务器自动提取参数进接口（SE37），工具自动做多项修正。
- **FUNCTION 行不带句点**：`FUNCTION ZFM_X` 后直接换行写参数段；写成 `FUNCTION ZFM_X.` 会残留模板头、参数区提前结束（工具自动移除句点，但请勿再写）。
- **参数用真实声明，禁止用 `*"` 注释**：`*"  IMPORTING VALUE(...)` 不会被提取进接口（工具拦截）。按模板写真实声明。
- **返回表用 TABLES 段 + LIKE**：`TABLES ET_MARC LIKE MARC`（函数体 `INTO TABLE @ET_MARC`）；**禁止** `TYPE STANDARD TABLE OF <表>`（SAP 报 Parameter OF declares no type）。
- **⚠️ Open SQL 里接口参数必须带 `@`**：`WHERE WERKS = @IV_WERKS`、`INTO TABLE @ET_MARD`——不带 @ 报 "must be escaped using @"（工具自动补 @，但请规范书写）。
- **TYPE 后可以是数据元素/表类型，也可以是表/结构**：`TYPE MARC`、`TYPE ZAIG_TEST02_S` 引用该结构/表本身（合法）。只有本意是传**单个字段值**时才必须用数据元素：工厂字段用 `WERKS_D`（不是 `WERKS`，WERKS 是 INTTAB 结构）、物料 `MATNR`。结构/表参数 `TYPE` 与 `LIKE` 都合法。拿不准先 `search_abap_objects` 确认。
- **激活**：函数组激活**不连带**函数模块——`abap_activate(objectName=<函数模块名>, objectType=FUGR/FF)` 单独激活函数模块；工具会自动先激活函数组的 FORM include（把未激活的 FORM 固化）→ 再激活主程序（SAPL<fg>，让新增 INCLUDE 生效）→ 最后激活函数模块，AI 无需手动排。
- **函数模块内不要定义 FORM**（报 DATA is unexpected）。

完整模板（真机验证可激活）：

```
FUNCTION ZFM_MARD
  IMPORTING
    VALUE(IV_WERKS) TYPE WERKS_D
    VALUE(IV_MATNR) TYPE MATNR
  TABLES
    ET_MARD LIKE MARD.

  SELECT *
    FROM MARD
    WHERE WERKS = @IV_WERKS
      AND MATNR = @IV_MATNR
    INTO TABLE @ET_MARD.
  IF SY-SUBRC <> 0.
    CLEAR ET_MARD.
  ENDIF.

ENDFUNCTION.
```

## 调用报表取数（SUBMIT + 后台捕获 ALV，强制）

> 用户要求"调用报表 XXX 取数 / SUBMIT XXX with 参数 and return"时，直接按此模式写，**不要让大模型临场设计、不要反复深挖被调报表源码**。

- **核心机制（真机验证，参考函数模块 Z_CRM_FI030）**：多数报表**没有** EXPORT TO MEMORY 导出机制，直接 SUBMIT 拿不到数据。正确姿势是**后台捕获 ALV 显示数据**：
  1. `CL_SALV_BS_RUNTIME_INFO=>SET( EXPORTING DISPLAY = ABAP_FALSE METADATA = ABAP_FALSE DATA = ABAP_TRUE )` —— 设置后台运行、禁止 ALV 显示
  2. `SUBMIT <报表> WITH <参数> AND RETURN.` —— 普通参数用 `WITH <param> = <值>`；选择条件用 `WITH <selopt> IN <变量>`
  3. `CL_SALV_BS_RUNTIME_INFO=>GET_DATA_REF( IMPORTING R_DATA = <数据引用> )` —— 取数据引用，`ASSIGN <数据引用>->* TO <字段符号>` 后 LOOP 处理（用 MOVE-CORRESPONDING 映射到目标结构）
  4. 最后 `CL_SALV_BS_RUNTIME_INFO=>CLEAR_ALL( )` 清理，避免影响后续 ALV
  - 该机制对函数式 ALV（REUSE_ALV_GRID_DISPLAY_LVC）和 OO ALV（cl_salv_table）**都能捕获**（Z_CRM_FI030 从 REUSE_ALV 的 ZFIR030 取到数据的真机实例）
- **⚠️ 不要研究被调报表内部**：参考函数模块的写法拿到后直接复用，**禁止**再读被调报表/参考报表的 ALV 实现、FORM 定义等源码去验证"到底能不能用"（Z_CRM_FI030 模式已真机验证，够用；深挖只会烧 token 拖时间）。
- **参考实现**：函数模块 `Z_CRM_FI030`（读它一次即可，源码里就是完整可用的 SUBMIT 取数模式）。

## 结构（TABL/DS）写入规范（强制）

> 创建/修改 ABAP 结构（DDIC 结构）按此规范。结构用 `create_object_programmatically`（objectType=TABL/DS）+ `replace_string_in_abap_object` 写 DSL 源码（`define structure ZXXX { ... }`）。以下规则真机验证，写错服务器直接拒绝保存。

- **增强注解必须用点号形式**：`@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE`。**禁止**写 `enhancementCategory : [#NOT_EXTENSIBLE]`（那是 CDS 视图写法，结构不接受，保存报 "Can't save due to errors in source"）。
- **数量字段（QUAN）必须加单位注解**：QUAN 字段（如 `menge_d`）上方独占一行写 `@Semantics.quantity.unitOfMeasure : 'mara.meins'`。
- **字段类型引用数据元素**：`vbeln : vbeln_va;`、`stock : menge_d;`（数据元素名，字段名与类型名一致时也要写全）。
- **保存自检以读回为准**：服务器读回会规范化格式（字段名小写、注解形式统一、空行调整），提交文本与读回不同属正常，只要关键字段都落库即写入成功。
- **函数模块结构参数 TYPE 与 LIKE 都合法**：`EXPORTING VALUE(ES_STOCK) TYPE ZAIG_TEST02_S`（或 `LIKE ZAIG_TEST02_S`）。SAP 支持 `TYPE` 引用结构本身，工具不会拦截；仅当类型名是表字段名（如把 `WERKS` 当工厂字段）时才提醒改用数据元素 `WERKS_D`。

## 函数组 include（FUGR/I）写入规范（强制）

> 函数组里放 FORM 的子程序块（如 L<FG>F01）。真机验证，工具已支持创建/写入/激活，AI 可直接做，不要绕道建普通 INCLUDE。

- **创建**：`create_object_programmatically`（objectType=**FUGR/I**，name=**L<函数组><后缀>**，parentName=函数组名，没填会被拦截）。创建后服务器自动在主程序加 `INCLUDE <名>.`。
- **命名后缀**：必须是标准 3 字符（TOP/UXX/F01/U04/...）。**后缀不能是纯数字**（如 L<FG>01）——SAP 会静默拒绝（返回成功但对象不存在），先搜后建会漏。
- **写入 FORM**：`replace_string_in_abap_object` 用函数组通道 fileUri=`/sap/bc/adt/functions/groups/<函数组>/includes/<include>` + fullSource 直接写 `FORM ... ENDFORM.`。函数组 include 是普通 ABAP 程序，**不要写 IMPORTING/TABLES 参数段**（那是函数模块通道）。
- **⚠️ FORM 参数不能内联声明表类型（关键坑）**：FORM 参数段（TABLES/USING/CHANGING）写 `CT_MARD TYPE STANDARD TABLE OF MARD` 会被 SAP 解析成 6 个形式参数（内联表类型按结构字段展开），PERFORM 侧报 "Different number of parameters in FORM and PERFORM (formal: 6, actual: 4)"。正确写法：**先在 include 顶部定义表类型 `TYPES: tt_mard TYPE STANDARD TABLE OF MARD.`，FORM 参数引用 `TYPE tt_mard`**（如 `CHANGING CT_MARD TYPE tt_mard`）。`replace_string_in_abap_object` 写函数组 include 会自动改写内联表类型为 tt_<表> 引用并补类型定义，但请规范书写避免往返。
- **函数模块调用 FORM**：直接写 `PERFORM <form> ...` 即可，**不要写 IN PROGRAM**（同一函数组内 FORM 与函数模块编译进同一主程序，真机验证 ZAIG_TEST02 就是纯 PERFORM 且正确）。
- **⚠️ 函数模块 TABLES 参数是带表头行的表（关键坑）**：`TABLES ET_MARD LIKE MARD` 的 `ET_MARD` 是表头行。函数模块内 `PERFORM` 把整表传给 FORM 表参数必须写 `ET_MARD[]`（整表）；写 `ET_MARD` 传的是表头行，报 "ET_MARD is the header line of table ET_MARD[]"。OPEN SQL 写整表用 `INTO TABLE @et_mard`。
- **FORM 必须先激活（关键）**：函数模块写源码与激活都按函数组的"激活态"编译——FORM include 的改动没激活，函数模块就找不到 FORM，报 "FORM ... does not exist" 或 "Parameter PERFORM declares no type"（写时）。**只激活主程序也不会把 include 的改动固化**，必须激活 include 对象本体。`replace_string_in_abap_object` 写函数组 include 后会自动激活该 include（UXX/U01/主程序除外）；`abap_activate` 激活函数模块（FUGR/FF）时也会先自动激活 FORM include 再激活主程序再激活函数模块。AI 无需手动排顺序。改名/改签名 FORM 时若旧函数模块还引用旧名会激活失败，需同步更新函数模块。
- **激活**：`abap_activate`（objectType=FUGR/I）直接激活；FORM 由函数模块 `PERFORM <form>` 调用。函数模块激活报 "FORM ... does not exist" 就是 include 未激活（工具已自动处理，若仍出现说明 include 激活失败或 FORM 名不一致）。

## 编辑与写路径要点（强制）

- **编辑流程**：读源码 → `replace_string_in_abap_object`（唯一匹配）→ `get_abap_diagnostics` 检查 → `abap_activate` 激活
- **函数组 include 写路径（强制）**：编辑函数组内部程序（`L<FG><后缀>`，如 `LZBCG014F01`）必须用 `/sap/bc/adt/functions/groups/<函数组>/includes/<include>` 格式——工具已自动把 `/programs/includes/...` 形式转换过去（读能直读、写不行）；若仍报 URI 格式错误，主动改用该格式重试，**禁止**深挖 `/programs/includes/` 通用通道写。
- **表/结构 DSL 写后必检（强制）**：写完表/结构 DSL 必须立即 `get_abap_diagnostics` + `abap_activate`；引用程序报 "Unknown column name" 时，**先核对字段名拼写是否与表 DSL 一致**（字段定义与引用必须同名同大小写，如 `zycpjh` vs `ZYCPJH` 就是这类笔误），不要盲目去改引用处。
