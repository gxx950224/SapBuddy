# 系统取证

## 连接

1. 连接不明确 → 先 `get_connected_systems`。
2. 用户已指定 → 只用指定连接，不要默认第一个。
3. 切换连接后 → 再次 `get_connected_systems` 确认后再查。

## 可用工具（只读）

`get_sap_system_info`、`search_abap_objects`、`get_abap_object_info`、`get_abap_object_lines`、`execute_data_query`、`read_table_contents`、`find_where_used`。

查询限定组织、日期与字段；只取少量样本。返回行数上限 ≠ 扫描范围小。

## 记录四种状态

已取得 / 零行 / 部分取得 / 失败。

- 零行 ≠ 对象不存在
- 失败 ≠ 没有该功能
- 字段存在 ≠ 逻辑可用
- 对象存在 ≠ 调用时点与入口已验证

每种限制写进附录 E 的「限制与结论」。

## 边界

- 本流程不创建、不激活、不修改 SAP 对象。
- abap_wiki / 知识库仅作定位；必须与系统查询分开标注。
- 未核实的对象名标「候选，待验证」，写入 E 或 Q，不写进已确认口径。
