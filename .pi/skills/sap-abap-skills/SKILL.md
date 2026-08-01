---
name: sap-abap-skills
description: SAP 系统的综合 ABAP 开发技能。适用于编写 ABAP 代码、处理内表、结构、ABAP SQL、面向对象编程、RAP（RESTful 应用编程模型）、CDS 视图、EML 语句、ABAP 云开发、字符串处理、动态编程、RTTI/RTTC、字段符号、数据引用、异常处理或 ABAP 单元测试。涵盖经典 ABAP 和现代 ABAP 云开发模式。
category: software-development
agent_created: false
abap_release: "7.40 SP08+ / 7.50+ / ABAP Cloud"
sources:
  - "https://help.sap.com/doc/abapdocu_latest_index_htm/latest/en-US/index.htm"
  - "https://github.com/SAP-samples/abap-cheat-sheets"
---

# SAP ABAP 开发技能

> **与项目规范的关系**：本技能为通用 ABAP 语法知识库（源自 SAP 官方文档），用于语法查询与版本兼容确认。
> 命名规则、编码规范与开发流程一律以 `SYSTEM.md` 和 `AGENTS.md` 为准——**冲突时规范优先**。
> **字段类型**：本技能示例中的裸内置类型（`string`/`i`/`char1` 等）仅为语法演示——
> 实际项目代码必须使用 DDIC 数据元素（禁裸内置类型），找不到标准元素时创建 Z 数据元素 + 域（见 SYSTEM.md）。
> 本技能示例中出现的 `SELECT *` 等写法仅为语法演示，SapBuddy 项目开发中禁止。

## 相关技能

- **sap-abap-cds**: 用于开发基于 ABAP 的 Fiori 应用程序的 CDS 视图，或使用注解定义数据模型
- **sap-btp-cloud-platform**: 用于在 BTP 上处理 ABAP 环境或将 ABAP 应用程序部署到云端
- **sap-cap-capire**: 用于将 ABAP 系统与 CAP 应用程序连接或与 OData 服务集成
- **sap-fiori-tools**: 用于使用 ABAP 后端构建 Fiori 应用程序或从 ABAP 系统使用 OData 服务
- **sap-api-style**: 用于记录 ABAP API 或遵循 SAP API 文档标准

## 何时使用此技能

当遇到以下情况时使用此技能：

1. **编写或审查 ABAP 代码**
   - 内表、结构、数据类型操作
   - ABAP SQL 数据库访问
   - 面向对象编程（类、接口）
   - 字符串处理、动态编程

2. **现代 ABAP 开发**
   - RAP（RESTful 应用编程模型）
   - CDS 视图开发
   - ABAP 云开发和迁移
   - EML（实体操作语言）语句

3. **测试和调试**
   - ABAP 单元测试
   - 异常处理和错误排查
   - 性能优化

4. **查找参考信息**
   - 语法、最佳实践、设计模式
   - 版本兼容性确认
   - 官方文档补充参考

**资源查找优先级**：首先使用本地 `references/` 目录 → 然后参考本文件 → 最后可补充官方 SAP 文档。

## 版本兼容性

此技能涵盖从 **7.40 SP08** 到 **ABAP Cloud** 的 ABAP 语法。需要更高版本的功能在代码示例中使用格式 `" [7.xx+]` 的内联注释进行注解，或在参考文件中注明。下表总结了关键版本边界。

