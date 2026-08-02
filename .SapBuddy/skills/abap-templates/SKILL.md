---
name: abap-templates
description: >-
  ABAP 开发模板库——报表（Report）与函数模块（Function Module）的具体代码模板：
  ALV 输出（cl_salv_table / cl_gui_alv_grid / REUSE_ALV / 层次 ALV）、选择屏幕、
  数据查询最佳实践、导出导入、函数组结构、接口参数写法、异常处理模式、BAPI 选型、单元测试。
  触发场景：编写或修改 ABAP 报表/函数模块代码，需要具体语法模板时。
  规范（命名/字段类型/消息类等）以 SYSTEM.md（默认 SAP 官方 Clean ABAP）为唯一权威，本文件只提供写法参考。
category: software-development
agent_created: true
---

# ABAP 开发模板库（报表 + 函数模块）

> 命名与编码规则、字段类型（禁裸内置类型）、消息类等一律以 `SYSTEM.md` 为唯一权威；本文件只提供具体代码模板与写法参考。

# 一、ABAP 报表（Report）

---
name: abap-report
description: ABAP 报表（Report）开发参考——ALV 输出、选择屏幕、数据查询最佳实践、导入导出。触发场景：编写或修改 ABAP 报表程序代码，需要代码模板、选择屏幕写法、查询写法、ALV 用法时。
category: software-development
agent_created: true
---

# ABAP 报表开发参考

> 命名与编码规则以 `SYSTEM.md`（默认 SAP 官方 Clean ABAP）为唯一权威；本文件只提供代码模板与写法参考。

## 报表类型

### 1. cl_salv_table（首选，SapBuddy 标准，符合 Clean ABAP OO 优先）

```abap
TRY.
    cl_salv_table=>factory(
      IMPORTING r_salv_table = DATA(lo_salv)
      CHANGING  t_table      = lt_data ).

    lo_salv->get_functions( )->set_all( abap_true ).
    lo_salv->get_columns( )->set_optimize( abap_true ).
    lo_salv->display( ).

  CATCH cx_salv_msg INTO DATA(lx_msg).
    MESSAGE lx_msg->get_text( ) TYPE 'E'.
ENDTRY.
```

> Clean ABAP 推荐面向对象 API；`cl_salv_table` 代码最简、无布局对象，适合多数报表。
> 需要行高亮/编辑/事件等高级交互时用 `cl_gui_alv_grid`（备选）。

### 2. CL_GUI_ALV_GRID（备选，需要交互/事件场景）

```abap
DATA: lo_alv      TYPE REF TO cl_gui_alv_grid,
      lo_container TYPE REF TO cl_gui_custom_container.

CREATE OBJECT lo_container
  EXPORTING container_name = 'ALV_CONTAINER'.

CREATE OBJECT lo_alv
  EXPORTING i_parent = lo_container.

lo_alv->set_table_for_first_display(
  EXPORTING is_layout       = ls_layout
  CHANGING  it_outtab       = lt_data
            it_fieldcatalog = lt_fieldcat ).
```

### 3. REUSE_ALV_GRID_DISPLAY_LVC（兼容备选：遗留系统/存量代码风格）

> 仅当目标系统版本旧或存量代码已用此风格时采用；新代码优先前两种 OO 方案。
> 注：`lt_`/`ls_` 前缀仅限 ALV 字段目录/输出内表等业界通行场景（本技能模板沿用），普通变量遵循 Clean ABAP 无前缀。

```abap
DATA: lt_fieldcat TYPE lvc_t_fcat,
      ls_fieldcat TYPE lvc_s_fcat,
      ls_layout   TYPE lvc_s_layo.

" 字段目录必须显式逐字段定义，禁止用 FORM 或宏自动生成
CLEAR ls_fieldcat.
ls_fieldcat-fieldname = 'VBELN'.
ls_fieldcat-coltext   = TEXT-001.  " 列文本在文本池维护（TEXT-001），禁止硬编码中文
APPEND ls_fieldcat TO lt_fieldcat.

CLEAR ls_fieldcat.
ls_fieldcat-fieldname = 'NETWR'.
ls_fieldcat-coltext   = TEXT-002.  " 列文本在文本池维护（TEXT-002），禁止硬编码中文
ls_fieldcat-no_zero   = abap_true.
APPEND ls_fieldcat TO lt_fieldcat.

ls_layout-zebra      = abap_true.
ls_layout-cwidth_opt = abap_true.

CALL FUNCTION 'REUSE_ALV_GRID_DISPLAY_LVC'
  EXPORTING
    i_callback_program = sy-repid
    is_layout_lvc      = ls_layout
    it_fieldcat_lvc    = lt_fieldcat
  TABLES
    t_outtab           = lt_data
  EXCEPTIONS
    program_error      = 1
    OTHERS             = 2.
```

