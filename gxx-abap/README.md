# gxx-abap

SAP ABAP ADT 命令行工具 — 从终端操作 SAP ABAP 开发系统。

## 安装

```bash
npm install -g gxx-abap
```

> 安装后如果提示 `'gxx-abap' 不是内部命令`，执行以下命令后重开 CMD：
> ```cmd
> setx Path "%Path%;%APPDATA%npm"
> ```

## 快速开始

```bash
gxx-abap config --host <host> -u <user> -p <password> -c <client>
gxx-abap ping
gxx-abap ls Z*
gxx-abap cat zppr090
gxx-abap meta ekko
```

## 命令列表

共 17 条命令，支持 `--json` 输出。详见 [COMMANDS.md](./COMMANDS.md)。

| 分类 | 命令 | 说明 |
|------|------|------|
| 连接 | `config` `ping` `status` `clear` | 配置、测试、查看连接 |
| 对象 | `ls` `cat` `create` `put` `activate` | 搜索、查看、创建、写入、激活 |
| 传输 | `transport` | 传输请求管理 |
| 查询 | `meta` `refs` `dump` | 表结构、引用查询、DUMP |
| 辅助 | `message` `texts` | 消息类、文本元素 |
| 系统 | `system` | 系统信息 |

## 配置

连接信息保存在 `~/.gxx-abap/config.json`。

```bash
gxx-abap config --host <host> -u BC01 -p xxx -c 100
gxx-abap config --show
```
