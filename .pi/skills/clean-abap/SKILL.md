---
name: clean-abap
description: >-
  Applies the SAP Clean ABAP style guide (Clean Code for ABAP) to review,
  generate, and refactor ABAP code. Use whenever the user asks to review
  ABAP code quality, write new ABAP code following SAP best practices,
  refactor legacy ABAP toward modern style, or has questions about ABAP
  naming, method design, error handling, internal tables, testing, etc.
---

# Clean ABAP Skill

Follow the official **SAP Clean ABAP style guide** (an adoption of Robert C. Martin's *Clean Code* for ABAP) in all ABAP work.

> **命名例外（本项目覆盖）**：本技能的无前缀命名建议**不适用于本项目**——
> SapBuddy 保留匈牙利前缀（`lv_`/`ls_`/`lt_`/`iv_`/`ev_`/`gv_`/`gt_` 等，企业通行惯例），
> 以 `SYSTEM.md` 命名规则为准；其余规范（方法短小、OO 优先、错误处理、SQL、注释、单测）仍然适用。
>
> **触发协调**：本技能提供代码规范与质量评审标准；
> 用户要求"审查/审计/code review XXX"并产出 HTML 报告时，走 `abap-code-review` 技能（含 4 页签报告模板），
> 其审查标准即依据本技能（Clean ABAP）。
> 用户要求"解释/分析程序逻辑"时，走 `abap-explain` 技能。

The full Chinese guide (4300+ lines, 17 chapters, every rule with examples) is in [references/CleanABAP_zh.md](references/CleanABAP_zh.md). **Consult it whenever a topic below is ambiguous, the user asks "why", or you need the exact example syntax.** English original: https://github.com/SAP/styleguides/blob/main/clean-abap/CleanABAP.md

## When to use

- User asks to **review** ABAP code for quality/cleanliness
- User asks to **write or generate** new ABAP code (classes, methods, reports, function modules → classes)
- User asks to **refactor / modernize** legacy ABAP
- User asks ABAP style questions (naming, method signatures, exceptions, tables, testing)

## Core Rules (apply by default)

### Names
- Descriptive, self-explaining names. `customer` not `cust`; `is_available` not `available_flag`.
- Classes = nouns, methods = verbs (imperative for commands: `calculate_tax`, predicative for queries: `is_empty`, `has_entries`).
- `snake_case` for everything. No Hungarian notation, no prefixes (no `lv_`, `mv_`, `gv_`). No noise words (`data`, `info`, `object`, `temp`).
- One word per concept; use pattern names only if you mean the pattern.

### Language
- Prefer object-oriented over procedural; prefer functional constructs (filter/map/reduce, table expressions) over procedural loops where readable.
- Prefer modern syntax: inline declarations (`DATA(x) = ...`), `NEW`, string templates `` |...| ``, `xsdbool`, `COND`/`SWITCH`, table expressions `itab[ ... ]`, `line_exists( ... )`.
- Avoid obsolete elements (`MOVE`, `COLLECT`?, old `OCCURS`, `TYPE-POOLS`, etc.).
- Classes: `FINAL` unless designed for inheritance; members `PRIVATE` by default; prefer composition over inheritance; prefer immutable over getters/setters; prefer `NEW` over `CREATE OBJECT`.

### Methods
- **One method = one thing.** Keep methods small; descend one level of abstraction; prefer the happy path (fail fast at top with guards).
- Few `IMPORTING` parameters (aim < 3). Prefer `RETURNING` over `EXPORTING`; don't mix RETURNING/EXPORTING/CHANGING in one method.
- Name the single `RETURNING` parameter `RESULT` when no better name exists.
- No `OPTIONAL` parameters to widen behavior — split the method instead. Boolean input parameters → split method instead.
- Inline declarations where possible; no up-front declaration chains at method top.
- Loops: `LOOP AT ... WHERE`, prefer `line_exists`/`read table` over scanning whole tables.

### Error handling
- Prefer class-based exceptions over return codes / `SY-SUBRC` checks. Exceptions are for *errors*, not regular cases.
- Throw `CX_STATIC_CHECK` for manageable errors, `CX_NO_CHECK` for unrecoverable ones; use your own exception super class.
- `RAISE EXCEPTION NEW cx_...(...)` (not `TYPE`). Catch foreign exceptions and wrap them in your own.
- Fail fast: validate at method start.

### Comments
- Code should explain itself; comments explain **why**, not what. No commented-out code, no signature/end-of-method comments, no manual versioning (`*---- history`).

### Tables & conditions
- Right table type (STANDARD/SORTED/HASHED); no `DEFAULT KEY` when a semantic key exists; `INSERT INTO TABLE` over `APPEND TO`.
- Positive conditions (`IF is_available` not `IF NOT is_available`); `CASE` over multiple `ELSE IF`; keep nesting depth ≤ 3; extract complex conditions to boolean methods.

## Usage modes

### 1. Review mode
User gives ABAP code (pasted or as files in the project). Produce a structured review:
1. Scan for violations of the Core Rules above; for each finding, read the relevant section of the full guide for exact wording.
2. Output a table: `| # | 严重度 (high/medium/low) | 位置 (class/method/line) | 违反规则 | 问题说明 | 修改建议 |`
3. For high/medium findings, show the concrete before/after code snippet.
4. End with a short summary (top 3 improvements) and offer to apply fixes.

### 2. Generate mode
When writing new ABAP code:
- Follow all Core Rules; prefer object-oriented structure; methods do one thing; prefer `RETURNING`; exceptions not return codes; snake_case naming; inline declarations.
- If user names the object (e.g. a class or report), derive clean names for members/methods from it.
- Ask when requirements are ambiguous, but propose sensible defaults (e.g. `FINAL` class, `CREATE PUBLIC` + `NEW`).

### 3. Refactor mode
When modernizing legacy ABAP:
- Work incrementally, one object/one method at a time. Do not mix styles inside one object (e.g. don't half-convert up-front declarations to inline).
- Priority order for legacy: Booleans → Conditions → Ifs → Methods (biggest win) → Tables → Error handling → Names (most controversial, often skip full rename in legacy).
- Keep behavior identical; refactor and test separately. Follow the "boy scout rule" (leave code cleaner than you found it) but respect scope.

## Reporting
- When citing a rule, reference it like `CleanABAP > Methods > 一个方法只做一件事` (Chinese guide) so the user can look it up.
- If unsure about a rule or needing exact examples, read [references/CleanABAP_zh.md](references/CleanABAP_zh.md) first.