| 功能 | 7.40 SP02 | 7.40 SP05 | 7.40 SP08 | 7.50 | 7.51 | 7.52 | 7.54 |
|---------|:---------:|:---------:|:---------:|:----:|:----:|:----:|:----:|
| 内联声明 `DATA(...)` | x | x | x | x | x | x | x |
| 构造运算符 (VALUE, NEW, CONV, COND, SWITCH, REF, EXACT, CAST) | x | x | x | x | x | x | x |
| 表表达式 `itab[...]` | x | x | x | x | x | x | x |
| 字符串模板 | x | x | x | x | x | x | x |
| `WITH EMPTY KEY` | x | x | x | x | x | x | x |
| `line_exists()`, `line_index()` | x | x | x | x | x | x | x |
| ABAP SQL: `@` 宿主变量 | | x | x | x | x | x | x |
| ABAP SQL: 逗号分隔列表 | | x | x | x | x | x | x |
| ABAP SQL: SELECT 中的 SQL 表达式 | | x | x | x | x | x | x |
| `CORRESPONDING` 运算符 | | x | x | x | x | x | x |
| 表推导 (`FOR`) | | x | x | x | x | x | x |
| `LET` 表达式 | | x | x | x | x | x | x |
| `REDUCE` 运算符 | | | x | x | x | x | x |
| `FILTER` 运算符 | | | x | x | x | x | x |
| `BASE` 附加项 | | | x | x | x | x | x |
| `LOOP AT ... GROUP BY` | | | x | x | x | x | x |
| ABAP SQL: SELECT 中的 `dbtab~*` | | | x | x | x | x | x |
| ABAP SQL: `RIGHT OUTER JOIN` | | x | x | x | x | x | x |
| 带参数的 CDS 视图 | | | x | x | x | x | x |
| **`FINAL(...)` 内联声明** | | | | x | x | x | x |
| **宿主表达式 `@( expr )`** | | | | x | x | x | x |
| **SELECT 中的 `UNION`** | | | | x | x | x | x |
| **`IS INSTANCE OF` / `CASE TYPE OF`** | | | | x | x | x | x |
| **`int8` 类型** | | | | x | x | x | x |
| **CDS 表函数** | | | | x | x | x | x |
| **CDS 访问控制（隐式）** | | | | x | x | x | x |
| **`$session.user/client/system_language`** | | | | x | x | x | x |
| **测试接缝 (`TEST-SEAM`)** | | | | x | x | x | x |
| **公用表表达式 (`WITH`)** | | | | | x | x | x |
| **SELECT 中的 `OFFSET`** | | | | | x | x | x |
| **CDS 中的 `UPPER`/`LOWER`** | | | | | x | x | x |
| **枚举类型** | | | | | x | x | x |
| **内表作为数据源 `FROM @itab`** | | | | | | x | x |
| **`WITH PRIVILEGED ACCESS`** | | | | | | x | x |
| **`utclong` 类型和函数** | | | | | | | x |

**在 7.40 系统上**：将任何 `FINAL(...)` 替换为 `DATA(...)`，并避免使用上面粗体标记的 7.50+ 功能。大多数现代 ABAP 语法（VALUE、NEW、CONV、内联声明、表表达式、REDUCE、FILTER、GROUP BY）从 7.40 SP08 开始可用。

