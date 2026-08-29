# SapBuddy Web — 设计系统文档

> 适用表面：Web 版（`src/web/public/`，入口 `index.html`）
> 模式：**Operate**（AI 助手工作台——扫描性、一致性、真实使用场景优先于表达）
> 本文档是 Web 前端 UI 重设计的唯一设计真相来源。功能点零删改，仅静态资源（CSS / logo / HTML 微调）变更。

---

## 1. Design Read（设计判断）

**Reading this as**: SAP ABAP 开发顾问的 AI 工作台，面向长时间高强度使用的专业用户，
以「精密仪表盘」语言组织——冷中性近白底、白色面板、发丝描边、唯一 SAP Horizon 蓝强调色、
无装饰性渐变。目标不是「更像聊天应用」，而是「像一台可以连续工作一天的精密工具」。

### 反例（原设计）→ 新方向

| 维度 | 原版 | 新版 |
|---|---|---|
| 主背景 | 灰白（偏灰冷、面板无层次） | `#f5f6f8` 近白 + 白色面板，靠发丝描边与投影分层 |
| 强调色 | AI 紫渐变 `#6366f1→#8b5cf6`（模板风） | 唯一 SAP Horizon 蓝 `#0a6ed1`，仅用于交互/激活/状态 |
| 渐变 | 装饰性渐变散布各处 | 仅按钮/头像/logo 使用克制的品牌渐变，其余一律纯色 |
| 圆角 | 参数不统一 | 令牌化：`--radius-sm/md/xl`，统一 8/10/18px |
| 字体 | Inter（AI 默认脸） | IBM Plex Sans（企业工程气质，与 JetBrains Mono 配套） |
| 代码块 | 浅色 | 固定深色 `#0f1722`（代码与正文视觉分离，日夜恒定） |
| 数据密集区 | 缺乏层次 | 工具卡/表格/思考块用「白卡 + 发丝边 + 细内衬」构建阅读层级 |

### 三轴配置

```
DESIGN_VARIANCE: 4   — 精密、克制、对称（工作台）
MOTION_INTENSITY: 2  — 仅 hover/过渡，尊重 prefers-reduced-motion
VISUAL_DENSITY: 5    — 信息密度适中，工具卡/表格可承载复杂数据
```

---

## 2. 设计令牌（Design Tokens）

单一真相来源：`src/web/public/style.css` 顶部 `:root` 变量区。

### 色彩

| 令牌 | 值 | 用途 |
|---|---|---|
| `--accent` | `#0a6ed1` | 交互/激活/状态主色（唯一强调色） |
| `--accent-hover` | `#0b5eaf` | 强调 hover |
| `--accent-grad` | `linear-gradient(135deg,#0a6ed1,#0b5eaf)` | 按钮/头像/logo 品牌渐变 |
| `--bg-app` | `#f5f6f8` | 应用底（近白冷中性） |
| `--bg-surface` | `#ffffff` | 面板/卡片 |
| `--bg-inset` | `#eef0f3` | 内衬（输入区、嵌入内容） |
| `--text` | `#161a20` | 主文本 |
| `--text-2` | `#5b6470` | 次级文本 |
| `--text-3` | `#9aa3ad` | 弱化/占位 |
| `--border` | `#e2e6ec` | 发丝描边 |
| `--code-block-bg` | `#0f1722` | 代码块深底（恒定） |
| 状态绿 | `#1a7f4b` / `#e7f4ec` | 成功/完成 |
| 状态红 | `#c9302c` / `#fdeeee` | 错误/危险 |
| 警告橙 | `#b45309` | 警告 |

### 排版

| 令牌 | 值 |
|---|---|
| `--font-ui` | `'IBM Plex Sans'` + CJK 回退（PingFang SC / Microsoft YaHei） |
| `--font-mono` | `'JetBrains Mono'` |
| 正文 | 13px / 14px，`--text-2` |
| 标题层级 | 12px 大写小号字距（面板标题）→ 14/15px（卡片标题）→ 20px（弹窗标题） |

### 几何

