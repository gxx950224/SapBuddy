/**
 * 上下文用量统计 — /api/context-stats 计算逻辑
 */

import fs from "node:fs";
import path from "node:path";

// DeepSeek 官方 token 估算：英文字符≈0.3 token，中文字符≈0.6 token
function dsTokens(text) {
  let cjk = 0, eng = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF) || (code >= 0xF900 && code <= 0xFAFF)) cjk++;
    else eng++;
  }
  return Math.ceil(cjk * 0.6 + eng * 0.3);
}

export function computeContextStats({ rootDir, agentDir, session, globalLastUsage, mcpStatus }) {
  const settingsFile = path.join(agentDir, "settings.json");
  let contextTokens = 200000;
  try { const s = JSON.parse(fs.readFileSync(settingsFile, "utf8")); contextTokens = s.contextTokens || 200000; } catch {}

  // 各文件独立统计
  let agentsTokens = 0, systemMdTokens = 0, memoryTokens = 0, skillsTokens = 0;
  try { agentsTokens = dsTokens(fs.readFileSync(path.join(rootDir, "AGENTS.md"), "utf8")); } catch {}
  try { systemMdTokens = dsTokens(fs.readFileSync(path.join(rootDir, "SYSTEM.md"), "utf8")); } catch {}
  try { memoryTokens = dsTokens(fs.readFileSync(path.join(rootDir, "Memory.md"), "utf8")); } catch {}

  // 技能：仅统计 prompt 中注入的 <available_skills> 列表
  try {
    const skillsDir = path.join(agentDir, "skills");
    if (fs.existsSync(skillsDir)) {
      const walkSkills = (dir) => {
        let tokens = 0;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const fp = path.join(dir, entry.name);
          if (entry.isFile() && entry.name === "SKILL.md") {
            try {
              const raw = fs.readFileSync(fp, "utf8");
              const fm = raw.replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
              if (fm) {
                const nameMatch = fm[1].match(/^name:\s*(.+)$/m);
                const descMatch = fm[1].match(/^description:\s*(.+)$/m);
                const text = (nameMatch?.[1] || "") + " " + (descMatch?.[1] || "") + " " + fp;
                tokens += dsTokens(text) + 30;
              }
            } catch {}
          } else if (entry.isDirectory() && !entry.name.startsWith(".")) {
            tokens += walkSkills(fp);
          }
        }
        return tokens;
      };
      skillsTokens = walkSkills(skillsDir);
    }
  } catch { /* 忽略 */ }

  // 固定成本
  const GXX_TOOLS_COUNT = 17;
  const PI_BUILTIN_TOOLS_COUNT = 7;
  const extensionsTokens = (GXX_TOOLS_COUNT + PI_BUILTIN_TOOLS_COUNT) * 15 + 60;
  let mcpTokens = 0;
  if (mcpStatus instanceof Map) {
    for (const st of mcpStatus.values()) {
      if (st.connected && st.tools?.length) mcpTokens += st.tools.length * 20;
    }
  }
  if (!mcpTokens) mcpTokens = 100;
  const piAgentTokens = 4200;
  const systemTotal = piAgentTokens + extensionsTokens + mcpTokens;
  const configTotal = agentsTokens + systemMdTokens + memoryTokens + skillsTokens;
  const fixedTotal = systemTotal + configTotal;

  // 可变成本
  let convTokens_est = 0;
  try {
    convTokens_est = session ? session.messages.reduce((sum, m) => {
      const text = typeof m.content === "string" ? m.content : Array.isArray(m.content)
        ? m.content.reduce((s, p) => s + (typeof p.text === "string" ? p.text : ""), "") : "";
      return sum + dsTokens(text);
    }, 0) : 0;
  } catch { /* ignore */ }

  let totalUsed, cacheTokens = 0;
  if (globalLastUsage && (globalLastUsage.lastInput || globalLastUsage.cacheRead)) {
    const actualTotal = (globalLastUsage.cacheRead || 0) + (globalLastUsage.lastInput || 0);
    cacheTokens = globalLastUsage.cacheRead || 0;
    convTokens_est = Math.max(0, actualTotal - fixedTotal);
    totalUsed = actualTotal;
  } else {
    totalUsed = fixedTotal + convTokens_est;
  }
  const remaining = Math.max(0, contextTokens - totalUsed);
  const pct = contextTokens > 0 ? Math.min(100, Math.round(totalUsed / contextTokens * 100)) : 0;
  const pctOf = (v) => totalUsed ? Math.round(v / totalUsed * 100) : 0;

  return {
    max: contextTokens,
    piAgent: piAgentTokens, extensions: extensionsTokens, mcp: mcpTokens,
    agents: agentsTokens, systemMd: systemMdTokens,
    memory: memoryTokens, skills: skillsTokens,
    conversation: convTokens_est, cache: cacheTokens,
    systemTotal, configTotal,
    total: totalUsed, remaining, pct,
    pctPiAgent: pctOf(piAgentTokens), pctExtensions: pctOf(extensionsTokens), pctMcp: pctOf(mcpTokens),
    pctAgents: pctOf(agentsTokens), pctSystemMd: pctOf(systemMdTokens),
    pctMemory: pctOf(memoryTokens), pctSkills: pctOf(skillsTokens),
    pctConv: pctOf(convTokens_est),
    pctCache: totalUsed ? Math.round(cacheTokens / totalUsed * 100) : 0,
  };
}
