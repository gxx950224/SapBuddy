# gxx-abap 命令手册

ABAP ADT 命令行工具，从终端操作 SAP ABAP 开发系统。共 17 条命令，全部支持 `--json` 输出。

---

## 快速开始

```bash
# 1. 配置连接（只需做一次）
gxx-abap config --host <host> -u BC01 -p <密码> -c 100

# 2. 测试连接
gxx-abap ping

# 3. 开始使用
gxx-abap ls Z*
gxx-abap cat zppr090
gxx-abap meta ekko
```

---

## 连接管理

### config

配置 SAP 连接信息，持久化到 `~/.gxx-abap/config.json`。

```bash
gxx-abap config --host <host> -u <user> -p <password> -c <client>
gxx-abap config --show
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `--host <host>` | 首次 | SAP 系统主机名或 IP |
| `-u, --user <user>` | 首次 | 用户名 |
| `-p, --password <password>` | 首次 | 密码 |
| `-c, --client <client>` | 否 | Client，默认 100 |
| `--port <port>` | 否 | 端口，默认 44300 |
| `--http` | 否 | 使用 HTTP（默认 HTTPS） |
| `--show` | — | 查看当前配置（密码显示为 `******`） |
| `--json` | — | JSON 输出 |

```bash
# 示例
gxx-abap config --host <host> -u BC01 -p <密码> -c 100
gxx-abap config --show
gxx-abap config --show --json
```

### ping

测试与 SAP 系统的连接。

```bash
gxx-abap ping
gxx-abap ping --json
```

**JSON 返回**：`{ status, sid, basisVersion, host, port, user }`

### status

查看当前连接状态。

```bash
gxx-abap status
gxx-abap status --json
```

### clear

清除所有配置信息（删除 `~/.gxx-abap/config.json`）。

```bash
gxx-abap clear
```

---

## 对象操作

### ls

搜索 ABAP 对象。

```bash
gxx-abap ls <pattern>
gxx-abap ls Z*                   # 搜索所有 Z 开头对象
gxx-abap ls ZPPR090              # 精确搜索
gxx-abap ls Z* --json
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `<pattern>` | 是 | 对象名称，支持 `*` 通配符 |

**JSON 返回**：`{ search, count, objects: [{ name, type }] }`

type 映射：`PROG/P` 程序、`CLAS/OC` 类、`INTF/OI` 接口、`TABL/DT` 表、`FUGR/FF` 函数模块、`DDLS/DF` CDS 视图 等。（注：`ls` 搜不到 FUGR/F 函数组）

### cat

查看对象源码。

```bash
gxx-abap cat <对象名>
gxx-abap cat zppr090                          # 自动识别为程序
gxx-abap cat zcl_hello -t class               # 指定为类
gxx-abap cat ekko -t table                    # 表（必须手动指定）
gxx-abap cat zppr090 -t program --json
gxx-abap cat ZTEST -t fm                        # 函数模块（自动发现函数组）
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `<path>` | 是 | 对象名 |
| `-t, --type <type>` | 否 | 类型，不传则自动识别 |

**-t 可选值**：`class` `program` `interface` `table` `fm`

**自动识别规则**：
- `CL_*` / `ZCL_*` → `class`
- `IF_*` / `ZIF_*` → `interface`
- 其他 → `program`


> **函数模块 (fm)**：创建需通过 SE37 手动完成。`cat`/`put`/`activate`/`refs` 用 `-t fm`（自动发现函数组）。接口签名（`*"` 注释块）不能 PUT 写入，需在 SE37 修改。

### create

创建 ABAP 对象。