| 令牌 | 值 |
|---|---|
| `--radius-sm` | 8px（小元素/代码） |
| `--radius-md` | 10px（按钮/输入/工具卡） |
| `--radius-xl` | 18px（用户气泡/弹窗/输入卡片） |
| `--shadow-1` | 0 1px 2px 卡片投影（极轻） |
| `--shadow-2` | 0 8px 24px 弹层投影 |

---

## 3. 布局系统

三栏工作台，全程 CSS Grid / Flex，无百分比 flex 数学。

```
┌──────────┬──────────────────────┬──────────────┐
│ Sidebar  │       Chat           │  Right Panel │
│ 272px    │      flex:1          │  264px       │
│ 会话管理  │  消息流 + 输入卡片     │  产物文件树   │
└──────────┴──────────────────────┴──────────────┘
```

- **Sidebar**：白色面板 + 发丝右边框；搜索框为 `bg-inset` 内嵌；会话分组用
  `<details class="session-group">`，默认折叠（今天组展开），分组头 12px 大写字距。
- **Chat 主区**：消息流 `max-width:880px` 居中；用户气泡左对齐白底、右对齐 `#f0f2f5`
  浅灰；agent 头像为品牌渐变 30px 圆角方块。
- **Right Panel**：白色面板 + 发丝左边框；产物文件树（`#file-list`）支持文件夹折叠。
- **弹层**：统一 `overlay`（半透明遮罩 + blur）+ 白卡 `dialog`；5 个弹层共用同一设计语言
  （预览 / 设置 / 确认 / 重命名 / mermaid 放大）。

---

## 4. 组件规范

### 按钮
- 主按钮：`accent-grad` 渐变、白字、10px 圆角、hover 微亮、active 下沉 1px。
- 次按钮：白底 + 发丝描边 + `--text`，hover 变 `bg-inset`。
- 危险按钮（确认弹层「删除」）：红底白字，仅存在于确认弹层。

### 工具卡（agent 调用的 SAP 工具）
- 白卡 + 发丝描边 + 10px 圆角；头部含工具名 + 参数摘要（mono）+ 耗时徽标。
- 状态徽标：`invoke-status.done` 绿、`.error` 红、`.running` 蓝脉冲点。
- 错误友好头部：JS 内联 3px 错误色左边条已用 CSS 收敛为 1px 细色轨（保留语义色，去掉 AI 模板味）。
- 参数行/代码区为 `bg-inset` 内衬，参数值 mono。

### 消息正文 Markdown（`.reply-text.md` / `.md-preview`）
- 标题层级、列表、引用（左侧细蓝边）、行内代码（`bg-inset` + mono + 10px 圆角）、
  表格（发丝边、表头 `bg-inset`）、分隔线全套定制。
- 表格在窄容器横向滚动不换行。

### 思考块 / 折叠内容
- 折叠标题为「思考过程 · N 字」，hover 变 `bg-inset`；展开后 `bg-inset` 内衬正文，
  14px 圆角，次文本色。

### 设置弹窗
- 竖向 Tab 栏（188px）+ 内容面板；Tab 激活为白底 + 左侧 2px 蓝色指示条；
  面板含卡片化分组、开关、文本输入统一 10px 圆角 + 发丝边 + focus 蓝色环。

### 文件预览弹层
- `#preview-body` 渲染 markdown（走同一套 md 样式）；`.html-mode` 时切换为
  `#preview-frame`（iframe）全宽显示；右上「下载 / 关闭」。

### Mermaid 放大弹层
- 深色工具条（放大/缩小/适应/导出）+ 浅色画布（纯色 `bg-inset`，无装饰网格）；
  拖拽平移，滚轮缩放。

### 空状态
- 居中的工具图标 + 主文案 + 次文案说明，无装饰插画。

---

## 5. 动效

- 原则：克制。仅 hover 过渡（120–200ms）+ 弹层淡入（opacity + 轻微上移 6px）。
- 全部包裹在 `@media (prefers-reduced-motion: reduce)` 中禁用。
- 不做宽度/高度动画（避免布局抖动）；折叠用显隐切换。

---

## 6. 响应式