### 4. 层次 ALV（备选，抬头-行项目双层展示）

```abap
cl_salv_hierseq_table=>factory(
  IMPORTING r_salv_hierseq = DATA(lo_hier)
  CHANGING  t_table1       = lt_header
            t_table2       = item_data ).

lo_lo_hier->display( ).
```

## 选择屏幕

### 常用元素

```abap
" 单值输入（必填）
PARAMETERS: p_vkorg TYPE vbak-vkorg OBLIGATORY.

" 多值区间
SELECT-OPTIONS: s_vbeln FOR vbak-vbeln,
                s_erdat FOR vbak-erdat.

" 复选框
PARAMETERS: p_detail AS CHECKBOX DEFAULT 'X'.

" 单选按钮
PARAMETERS: p_alv  RADIOBUTTON GROUP g1 DEFAULT 'X',
            p_list RADIOBUTTON GROUP g1.

" 下拉列表（状态/选项：用 xfeld 等标准数据元素，禁裸 TYPE char1）
PARAMETERS: p_type TYPE xfeld AS LISTBOX VISIBLE LENGTH 20.
```

### 块与文本元素

```abap
SELECTION-SCREEN BEGIN OF BLOCK b1 WITH FRAME TITLE TEXT-001.
  SELECT-OPTIONS: s_bukrs FOR bkpf-bukrs OBLIGATORY,
                  s_gjahr FOR bkpf-gjahr OBLIGATORY.
SELECTION-SCREEN END OF BLOCK b1.
```
块标题和选择项文本必须用文本元素（TEXT-001），禁止硬编码。

> **禁止硬编码中文（强制）**：所有用户可见文案（提示/错误/说明）禁止直接写在代码里：
> - MESSAGE 语句 → 消息类（`MESSAGE e001(zxxx) WITH ...`，消息类用 `manage_transport_requests` 查/建或 MSAG/N 创建）
> - ALV 列文本/标题/选择文本 → 文本元素（`TEXT-xxx`，`manage_text_elements` 维护）
> - 屏幕块标题 → 文本元素；仅技术注释可用中文。

### 屏幕事件

```abap
AT SELECTION-SCREEN OUTPUT.
  " 默认值：最近 30 天
  s_erdat-low  = sy-datum - 30.
  s_erdat-high = sy-datum.
  APPEND s_erdat.

AT SELECTION-SCREEN.
  " 输入校验，输出合适的错误消息
  IF s_bukrs IS INITIAL.
    " 消息文案在消息类 ZFI 的 e001 中维护（禁止 WITH 传中文文案）
    MESSAGE e001(zfi).
  ENDIF.
```

## 数据查询最佳实践

### 标准 JOIN 查询（最多 3 张表）

```abap
SELECT v~vbeln, v~erdat, v~vkorg, v~kunnr,
       p~posnr, p~matnr, p~kwmeng, p~netwr,
       k~name1 AS customer_name,
       m~maktx AS material_desc
  FROM vbak AS v
  INNER JOIN vbap AS p ON v~vbeln = p~vbeln
  LEFT JOIN kna1 AS k ON v~kunnr = k~kunnr
  LEFT JOIN makt AS m ON p~matnr = m~matnr AND m~spras = @sy-langu
  INTO TABLE @DATA(lt_result)
  WHERE v~vbeln IN @s_vbeln
    AND v~erdat IN @s_erdat
    AND v~vkorg IN @s_vkorg
  ORDER BY v~vbeln, p~posnr.
```

