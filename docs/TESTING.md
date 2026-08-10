# 测试指南

本指南覆盖 SapBuddy 的手动测试流程（CLI + Web），适用于开发验证与发布前回归。

## 前置条件

- Node.js ≥ 20
- 已执行 `npm install` 与 `npm run build`
- 已配置：
  - `.pi/auth.json` —— AI 模型 API Key
  - `connections.json` —— SAP 连接（ADT 需在 SICF 激活 `/sap/bc/adt`）

## 1. 环境自检

```bash
node cli.mjs doctor
```

预期输出：

```
Node: v24.x.x
SAP 工具: 43 个已加载
API Key: ✅ 已配置
默认模型: deepseek/deepseek-v4-flash
SAP 连接: ✅ 1 个已配置
```

> 任一项异常请先解决再继续（详见[故障排查](#6-故障排查)）。

## 2. 工具清单

```bash
node cli.mjs tools
```

预期：43 个工具（37 只读 + 5 写操作）。

| 分组 | 数量 | 代表工具 |
|---|---|---|
| 只读 | 37 | search_abap_objects / get_abap_object_lines / execute_data_query / run_atc_analysis / run_unit_tests / find_where_used / get_version_history / analyze_abap_dumps … |
| 写操作 | 5 | create_object_programmatically / abap_activate / replace_string_in_abap_object / create_test_include / update_object_description |

> 写操作默认被 `connections.json` 的 `security.readOnly: true` 禁用。测试写操作前将其改为 `false`。

## 3. CLI 测试

### 3.1 单次提问

```bash
node cli.mjs "搜索 ZCL_* 类，列出前 5 个"
node cli.mjs "读取 ZAIR004 源码并解释逻辑"
node cli.mjs "查询 T001 表前 5 条"
node cli.mjs "ZCL_AI004 被哪些对象引用"
```

预期：AI 自动选择合适的 SAP 工具并返回真实结果。

### 3.2 交互式对话

```bash
node cli.mjs chat
```

| 命令 | 说明 |
|---|---|
| `输入任意问题` | 对话（流式输出） |
| `/tools` | 查看工具清单 |
| `/help` | 帮助 |
| `/exit` | 退出 |

### 3.3 JSON 输出（脚本集成）

```bash
node cli.mjs --json "只回复 OK"
# → {"answer":"OK"}
```

## 4. Web 版测试

```bash
node cli.mjs web
# 浏览器打开 http://127.0.0.1:7400
```

验证项：

- [ ] 首页正常加载（聊天界面）
- [ ] 聊天可发送并流式回复
- [ ] 深/浅色主题切换
- [ ] 工具调用可视化（如状态栏显示工具名）
- [ ] 会话历史可切换

接口自检（可选）：

```bash
curl http://127.0.0.1:7400/api/tools     # 43 个工具
curl http://127.0.0.1:7400/api/state     # 会话状态
curl -N http://127.0.0.1:7400/api/events # SSE 事件流
```

## 5. 回归测试矩阵

建议发布前执行以下矩阵（SAP 系统需在线）：

| # | 场景 | 工具 | 预期 |
|---|---|---|---|
| 1 | 搜索对象 | search_abap_objects | 返回真实对象列表 |
| 2 | 读取源码 | get_abap_object_lines | 完整源码（类支持方法提取） |
| 3 | 源码内搜索 | search_abap_object_lines | 命中行+上下文 |
| 4 | 对象信息 | get_abap_object_info | 元数据/结构 |
| 5 | 引用分析 | find_where_used | 引用列表 |
| 6 | SQL 查询 | execute_data_query | 表格数据 |
| 7 | 系统信息 | get_sap_system_info | S/4HANA 版本等 |
| 8 | ATC 检查 | run_atc_analysis | 问题列表（或"未发现问题"） |
| 9 | 单元测试 | run_unit_tests | 方法级结果 |
| 10 | 版本历史 | get_version_history | 版本列表/对比 |
| 11 | dump 分析 | analyze_abap_dumps | ST22 列表/详情 |
| 12 | 传输请求 | manage_transport_requests | 用户请求列表 |
| 13 | 文本元素 | manage_text_elements | 读写 symbols/selections |
| 14 | 域属性 | update_domain_properties | 符号/大小写更新 |
| 15 | 文本池翻译 | translate_text_pool | 指定语言写入 |
| 16 | 创建对象 | create_object_programmatically | 对象创建成功 |
| 17 | 编辑+激活 | replace_string / abap_activate | 保存、语法检查、激活 |
| 18 | 描述更新 | update_object_description | 描述变更 |

> 写操作测试（16-18）请使用临时对象（如 `ZTEST_xx`），测试后删除。

## 6. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `403 Request not allowed` | 模型名无效或 Key 错误 | 检查 `.pi/settings.json` 的 `defaultModel`（应为 `deepseek-v4-flash` 等 pi 内置模型）与 `.pi/auth.json` |
| 工具未注册（只有 4 个内置） | 未编译或注册失败 | 执行 `npm run build`；检查 `[sapbuddy] 已注册 43 个` 日志 |
| SAP 连接超时 | 网络/系统未启动 | 确认 SAP 可达、ADT 服务正常；自签名证书需 `ssl.allowSelfSigned` |
| 单次提问无输出 | 模型未显式解析 | 确认 `agent-core.mjs` 中模型解析逻辑；检查错误事件 |
| Web 端口占用 | 7400 被占用 | `node cli.mjs web --port 7401` |

## 7. 自动化（建议）

发布前可补充：

```bash
# 冒烟测试（无 SAP 依赖部分）
node cli.mjs tools
node cli.mjs doctor
node cli.mjs --json "只回复 OK"
```

如需 CI 集成，可基于 `doctor` + 工具清单作为基础检查。
