# 致谢与参考

本项目在设计与实现过程中参考了以下开源项目，特此致谢：

## 核心参考

### [marcellourbani/vscode_abap_remote_fs](https://github.com/marcellourbani/vscode_abap_remote_fs)（ABAP Remote FileSystem）

SAP ABAP 的 VS Code 扩展。本项目的 SAP 工具集（搜索、读源码、where-used、ATC、单元测试、SQL 查询、传输请求、文本元素、版本历史、ST22 dump 分析、调试等）的**功能设计与 ADT 交互模式**大量参考了该项目及其内置的语言模型工具（LM Tools），并对齐其工具语义。

### [marcellourbani/abap-adt-api](https://github.com/marcellourbani/abap-adt-api)

SAP ADT 协议的 Node.js 客户端库，本项目直接的运行时依赖（`dependencies`），用于与 SAP 系统（`/sap/bc/adt`）通信。

## 运行时依赖

| 依赖 | 说明 |
|---|---|
| [@earendil-works/pi-coding-agent](https://github.com/badlogic/pi-mono) | AI Agent 引擎（会话、模型、工具框架） |
| [abap-adt-api](https://github.com/marcellourbani/abap-adt-api) | SAP ADT 协议客户端 |
| [zod](https://github.com/colinhacks/zod) | 工具参数 schema 校验 |
| [typebox](https://github.com/sinclairzx81/typebox) | 工具参数类型（pi 工具注册） |

## License

本项目的代码基于 MIT License 发布（见 [LICENSE](./LICENSE)），引用项目各自的 License 以对应项目为准。