### FOR ALL ENTRIES（必须先检非空）

```abap
" 先取主表
SELECT vbeln, erdat, vkorg FROM vbak
  INTO TABLE @DATA(lt_vbak)
  WHERE vkorg IN @s_vkorg
    AND erdat IN @s_erdat.

" 再取明细
IF lt_vbak IS NOT INITIAL.
  SELECT vbeln, posnr, matnr, kwmeng, netwr FROM vbap
    INTO TABLE @DATA(lt_vbap)
    FOR ALL ENTRIES IN @lt_vbak
    WHERE vbeln = @lt_vbak-vbeln.
ENDIF.
```

### 从已取数据批量补字段（WITH +DATA，禁止全表 SELECT）

已取到 GT_ALV 后需要补其他表的字段时，**禁止 SELECT * FROM 全表**。
必须先从 GT_ALV 取 distinct key，再 JOIN 目标表：

```abap
" 错误 — 全表取数
SELECT kunnr, name1 FROM kna1 INTO TABLE @DATA(lt_kna1).
SORT lt_kna1 BY kunnr.

" 正确 — 只取 GT_ALV 里有的 key
WITH +DATA AS ( SELECT DISTINCT kunnr FROM @gt_alv AS a )
  SELECT a~kunnr, b~name1
    FROM +data AS a
    INNER JOIN kna1 AS b ON a~kunnr = b~kunnr
    INTO TABLE @DATA(lt_kna1).
SORT lt_kna1 BY kunnr.
```

同样适用于 LOOP 中 READ TABLE 取描述的场景。

## 输出格式

### 导出 CSV（应用服务器）

```abap
" 文件路径：无标准数据元素时需创建 Z 数据元素（如 zz_path），禁裸 TYPE string
DATA: lv_file TYPE zz_path VALUE '/tmp/export.csv'.

OPEN DATASET lv_file FOR OUTPUT IN TEXT MODE ENCODING UTF-8.

LOOP AT lt_data INTO DATA(ls_row).
  TRANSFER ls_row TO lv_file.
ENDLOOP.

CLOSE DATASET lv_file.
```

### 读取 Excel（前台上传）

```abap
DATA: lt_excel TYPE TABLE OF alsmex_tabline.

CALL FUNCTION 'ALSM_EXCEL_TO_INTERNAL_TABLE'
  EXPORTING
    filename                = p_file
    i_begin_col             = 1
    i_begin_row             = 1
    i_end_col               = 10
    i_end_row               = 1000
  TABLES
    intern                  = lt_excel
  EXCEPTIONS
    inconsistent_parameters = 1
    upload_ole              = 2.
```

## 常见错误修复

| 错误 | 原因 | 修复 |
|------|------|------|
| 字段不存在 | 表名字段名拼错 | 用内置 `get_abap_object_info`（TABL）确认字段名 |
| 类型不匹配 | 数据类型不一致 | 用 `CONV #( )` 或 `CORRESPONDING` |
| 未声明变量 | 缺少 DATA 声明 | 用内联声明 `@DATA(...)` |
| 表未声明 | TABLES 缺失 | 添加 `TABLES:` 声明（选择屏幕 FOR 字段需要） |
| 选择屏幕错误 | FOR 引用字段不存在 | 确认表已声明在 TABLES 中 |
| `Comma without preceding colon` | `TYPES:` 冒号链内结构体误用 `.` 终止 | 见 `Memory.md` 避坑指南 |

## 常用事务码参考

| 事务码 | 用途 |
|--------|------|
| SE38 | ABAP 编辑器 |
| SE80 | 对象导航器 |
| SE11 | 数据字典 |
| SE16N | 数据浏览器 |
| ST22 | DUMP 分析 |
| SM37 | 后台作业 |
| SU53 | 权限检查 |


# 二、ABAP 函数模块（Function Module）

---
name: abap-function
description: ABAP 函数模块（Function Module）开发参考——函数组结构、参数接口、异常处理模式、常用 BAPI、单元测试。触发场景：编写或修改函数模块/函数组代码，需要接口模板、异常处理写法、BAPI 选型时。
category: software-development
agent_created: true
---

