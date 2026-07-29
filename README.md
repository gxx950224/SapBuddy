# AbapBuddy

SAP ABAP AI 辅助开发工具箱。通过自然语言对话编写 ABAP 代码，支持直接连接 SAP 系统创建、修改、激活程序。

## 快速开始

### 方式一：直接运行（源码）

```bash
# 启动 Web IDE
双击 AbapBuddy.bat
# 浏览器打开 http://127.0.0.1:7400
```

### 方式二：桌面应用（需先打包）

```bash
# 运行 build.bat 生成安装包
# 安装后从开始菜单启动
```

首次使用先配置 API Key 和 SAP 连接。

## 配置

### 1. API Key（必需）

编辑 `.pi/auth.json`：

```json
{
  "deepseek": {
    "type": "api_key",
    "key": "你的DeepSeek API Key"
  }
}
```

### 2. SAP 连接

编辑 `.gxx-abap/config.json`：

```json
{
  "host": "10.x.x.x",
  "user": "你的SAP账号",
  "pass": "密码",
  "client": "100",
  "language": "ZH"
}
```

验证连接：

```bash
# 双击 gxx-abap.bat，然后
gxx-abap> ping
```

### 3. MCP 服务器（可选）

编辑 `.pi/settings.json` 的 `mcpServers` 字段，可接入自定义 MCP 工具。

## 功能

- **对话式 ABAP 开发** — 用中文描述需求，AI 直接生成代码并写入 SAP
- **代码审查** — 自动审查 ABAP 代码并生成 HTML 报告
- **程序逻辑详解** — 分析现有程序逻辑，用业务语言输出说明
- **MCP 扩展** — 支持挂载外部 MCP 服务器扩展能力
- **Electron 桌面壳** — 可选桌面应用封装

## 目录结构

```
AbapBuddy/
  AbapBuddy.bat           ← 启动 Web IDE（双击）
  gxx-abap.bat            ← SAP CLI 工具
  build.bat               ← 生成 exe 安装包
  webide/                 ← 后端服务 + 前端页面
  gxx-abap/               ← SAP ADT 协议客户端
  .pi/                    ← AI 配置 + 技能 + 提示词
    auth.json             ← API Key
    settings.json         ← 模型、MCP 配置
    skills/               ← AI 技能
    prompts/              ← 提示词模板
  node/                   ← 内嵌 Node.js 运行时
  output/                 ← 生成的代码和报告
  package/                ← Electron 打包配置
```

## 系统要求

- Windows 10+
- 内嵌 Node.js，无需额外安装
- 需要 DeepSeek API Key
- 需要 SAP 账号（SAP 操作功能）
# AbapBuddy
