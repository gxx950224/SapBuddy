---
name: abap-function
description: ABAP 函数模块（Function Module）开发参考——函数组结构、参数接口、异常处理模式、常用 BAPI、单元测试。触发场景：编写或修改函数模块/函数组代码，需要接口模板、异常处理写法、BAPI 选型时。
category: software-development
agent_created: true
---

# ABAP 函数模块开发参考

> 命名与编码规则以 `SYSTEM.md` 为唯一权威；本文件只提供代码模板与写法参考。
> 函数模块命名：`Z<模块>_FM_<描述>`；函数组命名：`Z<模块>G<3位编号>`。

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
    ev_return = VALUE #( type = 'E' message = '物料不存在' ).
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
*"     VALUE(EV_COUNT) TYPE  I
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

### 模式2：BAPIRET2 返回
```abap
DATA: ls_return TYPE bapiret2.

ls_return = VALUE #(
  type       = 'E'
  id         = 'ZMM'
  number     = '001'
  message    = '物料不存在'
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
  WHEN 1. MESSAGE e001(zmm) WITH '物料不存在'.
  WHEN 2. MESSAGE e002(zmm) WITH '输入无效'.
  WHEN 3. MESSAGE e003(zmm) WITH '未知错误'.
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