# ABAP 函数模块开发参考

> 命名与编码规则以 `SYSTEM.md`（默认 SAP 官方 Clean ABAP）为唯一权威；本文件只提供代码模板与写法参考。
> **字段类型规范（强制）**：变量/参数声明必须使用 DDIC 数据元素或结构，**禁止裸内置类型**（`i`/`c`/`n`/`p`/`string`/`char1` 等）；
> 找不到标准元素时创建 Z 数据元素 + 域（见 SYSTEM.md）。
> **函数模块接口参数命名**：`IV_`/`EV_`/`ET_`/`ES_` 前缀是 SAP 函数模块接口的通行惯例（SE37 界面/社区代码广泛使用），
> 与类方法的 Clean ABAP 无前缀规则**不同场景不同规则**，接口参数沿用 IV_/EV_ 惯例；函数体内局部变量仍遵循 Clean ABAP（行内声明、无前缀）。
> 函数模块命名：`Z_<模块>_FM_<描述>`；函数组命名：`Z<模块>G<3位编号>`。

## 函数组结构

```abap
FUNCTION-POOL zmmg001.

" 全局数据声明（可选，尽量避免）
DATA: gv_initialized TYPE abap_bool.

" 子程序声明（可选）
FORM f_init.
ENDFORM.
```

## 完整函数模板

```abap
FUNCTION z_mm_fm_get_material.
*"----------------------------------------------------------------------
*"*"Local Interface:
*"  IMPORTING
*"     VALUE(IV_MATNR) TYPE  MATNR
*"     VALUE(IV_WERKS) TYPE  WERKS_D OPTIONAL
*"  EXPORTING
*"     VALUE(ES_MARA)  TYPE  MARA
*"     VALUE(ES_MARC)  TYPE  MARC
*"     VALUE(EV_RETURN) TYPE  BAPIRET2
*"  TABLES
*"      ET_MARD TYPE  MARD_TT OPTIONAL
*"  EXCEPTIONS
*"      MATERIAL_NOT_FOUND
*"      PLANT_NOT_FOUND
*"      INVALID_INPUT
*"----------------------------------------------------------------------

  " 输入校验
  IF iv_matnr IS INITIAL.
    RAISE invalid_input.
  ENDIF.

  " 读取物料主数据（必须写字段列表，禁止 SELECT *）
  SELECT SINGLE matnr, mtart, matkl, meins, maktx
    FROM mara
    INTO CORRESPONDING FIELDS OF @es_mara
    WHERE matnr = @iv_matnr.

  IF sy-subrc <> 0.
    " 文案走消息类（禁止硬编码中文）：MESSAGE ... INTO 取回文本给 BAPIRET2
    MESSAGE e001(zmm) WITH iv_matnr INTO DATA(lv_msg).
    ev_return = VALUE #( type = 'E' id = 'ZMM' number = '001' message = lv_msg ).
    RAISE material_not_found.
  ENDIF.

  " 读取工厂数据
  IF iv_werks IS NOT INITIAL.
    SELECT SINGLE matnr, werks, dispo, beskz
      FROM marc
      INTO CORRESPONDING FIELDS OF @es_marc
      WHERE matnr = @iv_matnr AND werks = @iv_werks.

    IF sy-subrc <> 0.
      RAISE plant_not_found.
    ENDIF.
  ENDIF.

  " 读取库存数据
  SELECT matnr, werks, lgort, labst, umlme
    FROM mard
    INTO CORRESPONDING FIELDS OF TABLE @et_mard
    WHERE matnr = @iv_matnr.

ENDFUNCTION.
```

## 参数类型详解

### IMPORTING 参数
```abap
*"  IMPORTING
*"     VALUE(IV_MATNR) TYPE  MATNR           " 必填
*"     VALUE(IV_WERKS) TYPE  WERKS_D OPTIONAL " 可选
*"     REFERENCE(IS_DATA) TYPE  ZFIS_DATA     " 引用传递（结构）
```

### EXPORTING 参数
```abap
*"  EXPORTING
*"     VALUE(EV_COUNT) TYPE  MENGE_D          " 计数：数量类数据元素（禁裸 TYPE i）
*"     VALUE(ES_HEADER) TYPE  ZFIS_HEADER
*"     REFERENCE(ET_DATA) TYPE  ZFITT_DATA
```