```bash
gxx-abap create <name> -t <type>
gxx-abap create YTEST -t program
gxx-abap create ZCL_HELLO -t class --description "Hello World"
gxx-abap create ZIF_MY_INTF -t interface --package ZAI
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `<name>` | 是 | 对象名称（自动转大写） |
| `-t, --type <type>` | 是 | `class` `program` `interface` |
| `--description <desc>` | 否 | 对象描述 |
| `--package <pkg>` | 否 | 包名，默认 `$TMP` |
| `--transport <tr>` | 否 | 传输**任务号**（非请求号，SE10 展开可见） |

### put

写入源码（锁定 → 写入 → 解锁，写入后自动调用解锁接口清理残留锁）。

```bash
gxx-abap put <对象名> <文件路径> -t <type>
cat mycode.abap | gxx-abap put ztest -t program    # 管道传入
gxx-abap put ztest -t program --force-unlock       # 强制解锁后写入
gxx-abap put ZTEST -t fm                        # 函数模块（自动发现函数组）
gxx-abap put ztest -t program --transport DS4K939701  # 指定传输号写入
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `<path>` | 是 | 对象名 |
| `[file]` | 否 | 源码文件路径，不传则从 stdin 读取 |
| `-t, --type <type>` | 否 | `class` `program` `interface` `fm` |
| `--transport <tr>` | 否 | 传输请求号（不指定则自动检测对象已有的传输号） |
| `--force-unlock` | 否 | 写入前先强制解除残留锁 |

### unlock

调用 AI_PUT_UNLOCK 接口释放对象锁（SE80/SE37 编辑残留锁）。

```bash
gxx-abap unlock <对象名>
gxx-abap unlock ZPPR090
gxx-abap unlock ZZZ_TEST_API3 --json
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `<name>` | 是 | 对象名 |

**JSON 返回**：`{ STATUS, MSGTXT }`

---

### activate### activate

激活对象（含语法检查，激活失败时返回具体错误行号和消息）。

```bash
gxx-abap activate <对象名>
gxx-abap activate zcl_hello -t class
gxx-abap activate zppr090 -t program --json
gxx-abap activate ZTEST -t fm                   # 函数模块（自动发现函数组）
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `<path>` | 是 | 对象名 |
| `-t, --type <type>` | 否 | `class` `program` `interface` `fm` |

**JSON 返回**：`{ success, checkExecuted, activationExecuted, errors: [{ type, line, text }] }`

---

## 传输管理

### transport

管理传输请求。

```bash
gxx-abap transport list               # 列出当前用户的传输请求
gxx-abap transport object <对象名>    # 查看对象关联的传输请求
```

| 子命令 | 说明 |
|------|------|
| `list` | 列表（请求号、状态、负责人、描述） |
| `object <对象名>` | 查询对象绑定的传输请求号及状态 |

```bash
# 示例
gxx-abap transport list
gxx-abap transport object ZPPR090
gxx-abap transport list --json
```

---

## 代码检查

### meta

查看表结构、结构字段或数据元素属性。表/结构支持 `include` 自动递归展开。

```bash
gxx-abap meta <名称>
gxx-abap meta ekko                 # 表 — 字段列表（含类型、长度、描述）
gxx-abap meta ZAIS_GET_EKPO        # 结构 — 字段列表
gxx-abap meta ZE_SCHEMA            # 数据元素 — 类型、域、标签
gxx-abap meta ekko --json
gxx-abap meta MARC --field PMATN --json
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `<name>` | 是 | 表名、结构名或数据元素名 |
| `--field <name>` | 否 | 按字段名过滤，避免大表全量输出截断 |

**JSON 返回（表/结构）**：`{ table, fields: [{ field, dataElement, type, length, decimals, description }] }`

**JSON 返回（数据元素）**：`{ name, description, dataType, typeName, length, shortLabel }`

### refs

Where-Used 引用查询，查找引用了指定对象的所有程序、类、函数等。

```bash
gxx-abap refs <对象名>
gxx-abap refs ZBCT_INTF_MCP -t table
gxx-abap refs ZDOWNLOAD_ABAP --json
gxx-abap refs ZTEST -t fm                       # 函数模块（自动发现函数组）
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `<name>` | 是 | 对象名 |
| `-t, --type <type>` | 否 | `program` `class` `table` `interface` `function` `fm` |

**JSON 返回**：`{ object, type, count, references: [{ name, type, description, uri }] }`

类型映射：`PROG/P` 程序、`PROG/I` Include、`CLAS/OC` 类、`FUGR/F` 函数组、`FUGR/FF` 函数模块、`TABL/DT` 表 等。

