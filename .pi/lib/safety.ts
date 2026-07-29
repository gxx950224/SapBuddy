/**
 * safety.ts — 安全层独立模块
 *
 * 包含：
 * 1. 安全边界检查（PROTECTED_PREFIXES）
 * 2. 三次失败熔断机制（attemptCounter）
 */

import * as path from "node:path";
import * as fs from "node:fs";

// ============================================================
// 安全边界
// ============================================================

export const PROTECTED_PREFIXES = [
  "SAP", "SAPL", "/SAP", "CL_", "CX_", "RS_", "RSS_",
  "BAPI", "BAPIRET", "DDIC", "ICON_", "ST_", "SS_",
];

export function isProtected(name: string): boolean {
  const upper = name.toUpperCase();
  return PROTECTED_PREFIXES.some((p) => upper.startsWith(p));
}

export function isDevObject(name: string): boolean {
  return name.toUpperCase().startsWith("Z") || name.toUpperCase().startsWith("Y");
}

export function safetyGuard(name: string, operation: string): void {
  if (isProtected(name)) {
    throw new Error(`[安全拦截] 禁止${operation} SAP 标准对象 "${name}"。只允许操作 Z*/Y* 命名空间。`);
  }
}

// ============================================================
// 三次失败熔断
// ============================================================

const ATTEMPT_COUNTER_FILE = path.join(process.cwd(), ".attempt-counter.json");

export interface AttemptCounter {
  object: string;
  count: number;
  problem: string;
  lastFix: string;
  state: string;
}

function readAttemptCounter(): AttemptCounter {
  try {
    if (fs.existsSync(ATTEMPT_COUNTER_FILE)) {
      return JSON.parse(fs.readFileSync(ATTEMPT_COUNTER_FILE, "utf-8"));
    }
  } catch {}
  return { object: "", count: 0, problem: "", lastFix: "", state: "idle" };
}

function writeAttemptCounter(c: AttemptCounter) {
  try {
    fs.writeFileSync(ATTEMPT_COUNTER_FILE, JSON.stringify(c), "utf-8");
  } catch {}
}

/** 执行前检查：同一对象连续失败 >= 3 次则阻断 */
export function checkFailureLimit(objectName: string): void {
  const c = readAttemptCounter();
  if (c.object === objectName && c.count >= 3 && c.state === "failed") {
    throw new Error(
      `[熔断] "${objectName}" 已连续失败 ${c.count} 次！立即停手。\n` +
      `  上次问题：${c.problem}\n` +
      `  上次修复：${c.lastFix}\n` +
      `  请向用户上报：对象=${objectName}，问题=${c.problem}，已尝试方案=${c.lastFix}，请求指导。`
    );
  }
}

/** 执行后更新计数器 */
export function updateAttemptCounter(objectName: string, success: boolean, problem: string = "", fixDescription: string = "") {
  const c = readAttemptCounter();
  const wasFailed = c.state === "failed" && c.object === objectName;
  const prevProblem = c.problem;

  if (c.object !== objectName) {
    c.object = objectName;
    c.count = 0;
    c.problem = "";
    c.lastFix = "";
    c.state = "idle";
  }

  if (success) {
    c.count = 0;
    c.state = "done";
    c.lastFix = fixDescription || c.lastFix || "";
    // 从失败到解决的转换 → 自动写入 Memory.md
    if (wasFailed && prevProblem) {
      appendToMemory(objectName, prevProblem, c.lastFix);
    }
    c.problem = "";
    c.lastFix = "";
  } else {
    c.count += 1;
    if (problem) c.problem = problem.slice(0, 200);
    if (fixDescription) c.lastFix = fixDescription.slice(0, 300);
    c.state = "failed";
  }

  writeAttemptCounter(c);
}

/** 将解决记录追加到 Memory.md */
function appendToMemory(objectName: string, problem: string, fix: string) {
  try {
    const memoryFile = path.join(process.cwd(), "Memory.md");
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const entry = `
## ${objectName} — 修复记录

- **日期：** ${dateStr}
- **对象：** ${objectName}
- **症状：** ${problem}
- **方案：** ${fix || "详见对话记录"}
- **预防：** 参见 SYSTEM.md 编码规范和避坑指南

`;
    fs.appendFileSync(memoryFile, entry, "utf-8");
  } catch { /* Memory.md 写入失败非致命 */ }
}
