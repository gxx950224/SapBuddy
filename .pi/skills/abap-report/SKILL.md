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
ls_fieldcat-coltext   = '销售订单'.
APPEND ls_fieldcat TO lt_fieldcat.

CLEAR ls_fieldcat.
ls_fieldcat-fieldname = 'NETWR'.
ls_fieldcat-coltext   = '净金额'.
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

" 下拉列表
PARAMETERS: p_type TYPE char1 AS LISTBOX VISIBLE LENGTH 20.
```

### 块与文本元素

```abap
SELECTION-SCREEN BEGIN OF BLOCK b1 WITH FRAME TITLE TEXT-001.
  SELECT-OPTIONS: s_bukrs FOR bkpf-bukrs OBLIGATORY,
                  s_gjahr FOR bkpf-gjahr OBLIGATORY.
SELECTION-SCREEN END OF BLOCK b1.
```
块标题和选择项文本必须用文本元素（TEXT-001），禁止硬编码。

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
    MESSAGE e001(zfi) WITH '公司代码必填'.
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
DATA: lv_file TYPE string VALUE '/tmp/export.csv'.

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