### TABLES 参数
```abap
*"  TABLES
*"      ET_ITEMS TYPE  ZFITT_ITEMS
*"      ET_LOG TYPE  BAPIRET2_TT OPTIONAL
```

### CHANGING 参数
```abap
*"  CHANGING
*"     VALUE(CV_FLAG) TYPE  ABAP_BOOL
*"     REFERENCE(CT_DATA) TYPE  ZFITT_DATA
```

## 异常处理模式

### 模式1：RAISE 异常
```abap
IF sy-subrc <> 0.
  RAISE material_not_found.
ENDIF.
```

### 模式2：BAPIRET2 返回（文案必须走消息类，禁止硬编码中文）
```abap
DATA: ls_return TYPE bapiret2.

" 从消息类 ZMM 取文案（维护在 SE91/文本元素，代码零硬编码）
MESSAGE e001(zmm) WITH iv_matnr INTO DATA(lv_msg).

ls_return = VALUE #(
  type       = 'E'
  id         = 'ZMM'
  number     = '001'
  message    = lv_msg
  message_v1 = iv_matnr
).

APPEND ls_return TO et_return.
```

### 模式3：TRY-CATCH
```abap
TRY.
    DATA(lo_helper) = NEW zcl_mm_material_helper( ).
    lo_helper->validate( iv_matnr ).
    lo_helper->process( iv_matnr ).

  CATCH zcx_mm_material_error INTO DATA(lx_err).
    ev_return = VALUE #( type = 'E' message = lx_err->get_text( ) ).
    RAISE material_not_found.
ENDTRY.
```

## 调用方式

```abap
CALL FUNCTION 'Z_MM_FM_GET_MATERIAL'
  EXPORTING
    iv_matnr           = lv_matnr
  IMPORTING
    es_mara            = ls_mara
  EXCEPTIONS
    material_not_found = 1
    invalid_input      = 2
    OTHERS             = 3.

CASE sy-subrc.
  WHEN 1. MESSAGE e001(zmm) WITH lv_msg1.  " 消息文本在消息类 ZMM 维护，禁止 WITH 硬编码中文
  WHEN 2. MESSAGE e002(zmm) WITH lv_msg2.
  WHEN 3. MESSAGE e003(zmm) WITH lv_msg3.
ENDCASE.
```

## 常用 BAPI 参考

### 数据读取
| 函数 | 用途 |
|------|------|
| BAPI_MATERIAL_GET_DETAIL | 读取物料主数据 |
| BAPI_CUSTOMER_GETDETAIL | 读取客户主数据 |
| BAPI_SALESORDER_GETDETAIL | 读取销售订单 |
| ME_READ_INFORECORD | 读取采购信息记录 |

### 数据创建
| 函数 | 用途 |
|------|------|
| BAPI_MATERIAL_SAVEDATA | 创建/修改物料 |
| BAPI_SALESORDER_CREATEFROMDAT2 | 创建销售订单 |
| BAPI_PO_CREATE1 | 创建采购订单 |
| BAPI_GOODSMVT_CREATE | 物料移动过账 |

### 事务控制
| 函数 | 用途 |
|------|------|
| BAPI_TRANSACTION_COMMIT | 提交事务 |
| BAPI_TRANSACTION_ROLLBACK | 回滚事务 |

## 函数模块测试（ABAP Unit）

```abap
CLASS ltc_material DEFINITION FOR TESTING
  RISK LEVEL HARMLESS
  DURATION SHORT.

  PRIVATE SECTION.
    DATA: mo_cut TYPE REF TO zcl_mm_material_helper.

    METHODS: setup,
             test_validate FOR TESTING,
             test_process FOR TESTING.

ENDCLASS.

CLASS ltc_material IMPLEMENTATION.
  METHOD setup.
    mo_cut = NEW #( ).
  ENDMETHOD.

  METHOD test_validate.
    DATA(lv_result) = mo_cut->validate( '000000000000001234' ).
    cl_abap_unit_assert=>assert_true( lv_result ).
  ENDMETHOD.

  METHOD test_process.
    DATA(lv_result) = mo_cut->process( '000000000000001234' ).
    cl_abap_unit_assert=>assert_not_initial( lv_result ).
  ENDMETHOD.
ENDCLASS.
```

