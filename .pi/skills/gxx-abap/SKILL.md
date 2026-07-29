---
name: gxx-abap
description: 通过 gxx-abap CLI 工具操作 SAP ABAP 开发系统。触发场景：创建/修改/激活/检查 ABAP 对象、搜索对象、查表结构、查引用、查 DUMP、消息类、文本元素、传输请求、系统信息。
category: software-development
agent_created: true
---

# gxx-abap — SAP ABAP 操作指南

通过项目级 gxx-abap CLI 工具操作 SAP ABAP 开发系统。所有命令通过 `node gxx-abap/bin/gxx-abap.js` 调用，配置自动从项目根 `.gxx-abap/config.json` 加载。

## 何时使用本 skill

- 用户要求创建 / 修改 / 激活 / 检查 / 查看 ABAP 对象（程序、类、接口、函数组与函数模块、表、CDS 视图）
- 用户要求搜索对象、查看源码、查表字段与结构、Where-Used 引用、短转储、消息类、文本元素
- 用户要求管理传输请求、查看系统信息、排查程序 DUMP

## 核心规则（必须遵守）

1. **搜索规则** — 先用精确名搜索（不加通配符）。无结果时向用户确认后再模糊搜索（加 `*`）。创建前用 `ls` 确认对象不存在。
2. **写入源码标准流程** — `ls` 确认不存在 → `create` → 写本地文件 → `put` 写入 SAP → `activate` 激活。
3. **修改已有对象流程** — `cat` 读源码 → 修改本地文件 → `put` 写入 → `activate` 激活。
4. **排查故障用 `dump`** — 程序 DUMP 后调用 `dump` 查详情，定位出错行。
5. **文本元素格式** — selections/headings 无 MaxLength 头，每行 `KEY  =VALUE`（等号前空格补齐对齐）。symbols 首行必须 `@MaxLength:N`，后续 `KEY=VALUE`（单等号）。symbols 只支持更新已存在条目，不能新建。
6. **传输号自动检测** — 单对象时 `put` 自动查已有传输号。多对象要放同一请求时必须问用户要传输号，每个对象都传 `--transport <同一个号>`，否则各自新建。
7. **查表字段用 `meta` 不用 `cat -t table`** — `meta` 返回结构化字段列表；`cat -t table` 只返回表头定义源码。
8. **涉及修改写入的命令必须向用户确认** — 特别是 `create`、`put`、`texts`（写入模式）、`activate`，执行前展示变更概要并获得明确许可。
9. **通用兜底：直接用 `node gxx-abap/bin/gxx-abap.js <命令>`** — 所有命令自动加 `--json`。

## CLI 命令速查

所有命令统一格式：`node gxx-abap/bin/gxx-abap.js <子命令> [参数] --json`

| 子命令 | 作用 | 示例 |
|--------|------|------|
| `ping` | 测试连接 | `node gxx-abap/bin/gxx-abap.js ping --json` |
| `status` | 连接状态 | `node gxx-abap/bin/gxx-abap.js status --json` |
| `ls <pattern>` | 搜索对象 | `node gxx-abap/bin/gxx-abap.js ls ZAIR001 --json` |
| `cat <name>` | 查看源码 | `node gxx-abap/bin/gxx-abap.js cat ZAIR001 --json` |
| `create <name> -t <type>` | 创建对象 | `node gxx-abap/bin/gxx-abap.js create ZFIR001 -t program --description "报表" --json` |
| `put <name> <file>` | 写入代码 | `node gxx-abap/bin/gxx-abap.js put ZFIR001 output/ZFIR001.abap --json` |
| `activate <name>` | 激活对象 | `node gxx-abap/bin/gxx-abap.js activate ZFIR001 --json` |
| `meta <name>` | 查表/结构字段 | `node gxx-abap/bin/gxx-abap.js meta BKPF --json` |
| `refs <name>` | Where-Used 引用 | `node gxx-abap/bin/gxx-abap.js refs ZFIR001 --json` |
| `dump [id]` | 查短转储 | `node gxx-abap/bin/gxx-abap.js dump --json` |
| `transport list/object` | 传输管理 | `node gxx-abap/bin/gxx-abap.js transport list --json` |
| `message <类名>` | 查消息类 | `node gxx-abap/bin/gxx-abap.js message ZFI --json` |
| `texts <name>` | 查/改文本元素 | `node gxx-abap/bin/gxx-abap.js texts ZFIR001 --json` |
| `system info/components` | 系统信息 | `node gxx-abap/bin/gxx-abap.js system info --json` |

## 标准工作流

> **本地文件约定**：所有本地代码文件统一放 `output/` 目录（`output/<对象名>.abap`），禁止散落项目根目录。

### 新建对象
```
node gxx-abap/bin/gxx-abap.js ls ZFIR* --json        # 确认不存在
node gxx-abap/bin/gxx-abap.js create ZFIR001 -t program --description "客户余额报表" --json
# 写本地文件 output/ZFIR001.abap
node gxx-abap/bin/gxx-abap.js put ZFIR001 output/ZFIR001.abap --json
node gxx-abap/bin/gxx-abap.js activate ZFIR001 --json
# 有错误修正后重试
```

### 修改已有对象
```
node gxx-abap/bin/gxx-abap.js cat ZFIR001 --json       # 读取源码
# 修改本地文件 output/ZFIR001.abap
node gxx-abap/bin/gxx-abap.js put ZFIR001 output/ZFIR001.abap --json
node gxx-abap/bin/gxx-abap.js activate ZFIR001 --json
```

### 查表结构
```
node gxx-abap/bin/gxx-abap.js meta BKPF --json         # 查看 BKPF 表字段
```

### 故障排查（程序 DUMP）
```
node gxx-abap/bin/gxx-abap.js dump --json              # 最新 DUMP 列表
node gxx-abap/bin/gxx-abap.js dump <14位时间戳> --json  # DUMP详情，看 termination.line
```

### 文本元素
```
# 查看
node gxx-abap/bin/gxx-abap.js texts ZFIR001 --json
# 写入（文件放 output/，命名 <对象名>_texts.txt）
node gxx-abap/bin/gxx-abap.js texts ZFIR001 --set selections --file output/ZFIR001_texts.txt --json
```

### 消息类 & 系统信息
```
node gxx-abap/bin/gxx-abap.js message ZFI --json       # 查消息类 ZFI
node gxx-abap/bin/gxx-abap.js system info --json       # 系统基本信息
node gxx-abap/bin/gxx-abap.js system components --json # 系统组件列表
```

## 确认要求

涉及修改写入的命令（`create`、`put`、`texts` 的 set 模式、`activate`）执行前，必须向用户展示变更概要（对象名、类型、包、传输任务号、改动点），并获得明确许可后再执行。

## 关键业务知识

- 类型映射：`PROG/P`=程序，`CLAS/OC`=类，`INTF/OI`=接口，`FUGR/F`=函数组，`FUGR/FF`=函数模块，`TABL/DT`=表，`DDLS/DF`=CDS 视图
- 自动识别规则：`CL_*`/`ZCL_*`→class，`IF_*`/`ZIF_*`→interface，`SAPL*`/短名→function，其他→program
- `$TMP` 包中的对象不需要传输号
- 文本元素 symbols 只支持更新已存在条目，不能新建