## 目录
- [版本兼容性](#version-compatibility)
- [快速参考](#quick-reference)
- [捆绑资源](#bundled-resources)
- [常见模式](#common-patterns)
- [错误目录](#error-catalog)
- [性能提示](#performance-tips)
- [源文档](#source-documentation)

## 快速参考

### 数据类型和声明

```abap
" Elementary types
DATA num TYPE i VALUE 123.
DATA txt TYPE string VALUE `Hello`.
DATA flag TYPE abap_bool VALUE abap_true.

" Inline declarations
DATA(result) = some_method( ).
FINAL(immutable) = `constant value`.              " [7.50+] Use DATA(...) on 7.40

" Structures
DATA: BEGIN OF struc,
        id   TYPE i,
        name TYPE string,
      END OF struc.

" Internal tables
DATA itab TYPE TABLE OF string WITH EMPTY KEY.
DATA sorted_tab TYPE SORTED TABLE OF struct WITH UNIQUE KEY id.
DATA hashed_tab TYPE HASHED TABLE OF struct WITH UNIQUE KEY id.
```

### 内表 - 基本操作

```abap
" Create with VALUE
itab = VALUE #( ( col1 = 1 col2 = `a` )
                ( col1 = 2 col2 = `b` ) ).

" Read operations
DATA(line) = itab[ 1 ].                    " By index
DATA(line2) = itab[ col1 = 1 ].            " By key
READ TABLE itab INTO wa INDEX 1.
READ TABLE itab ASSIGNING FIELD-SYMBOL(<fs>) WITH KEY col1 = 1.

" Modify operations
MODIFY TABLE itab FROM VALUE #( col1 = 1 col2 = `updated` ).
itab[ 1 ]-col2 = `changed`.

" Loop processing
LOOP AT itab ASSIGNING FIELD-SYMBOL(<line>).
  <line>-col2 = to_upper( <line>-col2 ).
ENDLOOP.

" Delete
DELETE itab WHERE col1 > 5.
DELETE TABLE itab FROM VALUE #( col1 = 1 ).
```

### ABAP SQL 要点

```abap
" SELECT into table
SELECT * FROM dbtab INTO TABLE @DATA(result_tab).   " @ syntax: 7.40 SP05+

" SELECT with conditions
SELECT carrid, connid, fldate                          " comma syntax: 7.40 SP05+
  FROM zdemo_abap_fli
  WHERE carrid = 'LH'
  INTO TABLE @DATA(flights).

" Aggregate functions
SELECT carrid, COUNT(*) AS cnt, AVG( price ) AS avg_price
  FROM zdemo_abap_fli
  GROUP BY carrid
  INTO TABLE @DATA(stats).

" JOIN operations
SELECT a~carrid, a~connid, b~carrname
  FROM zdemo_abap_fli AS a
  INNER JOIN zdemo_abap_carr AS b ON a~carrid = b~carrid
  INTO TABLE @DATA(joined).

" Modification statements
INSERT dbtab FROM @struc.
UPDATE dbtab FROM @struc.
MODIFY dbtab FROM TABLE @itab.
DELETE FROM dbtab WHERE condition.
```

### 构造表达式

```abap
" VALUE - structures and tables
DATA(struc) = VALUE struct_type( comp1 = 1 comp2 = `text` ).
DATA(itab) = VALUE itab_type( ( a = 1 ) ( a = 2 ) ( a = 3 ) ).

" NEW - create instances
DATA(dref) = NEW i( 123 ).
DATA(oref) = NEW zcl_my_class( param = value ).

" CORRESPONDING - structure/table mapping
target = CORRESPONDING #( source ).
target = CORRESPONDING #( source MAPPING target_field = source_field ).

" COND/SWITCH - conditional values
DATA(text) = COND string( WHEN flag = abap_true THEN `Yes` ELSE `No` ).
DATA(result) = SWITCH #( code WHEN 1 THEN `A` WHEN 2 THEN `B` ELSE `X` ).

" CONV - type conversion
DATA(dec) = CONV decfloat34( 1 / 3 ).

" FILTER - table filtering
DATA(filtered) = FILTER #( itab WHERE status = 'A' ).

" REDUCE - aggregation
DATA(sum) = REDUCE i( INIT s = 0 FOR wa IN itab NEXT s = s + wa-amount ).
```

### 面向对象 ABAP

```abap
" Class definition
CLASS zcl_example DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS constructor IMPORTING iv_name TYPE string.
    METHODS get_name RETURNING VALUE(rv_name) TYPE string.
    CLASS-METHODS factory RETURNING VALUE(ro_instance) TYPE REF TO zcl_example.
  PRIVATE SECTION.
    DATA mv_name TYPE string.
ENDCLASS.

CLASS zcl_example IMPLEMENTATION.
  METHOD constructor.
    mv_name = iv_name.
  ENDMETHOD.
  METHOD get_name.
    rv_name = mv_name.
  ENDMETHOD.
  METHOD factory.
    ro_instance = NEW #( `Default` ).
  ENDMETHOD.
ENDCLASS.

" Interface implementation
CLASS zcl_impl DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES zif_my_interface.
ENDCLASS.
```

### 异常处理

```abap
TRY.
    DATA(result) = risky_operation( ).
  CATCH cx_sy_zerodivide INTO DATA(exc).
    DATA(msg) = exc->get_text( ).
  CATCH cx_root INTO DATA(any_exc).
    " Handle any exception
  CLEANUP.
    " Cleanup code
ENDTRY.

" Raising exceptions
RAISE EXCEPTION TYPE zcx_my_exception
  EXPORTING textid = zcx_my_exception=>error_occurred.

" With COND/SWITCH
DATA(val) = COND #( WHEN valid THEN result
                    ELSE THROW zcx_my_exception( ) ).
```

### 字符串处理

```abap
" Concatenation
DATA(full) = first && ` ` && last.
txt &&= ` appended`.

" String templates
DATA(msg) = |Name: { name }, Date: { date DATE = ISO }|.

" Functions
DATA(upper) = to_upper( text ).
DATA(len) = strlen( text ).
DATA(found) = find( val = text sub = `search` ).
DATA(replaced) = replace( val = text sub = `old` with = `new` occ = 0 ).
DATA(parts) = segment( val = text index = 2 sep = `,` ).

" FIND/REPLACE statements
FIND ALL OCCURRENCES OF pattern IN text RESULTS DATA(matches).
REPLACE ALL OCCURRENCES OF old IN text WITH new.
```

### 动态编程

```abap
" Field symbols
FIELD-SYMBOLS <fs> TYPE any.
ASSIGN struct-component TO <fs>.
ASSIGN struct-(comp_name) TO <fs>.  " Dynamic component

" Data references
DATA dref TYPE REF TO data.
dref = REF #( variable ).
CREATE DATA dref TYPE (type_name).
dref->* = value.

" RTTI - Get type information
DATA(tdo) = cl_abap_typedescr=>describe_by_data( dobj ).
DATA(components) = CAST cl_abap_structdescr( tdo )->components.

" RTTC - Create types dynamically
DATA(elem_type) = cl_abap_elemdescr=>get_string( ).
CREATE DATA dref TYPE HANDLE elem_type.
```

---

## 捆绑资源

此技能包含 29 个综合参考文件，涵盖 ABAP 开发的所有方面：

### 相关技能
- **sap-abap-cds**: 用于 CDS 视图开发和 ABAP 云数据建模
- **sap-btp-cloud-platform**: 用于 ABAP 环境设置和 BTP 部署
- **sap-cap-capire**: 用于 CAP 服务集成和 ABAP 系统连接
- **sap-fiori-tools**: 用于使用 ABAP 后端进行 Fiori 应用程序开发
- **sap-api-style**: 用于 API 文档标准和最佳实践

### 资源查找策略

此技能按以下优先级查找信息：

1. **本地参考文件优先**：首先查找 `references/` 目录中的详细参考文件
2. **SKILL.md 快速参考**：对于常见模式，使用本文件中的快速参考
3. **官方源文档**：如果本地资源不足，可参考官方 SAP 文档：
   - SAP 官方帮助（最新）：[https://help.sap.com/doc/abapdocu_latest_index_htm/latest/en-US/index.htm](https://help.sap.com/doc/abapdocu_latest_index_htm/latest/en-US/index.htm)
   - GitHub ABAP 速查表：[https://github.com/SAP-samples/abap-cheat-sheets](https://github.com/SAP-samples/abap-cheat-sheets)

### 快速访问
- **参考指南**: `references/skill-reference-guide.md` - 所有参考文件的完整指南
- **内表**: `references/internal-tables.md` - 完整的表操作
- **ABAP SQL**: `references/abap-sql.md` - 全面的 SQL 参考
- **面向对象**: `references/object-orientation.md` - 类和接口

### 开发主题
- `references/constructor-expressions.md` - VALUE, NEW, COND, REDUCE
- `references/rap-eml.md` - RAP 和 EML 操作
- `references/cds-views.md` - CDS 视图开发
- `references/string-processing.md` - 字符串函数和正则表达式
- `references/unit-testing.md` - ABAP 单元框架
- `references/performance.md` - 优化技术
- ... 和 18 个更多的专门参考

---

## 常见模式

### 安全表访问（避免异常）

```abap
" Using VALUE with OPTIONAL
DATA(line) = VALUE #( itab[ key = value ] OPTIONAL ).

" Using VALUE with DEFAULT
DATA(line) = VALUE #( itab[ 1 ] DEFAULT VALUE #( ) ).

" Check before access
IF line_exists( itab[ key = value ] ).
  DATA(line) = itab[ key = value ].
ENDIF.
```

### 函数式方法链

```abap
DATA(result) = NEW zcl_builder( )
  ->set_name( `Test` )
  ->set_value( 123 )
  ->build( ).
```

### FOR 迭代表达式

```abap
" Transform table
DATA(transformed) = VALUE itab_type(
  FOR wa IN source_itab
  ( id = wa-id name = to_upper( wa-name ) ) ).

" With WHERE
DATA(filtered) = VALUE itab_type(
  FOR wa IN source WHERE ( status = 'A' )
  ( wa ) ).

" With INDEX INTO
DATA(numbered) = VALUE itab_type(
  FOR wa IN source INDEX INTO idx
  ( line_no = idx data = wa ) ).
```

### ABAP 云兼容性

```abap
" Use released APIs only
DATA(uuid) = cl_system_uuid=>create_uuid_x16_static( ).
DATA(date) = xco_cp=>sy->date( )->as( xco_cp_time=>format->iso_8601_extended )->value.
DATA(time) = xco_cp=>sy->time( )->as( xco_cp_time=>format->iso_8601_extended )->value.

" Output in cloud (if_oo_adt_classrun)
out->write( result ).

" Avoid: sy-datum, sy-uzeit, DESCRIBE TABLE, WRITE, MOVE...TO
```

### ABAP 7.40 兼容性

当针对 ABAP 7.40 系统时，用以下模式替换 7.50+ 语法：

```abap
" Instead of FINAL (7.50+):
FINAL(value) = `constant`.              " 7.50+
DATA(value) = `constant`.               " 7.40 compatible

" Instead of host expressions (7.50+):
SELECT * FROM dbtab WHERE col = @( lv_val ).   " 7.50+
SELECT * FROM dbtab WHERE col = @lv_val.        " 7.40 compatible

" Instead of UNION (7.50+):
SELECT a FROM tab1 UNION SELECT a FROM tab2.    " 7.50+
" Use two separate SELECTs on 7.40 and combine in ABAP:
SELECT a FROM tab1 INTO TABLE @DATA(r1).
SELECT a FROM tab2 INTO TABLE @DATA(r2).
DATA(combined) = VALUE itab_type( FOR l1 IN r1 ( l1 )
                                  FOR l2 IN r2 ( l2 ) ).

" Instead of IS INSTANCE OF (7.50+):
IF oref IS INSTANCE OF zcl_my_class.    " 7.50+
" 7.40 alternative — use typed CAST with exception handling:
TRY.
    DATA(lo) = CAST zcl_my_class( oref ).  " 7.40+
  CATCH cx_sy_move_cast_error.
    " oref is not compatible with zcl_my_class
ENDTRY.

" Instead of CTEs WITH (7.51+):
WITH +cte AS ( SELECT ... ) SELECT ...  " 7.51+
" Use subqueries or temporary tables on 7.40
```

---

## 错误目录

### CX_SY_ITAB_LINE_NOT_FOUND
**原因**: 表表达式访问不存在的行
**解决方案**: 使用 OPTIONAL、DEFAULT，或用 `line_exists( )` 检查

### CX_SY_ZERODIVIDE
**原因**: 除以零
**解决方案**: 在操作前检查除数

### CX_SY_RANGE_OUT_OF_BOUNDS
**原因**: 无效的子串访问或数组边界
**解决方案**: 在访问前验证偏移和长度

### CX_SY_CONVERSION_NO_NUMBER
**原因**: 字符串无法转换为数字
**解决方案**: 在转换前验证输入格式

### CX_SY_REF_IS_INITIAL
**原因**: 解引用未绑定的引用
**解决方案**: 在解引用前检查 `IS BOUND`

---

## 性能提示

1. **使用 SORTED/HASHED 表**进行频繁的键访问
2. **优先使用字段符号**而不是循环中的工作区进行修改
3. **对大型 SELECT 结果使用 PACKAGE SIZE**
4. **避免在循环中 SELECT** - 使用 FOR ALL ENTRIES 或 JOIN
5. **使用辅助键**应对不同的访问模式
6. **最小化 CORRESPONDING 调用** - 显式赋值更快

---

## 源文档

所有内容基于 SAP 官方 ABAP 速查表：
- 仓库: [https://github.com/SAP-samples/abap-cheat-sheets](https://github.com/SAP-samples/abap-cheat-sheets)
- SAP 帮助（最新）: [https://help.sap.com/doc/abapdocu_latest_index_htm/latest/en-US/index.htm](https://help.sap.com/doc/abapdocu_latest_index_htm/latest/en-US/index.htm)
- SAP 帮助 (7.40): [https://help.sap.com/doc/abapdocu_740_index_htm/7.40/en-US/index.htm](https://help.sap.com/doc/abapdocu_740_index_htm/7.40/en-US/index.htm)
- ABAP 发布新闻: [https://github.com/SAP-samples/abap-cheat-sheets/blob/main/33_ABAP_Release_News.md](https://github.com/SAP-samples/abap-cheat-sheets/blob/main/33_ABAP_Release_News.md)