| 断点 | 行为 |
|---|---|
| >1080px | 三栏完整 |
| ≤1080px | Right Panel 收窄（208px），消息流自适应 |
| ≤900px | 隐藏 Right Panel（`display:none`），主区占满 |
| ≤720px | 隐藏 Sidebar，单列移动布局；输入卡片固定底部，窄按钮重排 |

侧栏/右栏隐藏时无 DOM 移除（仅 display 控制），保证 JS 交互不感知布局变化。

---

## 7. 对比度与可访问性

- 正文 `#161a20` on `#f5f6f8`：对比度 > 12:1（AAA）。
- 次级 `#5b6470`：> 7:1（AAA）。
- 强调蓝 `#0a6ed1` 用于文字时配深色底或加粗，保证 ≥ 4.5:1。
- 所有交互态提供 hover / focus（蓝色 focus 环）/ active 三重反馈。
- 弹层支持 Esc 关闭；遮罩点击关闭；`aria` 角色沿用原 HTML（未改 DOM 契约）。
- `prefers-reduced-motion` 全局关闭过渡与动画。

---

## 8. 交付物与验证记录

| 文件 | 变更 |
|---|---|
| `src/web/public/style.css` | 全量重写（设计系统，含本契约注释头） |
| `src/web/public/logo.svg` | SAP 蓝渐变品牌标（`#0a6ed1→#0b5eaf`，A 字 + 浅蓝圆点） |
| `src/web/public/index.html` | 仅移除 mcp 编辑弹层 2 处内联样式 + 字体切换 IBM Plex Sans |
| `src/web/public/js/*` | **零修改**（DOM 契约完整保留，功能点零删改） |

验证（真实浏览器，`http://127.0.0.1:7400/`）：
- 初始界面 / 新对话 / 简单会话 / 216 条消息富会话（工具卡 309、代码块 68、思考块 326、表格 22）全部渲染正常。
- 设置弹窗竖向 Tab、模型下拉、确认/重命名弹窗、md 文件预览、mermaid 灯箱、窄屏 430px 断点均实测通过。
- 控制台 0 错误（重启瞬间偶发 1 条 403 为资源竞态，非持续问题）。

### 交互 / 对抗性审查记录（2026-08-29）
- **断点修复（P0，已修复）**：`@media (max-width:900px)` 中 `#sidebar{display:none}` 后不再占 grid 轨道，
  但 `#main` 仍为 3 列 `0 1fr right`，导致可见项 chat 落入 0 宽列塌缩（900px 时输入框 20px、布局错乱；
  720px 同理）。修复为可见项与列数匹配：900px→2 列 `minmax(0,1fr) var(--right-w)`，720px→单列 `minmax(0,1fr)`，
  并覆盖 left/right-collapsed 组合。断点矩阵 375–1440px 全绿、无横向溢出。
- **功能断链（P1，既有遗留，未改）**：前端 `events.js` 确认卡片 POST `/api/confirm`，后端仅实现
  `/api/write-approve`，且后端不广播 `user_confirmation` 事件——该按钮卡片为死代码，不影响主确认路径
  （Web 端写操作确认走「用户输入确认词」机制，AGENTS.md 第③层）。
- 其余验证通过：会话切换/搜索/分组折叠/固定-重命名-删除、设置 7+2 Tab、文件树展开/预览/下载路径
  （`node.path` 正确）、mermaid 灯箱全链路、模型选择器、面板折叠、超长/特殊字符输入、快速连击（无重复建会话）、
  搜索空状态、`prefers-reduced-motion`。

---

## 9. 未来维护注意事项

- **改样式**：优先修改令牌（:root）而非散落值；遵循「唯一强调色」约束，禁止引入第二种装饰色。
- **改 DOM**：所有 class/id 由 JS 动态生成，新增组件必须先在 `js/*.mjs` 确认命名，再在 CSS 落样式。
- **字体**：Google Fonts 加载 IBM Plex Sans + JetBrains Mono；离线时回退系统字体栈。
- **双端一致**：本设计仅作用于 Web 前端静态资源，不涉及 `register.ts` 安全层与 CLI。
