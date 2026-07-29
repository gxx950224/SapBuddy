/**
 * 模型配置校验 — validateProviderKey, validateCurrentConfig
 */

import fs from "node:fs";
import path from "node:path";
import { DOMESTIC_PROVIDERS } from "./config-manager.mjs";

// 已知厂商的鉴权校验地址
export const PROVIDER_VALIDATE = {
  deepseek: { base: "https://api.deepseek.com", path: "/v1/models" },
};

// 可选覆盖：允许把某厂商的校验地址指向自托管/代理
try {
  const ov = process.env.WEBIDE_VALIDATE_OVERRIDE;
  if (ov) Object.assign(PROVIDER_VALIDATE, JSON.parse(ov));
} catch { /* 忽略无效覆盖 */ }

// 由清单派生校验表
for (const [key, p] of Object.entries(DOMESTIC_PROVIDERS)) {
  PROVIDER_VALIDATE[key] = { base: p.apiBase, path: p.validatePath };
}

// 校验某 provider + key 是否有效
export async function validateProviderKey(provider, key) {
  const ep = PROVIDER_VALIDATE[provider];
  if (!ep || !key) {
    return { valid: true, definiteInvalid: false, unknown: !ep, error: ep ? "未提供 API Key" : "未知厂商，无法校验" };
  }
  const url = ep.base + ep.path;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      signal: ctrl.signal,
    });
    if (res.status === 200) return { valid: true, definiteInvalid: false, error: "" };
    if (res.status === 401 || res.status === 403) {
      return { valid: false, definiteInvalid: true, error: `HTTP ${res.status} 未授权，Key 无效或权限不足` };
    }
    return { valid: false, definiteInvalid: false, error: `HTTP ${res.status}，未能确认（可能是限流或服务异常）` };
  } catch (e) {
    return { valid: false, definiteInvalid: false, error: "网络不可达，未能校验 Key" };
  } finally {
    clearTimeout(timer);
  }
}

// 后台校验「当前生效 provider」的 key，结果回调
export async function validateCurrentConfig(agentDir, onStatusChange) {
  try {
    const settingsFile = path.join(agentDir, "settings.json");
    const authFile = path.join(agentDir, "auth.json");
    const s = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    const a = JSON.parse(fs.readFileSync(authFile, "utf8"));
    const prov = s.defaultProvider;
    const key = a[prov] && a[prov].key;
    if (!key) {
      onStatusChange("invalid", `「${prov}」未配置 API Key`);
      return;
    }
    const r = await validateProviderKey(prov, key);
    if (r.valid) { onStatusChange("ok", ""); }
    else if (r.definiteInvalid) { onStatusChange("invalid", r.error || "API Key 无效"); }
    else { onStatusChange("unknown", r.error || "未能联网校验"); }
    console.log(`[webide] 配置校验: provider=${prov} status=${r.valid ? "ok" : r.definiteInvalid ? "invalid" : "unknown"}`);
  } catch (e) {
    console.warn(`[webide] 配置校验跳过: ${e.message}`);
  }
}
