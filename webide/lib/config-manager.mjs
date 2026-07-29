/**
 * 配置管理 — DOMESTIC_PROVIDERS, ensureDomesticModelsJson, extractModelIds
 */

import fs from "node:fs";
import path from "node:path";

// 国产大模型厂商清单：单一来源避免前后端不一致
export const DOMESTIC_PROVIDERS = {
  deepseek: { label: "DeepSeek（深度求索）", apiBase: "https://api.deepseek.com", validatePath: "/v1/models", modelBaseUrl: "https://api.deepseek.com/v1", api: "openai-completions", defaultModel: "deepseek-chat", models: ["deepseek-chat", "deepseek-reasoner", "deepseek-v3"] },
};

// 从各厂商 /models 响应中抽取模型 id 列表
export function extractModelIds(j) {
  const arr = (j && (j.data || j.models)) || (Array.isArray(j) ? j : []) || [];
  const ids = [];
  for (const it of arr) {
    if (typeof it === "string") ids.push(it);
    else if (it && typeof it.id === "string") ids.push(it.id);
  }
  return [...new Set(ids)].filter(Boolean);
}

// 确保 .pi/models.json 注册所有国产 provider 的 baseUrl
export function ensureDomesticModelsJson(agentDir) {
  try {
    const modelsFile = path.join(agentDir, "models.json");
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(modelsFile, "utf8")); } catch { cfg = {}; }
    if (!cfg.providers) cfg.providers = {};
    let changed = false;
    for (const [key, p] of Object.entries(DOMESTIC_PROVIDERS)) {
      if (!cfg.providers[key]) {
        cfg.providers[key] = {
          baseUrl: p.modelBaseUrl,
          api: p.api,
          models: p.models.map((id) => ({ id })),
        };
        changed = true;
        console.log(`[webide] models.json 注册国产 provider: ${key} -> ${p.modelBaseUrl}`);
      }
    }
    if (changed) fs.writeFileSync(modelsFile, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  } catch (e) {
    console.error(`[webide] 写入 models.json 失败: ${e.message}`);
  }
}
