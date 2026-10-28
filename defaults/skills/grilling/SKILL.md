---
name: grilling
description: >-
  Grill the user relentlessly about a plan, decision, or idea. Use when the user
  wants to stress-test their thinking, or uses any 'grill' trigger phrases
  (including "grill me"). Also used by sap-fs when clarifying FS business decisions;
  not the entry skill for FS intent (load via sap-fs after user confirms FS deliverable).
---

<!--
Third-party: mattpocock/skills (MIT, Copyright 2026 Matt Pocock)
Upstream: https://github.com/mattpocock/skills
  skills/productivity/grilling/SKILL.md
Pinned blob: df69d9936880cd3314c28858c6c52f48db23b856 (fetched 2026-10-28)
Adaptation: bundled under SapBuddy defaults/skills (copied to ~/.SapBuddy/skills; CLI --skill and Web agentDir).
  Upstream says "dispatch a sub-agent" for facts; this host has no sub-agent tool, so the body uses built-in read-only tools.
  Description notes sap-fs; "grill me" triggers are covered here directly (no separate grill-me alias).
-->

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round.

Format a round like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Word each question so "yes" accepts your recommended answer.

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, SAP system, etc.), look it up with this session's built-in read-only tools (`read`, and the SAP search/query tools). SapBuddy has no sub-agent tool — do not invent one. Don't ask the user for anything you could look up yourself. Don't block the whole round on one lookup: if a fact is still unknown, only the questions downstream of it wait; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.
