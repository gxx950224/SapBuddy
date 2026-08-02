# SAP ABAP 开发技能

用于 SAP 系统的综合 ABAP 开发技能，涵盖经典 ABAP 和现代 ABAP 云开发模式。


## 技能概述

此技能提供 ABAP 开发的丰富知识，包括：

- **内表**: 标准表、排序表、哈希表；键；操作；LOOP、READ、MODIFY
- **ABAP SQL**: SELECT、INSERT、UPDATE、DELETE、JOIN、CTE、层次结构、聚合函数
- **面向对象 ABAP**: 类、接口、继承、多态、设计模式
- **构造表达式**: VALUE、NEW、CONV、CORRESPONDING、COND、SWITCH、REDUCE、FILTER
- **动态编程**: 字段符号、数据引用、RTTI、RTTC
- **字符串处理**: 字符串函数、模板、FIND、REPLACE、正则表达式
- **RAP（RESTful 应用编程模型）**: EML 语句、BDEF、处理程序方法
- **CDS 视图实体**: 注解、关联、表达式
- **ABAP 单元测试**: 测试类、断言、测试替身
- **异常处理**: TRY-CATCH、异常类、消息
- **ABAP 云开发**: 发布的 API、限制、迁移模式
- **授权**: AUTHORITY-CHECK、CDS 访问控制、DCL
- **ABAP 字典**: 数据元素、域、结构、表类型
- **生成式 AI**: ABAP AI SDK、LLM 集成

## 自动触发关键词

讨论以下内容时会激活此技能：

### ABAP 语言
- ABAP, ABAP code, ABAP program, ABAP class, ABAP method
- DATA, TYPES, CONSTANTS, FIELD-SYMBOLS
- IF, CASE, LOOP, DO, WHILE, ENDLOOP, ENDIF
- SELECT, INSERT, UPDATE, DELETE, MODIFY
- TRY, CATCH, RAISE EXCEPTION, CLEANUP
- CLASS, INTERFACE, METHOD, ENDCLASS

### 内表
- internal table, itab, TABLE OF, STANDARD TABLE, SORTED TABLE, HASHED TABLE
- APPEND, INSERT, READ TABLE, MODIFY TABLE, DELETE
- LOOP AT, FIELD-SYMBOL, ASSIGNING, INTO
- table key, secondary key, WITH KEY
- FOR, REDUCE, FILTER
- GROUP BY, GROUP SIZE, WITHOUT MEMBERS

### 构造表达式
- VALUE, NEW, CONV, CORRESPONDING, CAST, REF
- COND, SWITCH, EXACT
- REDUCE, FILTER, FOR
- constructor expression, inline declaration
- OPTIONAL, DEFAULT, BASE

### 面向对象
- ABAP OO, class definition, class implementation
- inheritance, INHERITING FROM, REDEFINITION
- interface, INTERFACES, ALIASES
- CREATE OBJECT, instantiation, factory method
- PUBLIC SECTION, PRIVATE SECTION, PROTECTED SECTION
- event, RAISE EVENT, SET HANDLER
- factory pattern, singleton, strategy pattern

### RAP 和现代 ABAP
- RAP, RESTful Application Programming Model
- EML, Entity Manipulation Language
- MODIFY ENTITIES, READ ENTITIES, COMMIT ENTITIES
- BDEF, behavior definition, handler method, saver method
- managed, unmanaged, draft
- %cid, %control, %tky, mapped, failed, reported
- global authorization, instance authorization

### CDS 视图
- CDS, Core Data Services, CDS view entity
- define view entity, association, composition
- annotation, @UI, @Semantics
- input parameter, $session
- DCL, access control, define role

### ABAP SQL
- ABAP SQL, SELECT, FROM, WHERE, INTO TABLE
- INNER JOIN, LEFT OUTER JOIN, RIGHT OUTER JOIN
- GROUP BY, HAVING, ORDER BY
- aggregate function, COUNT, SUM, AVG, MIN, MAX
- FOR ALL ENTRIES, subquery, CTE
- HIERARCHY, HIERARCHY_DESCENDANTS, HIERARCHY_ANCESTORS

### 动态编程
- field symbol, ASSIGN, UNASSIGN, IS ASSIGNED
- data reference, REF TO, CREATE DATA, dereference
- RTTI, RTTC, cl_abap_typedescr, cl_abap_structdescr
- dynamic SQL, dynamic method call
- CASTING, BIT-NOT, BIT-AND

