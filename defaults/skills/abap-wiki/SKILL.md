---
name: abap-wiki
description: >-
  当 `mcp_abap_wiki_*` 工具可用（用户已在设置-MCP 配置了 abap_wiki 知识库服务）
  且用户询问某个 SAP 对象（程序/表/函数模块/类/CDS 视图/增强/事务码等）的用途、
  业务逻辑、解释/分析、依赖、影响面时触发本技能。优先于读原始源码：
  从 abap_wiki 知识库（公司 S/4HANA 开发系统自开发对象的已分析资料，页面英文）
  查取页面，用双括号链接引用出处，并区分「知识库里写的」与「系统上查到的」。
  触发关键词：查知识库、查 wiki、这个程序是做什么的、看下...逻辑、解释/分析一下、
  XXX 的分析、依赖谁、被谁用、修改影响哪些程序。
agent_created: true
disable: false
---

# abap_wiki 知识库查询

公司 S/4HANA 开发系统**自开发 SAP/ABAP 对象**（程序、表、函数模块、类、增强、
CDS 视图等）的技术知识库。页面内容全部是**英文**。每个对象已做代码分析、
业务功能分析，结论附可信度标记——查它比翻原始代码又快又准。

## 何时使用

- 用户询问某个 Z*/Y* 对象（或知识库里收录的标准对象）的用途/业务逻辑/分析结论
- 用户想了解对象间的依赖（谁依赖它、它被谁用）
- 回答前先查知识库，避免每次从头读原始源码（省 token、有据可查）
- ⚠️ 知识库没收录/只有 L0 占位页的对象，如实说「没有分析」，再走内置 SAP 工具读源码

## 前置条件

- `mcp_abap_wiki_*` 工具已注册（用户已在设置-MCP 配置 abap_wiki 服务，底层为
  obsidian-vault-mcp，端口 8766）。浏览动作**一律用下面这些工具**：
  - `mcp_abap_wiki_list_notes(path)`：列出某目录下的笔记/子目录（非递归），用于浏览目录结构
  - `mcp_abap_wiki_search_notes(folder/text/tag/...)`：按目录/全文/标签找对象，返回路径
  - `mcp_abap_wiki_read_note(path)`：读单页完整内容
  - `mcp_abap_wiki_read_multiple_notes(paths, metadataOnly)`：批量读多页；`metadataOnly:true`
    只返回 frontmatter/链接，用来看一批页面的 `doc_level` 再决定精读哪些（省 token）
- ⚠️ **知识库只读**：只使用上面 4 个读/浏览工具。**禁止**调用 `mcp_abap_wiki_` 的写工具
  （`create_note`/`append_to_note`/`update_note`/`patch_note`/`delete_note`/`rename_note`）——
  知识库由 abap_wiki 引擎生成维护，AI 不得修改。若用户要求改 wiki，直接说明"知识库只读，
  不做修改"。
- 若 MCP 未配置但本机存在 vault 目录（如 `~/Desktop/abap_wiki/abap_wiki/`），
  也可用 read 工具直接读其中的 Markdown 文件（路径规则见下）。

## 怎么浏览（导航模式，从粗到细）

1. **先读总索引** `index.md`：按包和文档级别列出全部对象。
   → `read_note(path="index.md")` 或 `search_notes(folder="")`。
2. **再读包索引页** `_packages/<包名>.md`（如 `ZFI001`）：
   列出该包所有对象的 `[[链接]]` 与文档级别（L0/L1/L2）。
   → `read_note(path="_packages/ZFI001.md")`。
3. **最后打开具体对象页** `<包名>/<对象类型>-<对象名>.md`，
   例如 `ZFI001/program-ZFIR015_BANK_SERCH.md`、`ZFI001/cds-view-ZFIV_ACDOCT_DDL.md`。
   → `read_note(path="ZFI001/program-ZFIR015_BANK_SERCH.md")`。

找对象时先 `search_notes(folder="<包名>")` 或 `list_notes(path="<包名>")` 缩小范围；
标准包（AA/AB/...）里大多是 L0 空壳页，先看 `doc_level` 再决定是否精读。

页面之间用**双括号链接**互相引用，例如 `[[program-ZFIR015_BANK_SERCH]]`
对应文件 `ZFI001/program-ZFIR015_BANK_SERCH.md`。只看到链接、不知道对象在哪个包时，
去 `index.md` 或页面头部元数据里找 `devclass` 字段。

## 页面头部元数据（frontmatter）

关键字段：

- `sap_type`：对象类型（program/table/class/...）
- `sap_name`：对象名
- `devclass`：所属包
- `doc_level`：文档级别（见下）
- `depends_on`：依赖了谁
- `used_by`：被谁使用
- `bug_total`：疑似 bug 数量
- `raw_source_status`：源码状态（available/partial/missing）

`doc_level` 含义：

- `L0`：只有占位/元数据。纯字典类对象（如数据元素 data-element）到 L0 就是终点。
- `L1`：有代码分析，分析内容直接写在同一个页面上。
- `L2`：在 L1 基础上叠加了业务功能分析。

## 页面内容（L1 页面包含的章节）

摘要 / 功能范围 / 选择屏幕 / 表单分析 / 输出映射 / 外部依赖（表、函数模块、消息类）/
性能 / 错误处理 / 遗留业务疑问 / 后续建议 / 疑似 bug 候选。

结论的可信度标记：

- `[VERIFIED: 路径:N-M]`：由源码第 N-M 行证实（路径可能已过期，仅供参考）。
- `[INFERRED]`：推断得出。
- `[UNVERIFIABLE]`：需要连线上系统或问业务专家才能确认。

## 重点看哪里

- 核心是**自开发包**（`Z*`/`Y*`，如 `ZBC`、`ZFI001`、`ZITS`、`ZMM001`、`ZPP001`、
  `ZQM001`、`ZSD001` 等）；`_TMP_` 里是未归包的 Z 对象，同样是自开发内容。
- 其他标准包目录（AA、AB 等）大多是**标准 SAP 对象的空壳页**（L0），价值低；
  除非问题正好是关于已收录的标准对象，否则跳过。

## 回答规则

- 用双括号页面链接（例如 `[[program-ZFIR015_BANK_SERCH]]`）引用你参考的页面。
- **不要编造**代码、字段或行为。如果某个对象只有 L0 页或库里没有，就明说「没有分析」。
- **区分「知识库里写的」和「系统上查到的」**：如果你在线上系统核实过某个事实，
  要在回答里说明来源；知识库结论标注可信度标记（VERIFIED/INFERRED/UNVERIFIABLE）。
