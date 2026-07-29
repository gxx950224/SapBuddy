# 避坑指南

> 记录 ABAP 开发过程中遇到的坑和解决方案。
> 写入时机：三次失败规则触发后问题被解决，或发现任何值得复用的坑。
> 新条目追加在文件末尾，按模板填写。

---

## 条目模板（新增条目时复制以下结构）

```markdown
## <一句话问题描述>

- **日期：** YYYY-MM-DD
- **对象：** <程序名/函数名，如 ZFIR001>
- **症状：** <报错信息或异常现象>
- **根因：** <为什么会发生>
- **方案：** <正确做法，附代码示例>
- **预防：** <下次如何在生成代码阶段就避免>
```

---

## `TYPES:` 冒号链 + `BEGIN OF` 语法

- **日期：** 2026-07（首次记录）
- **对象：** 通用（所有含结构体声明的程序）
- **症状：** 激活时报错 `Comma without preceding colon (after BUKRS ?).`
- **根因：** `TYPES:` 冒号链后跟 `.` 会终止链，解析器在 TYPE 结构体内的逗号上报错。
- **方案：**

错误写法：
```abap
TYPES:BEGIN OF GTY_OUT.
       BUKRS TYPE T001-BUKRS,
     END OF GTY_OUT.
```

正确写法：
```abap
TYPES: BEGIN OF GTY_OUT,
         BUKRS TYPE T001-BUKRS,
       END OF GTY_OUT.
```

- **预防：** `TYPES:` 冒号链中所有成员（含 `BEGIN OF`/`END OF`）一律用逗号衔接，链尾才用句号。
