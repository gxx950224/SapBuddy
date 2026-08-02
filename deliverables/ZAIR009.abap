*&---------------------------------------------------------------------*
*& Report:  ZAIR009
*& 模块:    AI 系统共用
*& 描述:    公司代码明细查询报表
*& 作者:    PI Agent
*& 日期:    2026-08-02
*&---------------------------------------------------------------------*
* 变更记录:
* 日期       修改人    描述
* 2026-08-02 PI Agent  创建
*&---------------------------------------------------------------------*

REPORT ZAIR009.

TABLES: t001.

" 选择屏幕
SELECTION-SCREEN BEGIN OF BLOCK b1 WITH FRAME TITLE '查询条件'.
  SELECT-OPTIONS: s_bukrs FOR t001-bukrs OBLIGATORY. " 公司代码
  PARAMETERS:     p_langu TYPE spras DEFAULT sy-langu. " 描述语言
SELECTION-SCREEN END OF BLOCK b1.

" 输出结构
TYPES: BEGIN OF ty_output,
         bukrs TYPE t001-bukrs,      " 公司代码
         butxt TYPE t001-butxt,      " 公司代码名称
         ort01 TYPE t001-ort01,      " 城市
         land1 TYPE t001-land1,      " 国家/地区
         landx TYPE t005t-landx,     " 国家名称
         waers TYPE t001-waers,      " 本位币
         spras TYPE t001-spras,      " 语言
         ktopl TYPE t001-ktopl,      " 科目表
         periv TYPE t001-periv,      " 会计年度变式
         stras TYPE adrc-street,     " 街道
         pstlz TYPE adrc-post_code1, " 邮编
       END OF ty_output.

DATA: lt_output TYPE TABLE OF ty_output.

*--------------------------------------------------------------------*
START-OF-SELECTION.
  PERFORM f_get_data.
  PERFORM f_display_alv.

*--------------------------------------------------------------------*
*& Form f_get_data
*& 获取公司代码明细
*&--------------------------------------------------------------------*
FORM f_get_data.
  " 公司代码主数据
  SELECT bukrs, butxt, ort01, land1, waers, spras, ktopl, periv, adrnr
    FROM t001
    INTO TABLE @DATA(lt_t001)
    WHERE bukrs IN @s_bukrs.

  IF lt_t001 IS INITIAL.
    MESSAGE '没有符合条件的数据' TYPE 'S' DISPLAY LIKE 'W'.
    LEAVE LIST-PROCESSING.
  ENDIF.

  " 国家名称（按描述语言）
  SELECT land1, landx
    FROM t005t
    INTO TABLE @DATA(lt_t005t)
    WHERE spras = @p_langu.
  SORT lt_t005t BY land1.

  " 地址：街道/邮编（过滤无地址编号的公司代码）
  SELECT addrnumber, street, post_code1
    FROM adrc
    INTO TABLE @DATA(lt_adrc)
    FOR ALL ENTRIES IN @lt_t001
    WHERE addrnumber = @lt_t001-adrnr
      AND addrnumber <> ''.
  SORT lt_adrc BY addrnumber.

  " 装配输出
  LOOP AT lt_t001 INTO DATA(ls_t001).
    DATA(lv_landx) = VALUE #( lt_t005t[ land1 = ls_t001-land1 ]-landx OPTIONAL ).
    DATA(lv_stras) = VALUE #( lt_adrc[ addrnumber = ls_t001-adrnr ]-street OPTIONAL ).
    DATA(lv_pstlz) = VALUE #( lt_adrc[ addrnumber = ls_t001-adrnr ]-post_code1 OPTIONAL ).

    APPEND VALUE ty_output(
      bukrs = ls_t001-bukrs
      butxt = ls_t001-butxt
      ort01 = ls_t001-ort01
      land1 = ls_t001-land1
      landx = lv_landx
      waers = ls_t001-waers
      spras = ls_t001-spras
      ktopl = ls_t001-ktopl
      periv = ls_t001-periv
      stras = lv_stras
      pstlz = lv_pstlz
    ) TO lt_output.
  ENDLOOP.

  IF lt_output IS INITIAL.
    MESSAGE '没有符合条件的数据' TYPE 'S' DISPLAY LIKE 'W'.
    LEAVE LIST-PROCESSING.
  ENDIF.

ENDFORM.

*--------------------------------------------------------------------*
*& Form f_display_alv
*& ALV 列表显示
*&--------------------------------------------------------------------*
FORM f_display_alv.
  TRY.
      cl_salv_table=>factory(
        IMPORTING r_salv_table = DATA(lo_salv)
        CHANGING  t_table      = lt_output ).

      " 全功能工具栏 + 列宽优化
      lo_salv->get_functions( )->set_all( abap_true ).
      DATA(lo_cols) = lo_salv->get_columns( ).
      lo_cols->set_optimize( abap_true ).

      " 列标题中文化
      DATA(lt_fieldtext) = VALUE stringtab(
        ( `BUKRS|公司代码` ) ( `BUTXT|公司代码名称` ) ( `ORT01|城市` )
        ( `LAND1|国家/地区` ) ( `LANDX|国家名称` ) ( `WAERS|本位币` )
        ( `SPRAS|语言` ) ( `KTOPL|科目表` ) ( `PERIV|会计年度变式` )
        ( `STRAS|街道` ) ( `PSTLZ|邮编` ) ).

      LOOP AT lt_fieldtext INTO DATA(lv_fieldtext).
        SPLIT lv_fieldtext AT '|' INTO DATA(lv_field) DATA(lv_text).
        TRY.
            lo_cols->get_column( lv_field )->set_short_text( lv_text ).
          CATCH cx_salv_not_found.
        ENDTRY.
      ENDLOOP.

      lo_salv->display( ).

    CATCH cx_salv_msg INTO DATA(lx_msg).
      MESSAGE lx_msg->get_text( ) TYPE 'E'.
  ENDTRY.
ENDFORM.