### 字符串处理
- string, string template, string function
- FIND, REPLACE, CONCATENATE, SPLIT
- to_upper, to_lower, strlen, substring
- PCRE, regular expression, regex, pattern matching

### 数值操作
- numeric, calculation, arithmetic
- cl_abap_bigint, cl_abap_rational
- ROUND, CEIL, FLOOR, TRUNC
- decfloat16, decfloat34
- ipow, sqrt, exp, log

### 测试
- ABAP Unit, test class, FOR TESTING
- cl_abap_unit_assert, assert_equals
- test double, mock, stub, injection
- RISK LEVEL, DURATION

### 异常处理
- exception, TRY, CATCH, ENDTRY
- RAISE EXCEPTION, THROW
- cx_root, cx_static_check, cx_dynamic_check
- exception class, get_text

### ABAP 云
- ABAP Cloud, ABAP for Cloud Development
- released API, XCO library
- SAP BTP ABAP Environment
- cloud-ready, upgrade-stable

### 授权
- AUTHORITY-CHECK, authorization object
- ACTVT, activity code
- access control, DCL, role
- pfcg_auth, aspect

### ABAP 字典
- data element, domain, structure
- table type, database table
- DDIC, dictionary type
- CDS simple type, CDS enum

### 生成式 AI
- AI SDK, generative AI, LLM
- cl_aic_islm_compl_api_factory
- intelligent scenario, prompt template
- Joule, ABAP AI

### 错误和调试
- sy-subrc, sy-tabix, sy-index
- runtime error, dump, exception
- CX_SY_ZERODIVIDE, CX_SY_ITAB_LINE_NOT_FOUND
- debugging, breakpoint

## 目录结构

```
sap-abap-skills/
├── SKILL.md                        # 带有快速参考的主要技能文件
├── README.md                       # 此文件（用于可发现性的关键字）
└── references/                     # 详细参考文件（28 个文件）
    ├── abap-dictionary.md          # DDIC 对象、类型
    ├── abap-sql.md                 # ABAP SQL 综合指南
    ├── amdp.md                     # ABAP 托管数据库过程
    ├── authorization.md            # 授权检查、DCL
    ├── bits-bytes.md               # 二进制操作、CASTING
    ├── builtin-functions.md        # 字符串、数值、表函数
    ├── cds-views.md                # CDS 视图实体
    ├── cloud-development.md        # ABAP 云特定内容
    ├── constructor-expressions.md  # 构造运算符
    ├── date-time.md                # 日期、时间、时间戳、XCO
    ├── design-patterns.md          # 工厂、单例、策略
    ├── dynamic-programming.md      # RTTI、RTTC、字段符号
    ├── exceptions.md               # 异常处理
    ├── generative-ai.md            # AI SDK 集成
    ├── internal-tables.md          # 完整的表操作
    ├── numeric-operations.md       # 数学函数、大整数
    ├── object-orientation.md       # OO 编程模式
    ├── performance.md              # 数据库、内表优化
    ├── program-flow.md             # IF、CASE、LOOP、DO、WHILE
    ├── rap-eml.md                  # RAP 和 EML 参考
    ├── released-classes.md         # 发布的 API 目录
    ├── sap-luw.md                  # 逻辑工作单元、事务
    ├── sql-hierarchies.md          # CTE 层次结构、导航器
    ├── string-processing.md        # 字符串函数和正则表达式
    ├── table-grouping.md           # GROUP BY 循环
    ├── unit-testing.md             # ABAP 单元框架
    ├── where-conditions.md         # WHERE 子句模式
    └── xml-json.md                 # XML/JSON 处理
```

## 使用方法

向 智能体询问任何 ABAP 开发主题：

- "如何创建具有多个键的排序内表？"
- "RAP 中 EML CREATE 操作的语法是什么？"
- "展示如何使用带字段映射的 CORRESPONDING"
- "如何在 ABAP 中处理异常？"
- "ABAP 云和经典 ABAP 有什么区别？"
- "如何在 ABAP 中实现工厂模式？"
- "ABAP 云中日期/时间的发布类是什么？"
- "如何在 ABAP 中集成生成式 AI？"

## 源文档

内容基于官方 SAP ABAP 速查表：
- **仓库**: [https://github.com/SAP-samples/abap-cheat-sheets](https://github.com/SAP-samples/abap-cheat-sheets)
- **SAP 帮助**: [https://help.sap.com/doc/abapdocu_latest_index_htm/latest/en-US/index.htm](https://help.sap.com/doc/abapdocu_latest_index_htm/latest/en-US/index.htm)

最后修改者：Paul.luo 202606