## 函数组设计规范

1. **一个函数组一个业务领域**
   - `ZMMG001` — 物料相关函数
   - `ZSDG001` — 销售相关函数
   - `ZFIG001` — 财务相关函数

2. **函数命名：`Z<模块>_FM_<动词>_<描述>`**
   - `ZMM_FM_GET_MATERIAL` — 读取数据（GET）
   - `ZSD_FM_CREATE_ORDER` — 创建数据（CREATE）
   - `ZMM_FM_UPDATE_MATERIAL` — 更新数据（UPDATE）
   - `ZSD_FM_CHECK_CREDIT` — 校验数据（CHECK）
   - `ZFI_FM_CALC_TAX` — 计算数据（CALC）

3. **避免函数间共享全局数据** — 除非必要，使用参数传递。

4. **每个函数只做一件事** — 单一职责原则。

# 三、ABAP 类（Class / 面向对象）

> Clean ABAP 推荐面向对象优先；新功能优先用类实现。类命名 `ZCL_<模块>_<对象>`（如 ZCL_MM_MATERIAL_HELPER）、异常类 `ZCX_<模块>_<错误>`、接口 `ZIF_<模块>_<能力>`。

## 完整类模板

```abap
CLASS zcl_mm_material_helper DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    " 构造函数：显式声明（需要依赖时）
    METHODS constructor
      IMPORTING
        iv_matnr TYPE matnr OPTIONAL.

    " 命令式方法：动词命名
    METHODS validate
      IMPORTING
        iv_matnr TYPE matnr
      RETURNING
        VALUE(rv_valid) TYPE abap_bool.

    " 查询式方法：is_/has_/get_ 命名
    METHODS get_material
      IMPORTING
        iv_matnr TYPE matnr
      RETURNING
        VALUE(rs_mara) TYPE mara
      RAISING
        zcx_mm_material_error.

    " 类方法（工厂/工具）
    CLASS-METHODS create_instance
      RETURNING
        VALUE(ro_instance) TYPE REF TO zcl_mm_material_helper.

  PRIVATE SECTION.
    " 实例属性：mv_ / mo_ / mt_ 前缀（DDIC 数据元素类型）
    DATA mv_matnr TYPE matnr.
    DATA mt_items TYPE STANDARD TABLE OF mard WITH EMPTY KEY.

    " 私有方法
    METHODS read_material
      IMPORTING
        iv_matnr TYPE matnr
      RETURNING
        VALUE(rs_mara) TYPE mara.
ENDCLASS.

CLASS zcl_mm_material_helper IMPLEMENTATION.
  METHOD constructor.
    mv_matnr = iv_matnr.
  ENDMETHOD.

  METHOD create_instance.
    ro_instance = NEW #( ).
  ENDMETHOD.

  METHOD validate.
    rv_valid = boolc( iv_matnr IS NOT INITIAL ).
  ENDMETHOD.

  METHOD get_material.
    rs_mara = read_material( iv_matnr ).
    IF rs_mara-matnr IS INITIAL.
      RAISE EXCEPTION TYPE zcx_mm_material_error
        EXPORTING
          textid = zcx_mm_material_error=>not_found.
    ENDIF.
  ENDMETHOD.

  METHOD read_material.
    " 显式字段列表，禁 SELECT *
    SELECT SINGLE matnr, mtart, matkl, meins, maktx
      FROM mara
      INTO CORRESPONDING FIELDS OF @rs_mara
      WHERE matnr = @iv_matnr.
  ENDMETHOD.
ENDCLASS.
```

## 接口实现（IF_OO_* 解耦）