### dump

查看短转储（ST22 DUMP）。

```bash
gxx-abap dump                         # 列出所有 DUMP
gxx-abap dump <ID>                    # 查看指定 DUMP 详情
gxx-abap dump --from 20250701         # 指定起始时间过滤
gxx-abap dump <ID> --json
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `[id]` | 否 | DUMP ID（14位时间戳），不传则列出所有 |
| `--from <time>` | 否 | 起始时间 `YYYYMMDDHHMMSS` |

**JSON 返回（详情）**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `dumpId` | string | DUMP ID |
| `error` | string | 错误类型（如 `ASSIGN_TYPE_CONFLICT`） |
| `program` | string | 出错程序名 |
| `author` | string | 用户 |
| `datetime` | string | 发生时间（ISO 8601） |
| `termination` | object | `{ uri, line }` — 出错源码位置 |
| `chapters` | object | 按分类分组的章节 `{ "ABAP Developer View": [{ title, line }], ... }` |
| `chapterList` | array | 扁平列表 `[{ title, category, line }]` |
| `content` | string | 原始正文 |
| `cleanedContent` | string | 清洗后正文（去边框、空格、空行） |
| `sections` | array | 结构化解析 `[{ title, body }]`，63 章节 |

---

## 开发辅助

### message

查看消息类的消息文本。

```bash
gxx-abap message <消息类名>
gxx-abap message 00                # 系统消息类（897 条）
gxx-abap message ZPP_MSG001 --json
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `<name>` | 是 | 消息类名（如 `00`、`ZPP_MSG001`） |

**JSON 返回**：`{ name, count, messages: [{ number, text }] }`

### texts

查看或修改文本元素（选择文本、文本符号、标题）。

```bash
# 查看
gxx-abap texts <对象名>
gxx-abap texts ZDOWNLOAD_ABAP
gxx-abap texts zcl_hello -t class --json

# 写入
gxx-abap texts <对象名> --set selections --file <路径>
echo "P_NAME  =项目名" | gxx-abap texts YTEST --set selections
gxx-abap texts YTEST --set selections --file sel.txt --force-unlock
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `<name>` | 是 | 对象名 |
| `-t, --type <type>` | 否 | `program` `class` `function` |
| `--json` | — | JSON 输出（查看模式） |
| `--set <sub>` | 写入 | 子对象：`selections` `symbols` `headings` |
| `--file <path>` | 写入 | 文件路径，不传则从 stdin 读取 |
| `--force-unlock` | 写入 | 写入前强制解除 GUI 残留锁 |

**JSON 返回（查看）**：`{ name, selections: [{ key, text }], symbols: [...], headings: [...] }`
**写入文件格式**：每行 KEY =VALUE（KEY 和 = 间用空格补齐对齐）
**symbols写入文件格式**：首行 `@MaxLength:N`（N=最大文本字节数），后续行 `KEY=VALUE`（单等号无空格）。

```
@MaxLength:12
001=公司代码
002=公司名称
```

> 注意：symbols 只支持**更新**已存在的文本符号，不支持新建（DS 512）。新建需通过 SE80。selections 和 headings 无此限制。

---

## 系统信息

### system

查看系统信息。

```bash
gxx-abap system info               # 基本信息
gxx-abap system components         # 已安装组件
gxx-abap system components --json
```

| 子命令 | 说明 |
|------|------|
| `info` | SID、SAP_BASIS 版本、Kernel 版本、服务器名 |
| `components` | 已安装 SAP 组件（ID、Release、Patch、SP Level、描述） |

**JSON 返回（info）**：`{ sid, basisVersion, kernel, serverName }`

**JSON 返回（components）**：`{ count, components: [{ id, release, patch, spLevel, description }] }`

---

## JSON 输出

所有命令均支持 `--json` 参数，输出标准 JSON 格式，方便脚本和 AI Agent 调用。

```bash
gxx-abap meta ekko --json | jq .fields[0]
gxx-abap dump 20260716... --json | jq .termination
```