```abap
INTERFACE zif_material_read.
  METHODS get_material
    IMPORTING
      iv_matnr TYPE matnr
    RETURNING
      VALUE(rs_mara) TYPE mara
    RAISING
      zcx_mm_material_error.
ENDINTERFACE.

CLASS zcl_mm_material_reader DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES zif_material_read.
ENDCLASS.

CLASS zcl_mm_material_reader IMPLEMENTATION.
  METHOD zif_material_read~get_material.
    " 实现接口方法（接口名~方法名）
    SELECT SINGLE matnr, mtart, matkl FROM mara
      INTO CORRESPONDING FIELDS OF @rs_mara
      WHERE matnr = @iv_matnr.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE zcx_mm_material_error.
    ENDIF.
  ENDMETHOD.
ENDCLASS.
```

## 异常类（继承 CX_STATIC_CHECK）

```abap
CLASS zcx_mm_material_error DEFINITION
  INHERITING FROM cx_static_check
  PUBLIC FINAL CREATE PUBLIC.

  PUBLIC SECTION.
    " 文本 ID：绑定消息类 ZMM 的文本（SE91 维护，禁止硬编码中文）
    CONSTANTS:
      not_found TYPE sotr_conc VALUE '001',
      invalid   TYPE sotr_conc VALUE '002'.

    METHODS get_text REDEFINITION. " 消息文本由 cx_static_check 从消息类取回
ENDCLASS.

CLASS zcx_mm_material_error IMPLEMENTATION.
ENDCLASS.
```

## 工厂方法 / 单例

```abap
" 单例（惰性）
CLASS zcl_mm_manager DEFINITION PUBLIC FINAL CREATE PRIVATE.
  PUBLIC SECTION.
    CLASS-METHODS get_instance
      RETURNING
        VALUE(ro_instance) TYPE REF TO zcl_mm_manager.
  PRIVATE SECTION.
    CLASS-DATA go_instance TYPE REF TO zcl_mm_manager.
ENDCLASS.

CLASS zcl_mm_manager IMPLEMENTATION.
  METHOD get_instance.
    IF go_instance IS NOT BOUND.
      go_instance = NEW #( ).
    ENDIF.
    ro_instance = go_instance.
  ENDMETHOD.
ENDCLASS.
```

## 调用示例

```abap
DATA(lo_helper) = NEW zcl_mm_material_helper( iv_matnr = lv_matnr ).

IF lo_helper->validate( lv_matnr ).
  DATA(ls_mara) = lo_helper->get_material( lv_matnr ).
ENDIF.

" 通过接口调用（解耦）
DATA(lo_reader) = NEW zcl_mm_material_reader( ).
lo_reader->zif_material_read~get_material( lv_matnr ).
```

## 类单元测试（ABAP Unit）

```abap
CLASS ltc_material DEFINITION FOR TESTING
  RISK LEVEL HARMLESS
  DURATION SHORT.

  PRIVATE SECTION.
    DATA mo_cut TYPE REF TO zcl_mm_material_helper.

    METHODS setup,
      test_validate_ok FOR TESTING,
      test_get_material_raises FOR TESTING.

ENDCLASS.

CLASS ltc_material IMPLEMENTATION.
  METHOD setup.
    mo_cut = NEW #( ).
  ENDMETHOD.

  METHOD test_validate_ok.
    cl_abap_unit_assert=>assert_true( mo_cut->validate( '000000000000001234' ) ).
  ENDMETHOD.

  METHOD test_get_material_raises.
    TRY.
        mo_cut->get_material( '000000000000009999' ).
        cl_abap_unit_assert=>fail( 'expected exception was not raised' ).
      CATCH zcx_mm_material_error.
        " 预期异常，测试通过
    ENDTRY.
  ENDMETHOD.
ENDCLASS.
```

## 设计规范（Clean ABAP 核心）

1. **单一职责**：一个类只做一件事；方法短小（≤15 行）
2. **依赖注入**：构造函数收依赖（`mo_dep`），不内部 `NEW` 硬编码
3. **属性私有**：`PRIVATE SECTION` 收好状态，通过方法暴露行为
4. **异常而非返回码**：错误用 `RAISE EXCEPTION`，不返回 `ev_error`
5. **不可变优先**：能 `READ-ONLY` / `FINAL` 就声明
6. **命名**：类=名词、方法=动词（命令式）、查询=is_/has_/get_；属性 `mv_/mo_/mt_` 前缀
