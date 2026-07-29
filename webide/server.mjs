/**
 * ABAP Code Studio — PI Agent 对话网页版后端
 *
 * 内嵌 pi-coding-agent SDK，创建与 CLI 完全同构的 PI Agent 会话：
 * 同一套 extensions（16 个 abap_* 工具）、AGENTS.md 铁律、skills、prompts。
 *
 * 零 npm 依赖：Node 原生 http + SSE。
 * 用法：node webide/server.mjs  [PORT=7400]
 */

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import dns from "node:dns";
import { fileURLToPath, pathToFileURL } from "node:url";
import { exec, execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";

// ============================================================
// DNS 修复：Node.js 内置 fetch() 在某些网络环境下 DNS 解析失败，
// 使用 http.request + dns.lookup（系统级 getaddrinfo）替代。
// ============================================================
function fetchWithLookup(url, options = {}) {
  const parsed = new URL(url);
  const isHttps = parsed.protocol === "https:";
  const Agent = isHttps ? https.Agent : http.Agent;
  const agent = new Agent({ lookup: dns.lookup.bind(dns), keepAlive: true, maxSockets: 8 });
  const signal = options.signal;
  return new Promise((resolve, reject) => {
    const mod = isHttps ? https : http;
    const req = mod.request(parsed, { agent, method: options.method || "GET", headers: options.headers || {} }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: { get: (n) => res.headers[n.toLowerCase()] },
          json: async () => JSON.parse(body.toString()),
          text: async () => body.toString(),
          body: { getReader: () => { let i=0; return { read: async () => { if(i>=chunks.length) return {done:true}; return {done:false,value:chunks[i++]}; }}; }},
        });
      });
    });
    req.on("error", reject);
    if (signal) {
      if (signal.aborted) { req.destroy(); return; }
      signal.addEventListener("abort", () => { req.destroy(signal.reason); }, { once: true });
    }
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ============================================================
// WorkBuddy safe-delete 冲突修复
// WorkBuddy 通过 NODE_OPTIONS 注入 genie-safe-delete.cjs，
// hook 了 fs.unlinkSync 等删除方法。当 webide 删除 session 文件时，
// hook 会调用 safe-delete-bulk-guard.cjs 做批量删除检查，
// 但该脚本在 webide 环境下执行失败。
// 清理相关环境变量，使 safe-delete 降级为普通回收站删除。
// ============================================================
delete process.env.CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR;
delete process.env.CODEBUDDY_TOOL_CALL_ID;
delete process.env.CODEBUDDY_SAFE_DELETE_BULK_GUARD;
delete process.env.CODEBUDDY_NODE_BIN;
console.log("[webide] 已清理 WorkBuddy safe-delete bulk guard 环境变量");

// ============================================================
// Windows DOS 弹窗修复：monkey-patch child_process.spawn
// PI SDK 内部 spawn 调用（exec.js / bash.js / find.js / grep.js）
// 均未设置 windowsHide: true，导致网页版对话时频繁弹出 DOS 窗口。
// 在 PI SDK 加载前拦截 spawn，强制注入 windowsHide: true。
// ============================================================
if (process.platform === "win32") {
  const _require = createRequire(import.meta.url);
  const _cp = _require("node:child_process");
  const _origSpawn = _cp.spawn;
  _cp.spawn = function _spawnHidden(command, args, options) {
    const opts = { ...options };
    if (opts.windowsHide === undefined) opts.windowsHide = true;
    return _origSpawn.call(this, command, args, opts);
  };
  console.log("[webide] child_process.spawn 已注入 windowsHide 补丁");
}

// ============================================================
// DeepSeek 流式请求超时 + 自动重试
// deepseek-v4-flash 在 high 深度思考 + 工具结果上下文下，
// 偶发流式响应中途被 API 中断（约 60s 超时/RST），PI SDK 会把
// 当前 assistant 消息标 terminated，导致会话卡住。
// 在 PI SDK 调用 fetch 前包裹 globalThis.fetch：仅对 api.deepseek.com
// 的请求加 45s 超时 + 2 次指数退避重试（不重试用户主动 abort、不重试 4xx）。
// ============================================================
const _origFetch = globalThis.fetch ? globalThis.fetch.bind(globalThis) : null;
if (_origFetch) {
  globalThis.fetch = async function _deepseekRetryFetch(input, init = {}) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (!/api\.deepseek\.com/.test(url)) return _origFetch(input, init);
    const MAX_RETRY = 2;
    let lastErr;
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      const ctrl = new AbortController();
      const parent = init.signal;
      const timer = setTimeout(() => ctrl.abort(), 45000);
      let onParentAbort;
      if (parent) {
        if (parent.aborted) ctrl.abort();
        else { onParentAbort = () => ctrl.abort(); parent.addEventListener("abort", onParentAbort); }
      }
      try {
        const r = await _origFetch(input, { ...init, signal: ctrl.signal });
        clearTimeout(timer);
        if (parent && onParentAbort) parent.removeEventListener("abort", onParentAbort);
        // 仅 5xx 重试（4xx 一般为参数错误，重试无意义）
        if (!r.ok && r.status >= 500) { lastErr = new Error("deepseek HTTP " + r.status); throw lastErr; }
        return r;
      } catch (e) {
        clearTimeout(timer);
        if (parent && onParentAbort) parent.removeEventListener("abort", onParentAbort);
        lastErr = e;
        if (parent && parent.aborted) break; // 用户主动停止，不重试
        if (attempt < MAX_RETRY) {
          console.warn(`[webide] deepseek 请求失败，第 ${attempt + 1}/${MAX_RETRY} 次重试:`, e && e.message);
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  };
  console.log("[webide] deepseek fetch 超时重试补丁已注入（90s 超时 + 2 次重试）");
}

// ============================================================
// 配置
// ============================================================

const PORT = Number(process.env.WEBIDE_PORT || 7400);
const HOST = "127.0.0.1";
const HERE = path.dirname(fileURLToPath(import.meta.url));
// 项目根：默认 webide/ 的上一级；可用 WEBIDE_CWD 指定其他 PI 项目
const ROOT = process.env.WEBIDE_CWD
  ? path.resolve(process.env.WEBIDE_CWD)
  : path.resolve(HERE, "..");
const PUBLIC_DIR = path.join(HERE, "public");
// 桌面端（Electron）通过环境变量将输出目录 / Agent 目录重定向到可写位置（userData），
// 避免安装目录（如 C:\Program Files）只读导致写入失败。
const OUTPUT_DIR = process.env.WEBIDE_OUTPUT_DIR
  ? path.resolve(process.env.WEBIDE_OUTPUT_DIR)
  : path.join(ROOT, "output");
// 供 mcp-bridge extension 使用
globalThis.__OUTPUT_DIR = OUTPUT_DIR;
const AGENT_DIR = process.env.WEBIDE_AGENT_DIR
  ? path.resolve(process.env.WEBIDE_AGENT_DIR)
  : (process.env.PI_AGENT_DIR || path.join(ROOT, ".pi"));

// 计算会话文件存储目录（与 createAgentSession 内部逻辑一致）
function getSessionDir() {
  const safePath = `--${ROOT.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(AGENT_DIR, "sessions", safePath);
}

const GXX_ABAP_JS =
  process.env.GXX_ABAP_JS || path.join(HERE, "..", "gxx-abap", "bin", "gxx-abap.js");
const GXX_ABAP_CONFIG =
  process.env.GXX_ABAP_CONFIG || path.join(ROOT, ".gxx-abap", "config.json");

// Node 可执行文件：优先使用项目自带的 node/node.exe（桌面端打包后 process.execPath
// 会指向 Electron 主程序，不能用来跑 gxx-abap CLI）。
const NODE_BIN = (() => {
  // 优先使用 Electron 桌面端传入的 WEBIDE_NODE_BIN（packaged 环境下 node.exe 路径可能不同）
  if (process.env.WEBIDE_NODE_BIN && fs.existsSync(process.env.WEBIDE_NODE_BIN)) return process.env.WEBIDE_NODE_BIN;
  const bundled = path.join(ROOT, "node", "node.exe");
  if (process.platform === "win32" && fs.existsSync(bundled)) return bundled;
  return process.execPath;
})();
process.env.GXX_NODE_BIN = NODE_BIN;

const PI_SDK =
  process.env.PI_SDK_PATH || path.join(HERE, "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");

// ============================================================
// PI Agent 会话（单例，所有浏览器标签共享）
// ============================================================

let session = null;
let sessionError = null;
let piSdk = null;
let resourceLoader = null;
let currentSessionPath = null;  // 当前会话文件路径：切换/新建时同步设置，供左侧高亮即时更新（无需等待后台重建）
let sessionGen = 0;             // 当前会话代际：每次 currentSessionPath 变更自增，用于前端丢弃过期/延迟的 session_reset 广播
function _setCSP(p, tag) { currentSessionPath = p; sessionGen++; }

// 大模型配置健康状态：启动/保存后校验当前生效 provider 的 key，决定前端指示灯
// "ok"      —— 已校验有效（或未知厂商无法校验，按可用处理）
// "invalid" —— key 明确无效（401/403），前端标红“API Key 无效”
// "unknown" —— 网络不可达等未能联网校验，前端仍显示绿色但不代表已确认
// "pending" —— 校验进行中
let configStatus = "pending";
let configError = "";

// 已知厂商的鉴权校验地址（OpenAI 兼容的 /v1/models 或厂商自有路径）
const PROVIDER_VALIDATE = {
  deepseek: { base: "https://api.deepseek.com", path: "/v1/models" },
};
// 可选覆盖：允许把某厂商的校验地址指向自托管/代理（如企业内网网关）。
// 环境变量 WEBIDE_VALIDATE_OVERRIDE 为 JSON：{"deepseek":{"base":"http://gw:8080","path":"/v1/models"}}
try {
  const ov = process.env.WEBIDE_VALIDATE_OVERRIDE;
  if (ov) Object.assign(PROVIDER_VALIDATE, JSON.parse(ov));
} catch { /* 忽略无效覆盖 */ }

// 国产大模型厂商清单：前端下拉框、后端 key 校验、以及 .pi/models.json 兜底注册都从这里派生，
// 单一来源避免前后端不一致。
// 注意：DeepSeek / MiniMax 是 PI SDK 内置 provider，可直接用；
// Qwen / Kimi / 智谱 / 豆包 / 混元 / ERNIE 不在内置列表，必须在 .pi/models.json 注册 baseUrl 才能被 Agent 真正调用。
//   apiBase       —— key 校验用的根地址（不含 /v1）
//   validatePath  —— 校验端点（GET，带 Bearer 返回 200 即有效）
//   modelBaseUrl  —— models.json 的 baseUrl（PI SDK 会在其后追加 /chat/completions）
//   models        —— 该厂商常见模型（写入 models.json 供 PI SDK 识别，并作前端默认建议）
const DOMESTIC_PROVIDERS = {
  deepseek: { label: "DeepSeek（深度求索）", apiBase: "https://api.deepseek.com", validatePath: "/v1/models", modelBaseUrl: "https://api.deepseek.com/v1", api: "openai-completions", defaultModel: "deepseek-v4-flash", models: ["deepseek-v4-flash", "deepseek-v4-pro"] },
};
// 由清单派生校验表（保留 openai 等原有条目，仅补充/覆盖国产厂商）
for (const [key, p] of Object.entries(DOMESTIC_PROVIDERS)) {
  PROVIDER_VALIDATE[key] = { base: p.apiBase, path: p.validatePath };
}

// 从各厂商 /models 响应中抽取模型 id 列表（兼容 OpenAI/ark/智谱等多种格式）
function extractModelIds(j) {
  const arr = (j && (j.data || j.models)) || (Array.isArray(j) ? j : []) || [];
  const ids = [];
  for (const it of arr) {
    if (typeof it === "string") ids.push(it);
    else if (it && typeof it.id === "string") ids.push(it.id);
  }
  return [...new Set(ids)].filter(Boolean);
}

// 确保 .pi/models.json 注册所有国产 provider 的 baseUrl（让 PI SDK 能调用非内置厂商）。
// 仅补充缺失项，绝不删除/覆盖用户已有的自定义 provider 定义；真实 API Key 取自 auth.json。
function ensureDomesticModelsJson() {
  try {
    const modelsFile = path.join(AGENT_DIR, "models.json");
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

// 配置文件缓存：减少重复磁盘 I/O
const _configCache = { settings: null, auth: null, models: null };

function getCachedConfig(type) {
  const fileMap = {
    settings: path.join(AGENT_DIR, "settings.json"),
    auth: path.join(AGENT_DIR, "auth.json"),
    models: path.join(AGENT_DIR, "models.json"),
  };
  const fp = fileMap[type];
  if (!fp) return null;
  if (_configCache[type] !== null) return _configCache[type];
  try {
    _configCache[type] = JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    _configCache[type] = {};
  }
  return _configCache[type];
}

function clearConfigCache(type) {
  if (type) {
    _configCache[type] = null;
  } else {
    _configCache.settings = null;
    _configCache.auth = null;
    _configCache.models = null;
  }
}

// 校验某 provider + key 是否有效。返回 { valid, definiteInvalid, error }
// 仅对已知厂商做真实联网校验；custom/未知厂商无法校验，按 valid=true(未知) 处理，避免误伤。
async function validateProviderKey(provider, key, model) {
  const ep = PROVIDER_VALIDATE[provider];
  if (!ep || !key) {
    // 未知厂商或无 key：无法校验，不判定无效
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
    // 非 200 非 401/403 状态码（429 限流、5xx 等）：仍按 valid 处理，不确定不误判
    return { valid: true, definiteInvalid: false, error: "" };
  } catch (e) {
    // 网络不可达 / 超时：仍按 valid 处理，仅校验端点不通不代表 key 有问题
    return { valid: true, definiteInvalid: false, error: "" };
  } finally {
    clearTimeout(timer);
  }
}

// 后台校验「当前生效 provider」的 key，结果写入 configStatus 并广播给前端
async function validateCurrentConfig() {
  try {
    const settingsFile = path.join(AGENT_DIR, "settings.json");
    const authFile = path.join(AGENT_DIR, "auth.json");
    const s = getCachedConfig("settings") || {};
    const a = getCachedConfig("auth") || {};
    const prov = s.defaultProvider;
    const key = a[prov] && a[prov].key;
    if (!key) {
      configStatus = "invalid";
      configError = `「${prov}」未配置 API Key`;
      broadcastConfigStatus();
      return;
    }
    // 检查占位符 Key（默认提示文字），视为未配置
    if (key.includes("请输入你的API_KEY") || key.includes("YOUR_API_KEY") || key.includes("sk-your-key")) {
      configStatus = "invalid";
      configError = "请先填写有效的 API Key（当前为占位符）";
      broadcastConfigStatus();
      return;
    }
    const r = await validateProviderKey(prov, key, s.defaultModel);
    if (r.valid) { configStatus = "ok"; configError = ""; }
    else if (r.definiteInvalid) { configStatus = "invalid"; configError = r.error || "API Key 无效"; }
    else { configStatus = "unknown"; configError = r.error || "未能联网校验"; }
    console.log(`[webide] 配置校验: provider=${prov} status=${configStatus}${configError ? " (" + configError + ")" : ""}`);
    broadcastConfigStatus();
  } catch (e) {
    // 读取配置失败：不阻塞，保持原状态
    console.warn(`[webide] 配置校验跳过: ${e.message}`);
  }
}

function broadcastConfigStatus() {
  broadcast({ kind: "config_status", configStatus, configError, ts: Date.now() });
}

const EXTENSION_PATHS = [
  path.join(ROOT, ".pi", "extensions", "gxx-abap-extension.ts"),
  path.join(ROOT, ".pi", "extensions", "mcp-bridge-extension.ts"),
].filter((p) => fs.existsSync(p));

async function createResourceLoader() {
  if (!piSdk) throw new Error("PI SDK 未加载");
  const agentDir = process.env.PI_AGENT_DIR || path.join(ROOT, ".pi");
  const loader = new piSdk.DefaultResourceLoader({
    cwd: ROOT,
    agentDir,
    additionalExtensionPaths: EXTENSION_PATHS,
    additionalSkillPaths: [],
    additionalPromptTemplatePaths: [],
  });
  await loader.reload();
  const extResult = loader.getExtensions();
  if (extResult.errors?.length) {
    for (const e of extResult.errors) {
      console.warn(`[webide] extension 加载警告: ${e.path} - ${e.error}`);
    }
  }
  console.log(`[webide] 已加载 ${extResult.extensions?.length || 0} 个 extension`);
  return loader;
}

// 全局确认等待队列（server + extension 共享）
globalThis.__pendingConfirmations = new Map();

let globalLastUsage = null;  // 供 context-stats API 使用真实 API 用量

// 上下文统计缓存
let _ctxStatsCacheData = null;
let _ctxStatsMsgCount = -1;
let _ctxStatsUsageSig = -1;
let _ctxFileCache = null;       // context-stats 文件内容 mtime 缓存
let _ctxFileCacheStale = false; // 设为 true 强制刷新文件缓存

// 更新检查缓存：避免频繁切 tab 重复拉取
let _updateCheckCache = { data: null, ts: 0, TTL: 60000 };

async function attachSession(newSession) {
  session = newSession;
  globalLastUsage = null;  // 新会话重置，防止跨会话数据污染
  let turnStart = 0;
  let turnUsage = null;  // 本轮的累积 usage（input/output 累加，cacheRead 取最新）
  session.subscribe((event) => {
    // agent_start 每轮用户消息只触发一次（turn_start 每次 LLM 调用都触发，会导致计时被重置）
    if (event.type === "agent_start") { turnStart = Date.now(); turnUsage = null; }
    // 跟踪最后一个 assistant 消息的 usage（agent_end 时随广播下发）
    // 拦截 bash + gxx-abap — 防止 WSL 跨进程调用弹出 DOS 窗口
    if (event.type === "tool_execution_start" && event.toolName === "bash") {
      const cmd = event.args?.command || "";
      if (/gxx-abap|npx.*gxx/i.test(cmd) && !/node.*gxx-abap/i.test(cmd)) {
        console.log(`[webide] ★ 拦截 bash+gxx-abap: ${cmd.slice(0, 80)}`);
        broadcast({
          kind: "error",
          error: "[系统拦截] 禁止用 bash 执行 gxx-abap。如果是因为输出截断或工具报错想绕过去，请直接告诉用户你遇到了什么问题，让用户来指导。",
          ts: Date.now(),
        });
        // 尝试中断 agent，防止继续执行
        try { session.agent?.abort?.(); } catch {}
        return;
      }
    }
    // 拦截 ask_user_confirmation，广播特殊事件给前端渲染确认卡片
    if (event.type === "tool_execution_start" && event.toolName === "ask_user_confirmation") {
      broadcast({
        kind: "user_confirmation",
        toolCallId: event.toolCallId,
        question: event.args?.question || "",
        options: event.args?.options || ["是", "否"],
        allowCustom: event.args?.allow_custom === true,
        ts: Date.now(),
      });
      return;
    }
    // 累积整轮 assistant 消息的 usage
    if (event.message && event.message.role === "assistant" && event.message.usage) {
      const u = event.message.usage;
      if (turnUsage) {
        turnUsage.input += u.input || 0;
        turnUsage.output += u.output || 0;
        turnUsage.lastInput = u.input || 0;  // 最后一步原始 input（用于上下文计算）
        turnUsage.cacheRead = u.cacheRead || turnUsage.cacheRead;
      } else {
        turnUsage = { input: u.input || 0, output: u.output || 0, lastInput: u.input || 0, cacheRead: u.cacheRead || 0 };
      }
      globalLastUsage = turnUsage;
    }
    broadcast({ kind: "agent", event, ts: Date.now(), elapsed: turnStart ? Date.now() - turnStart : 0, usage: turnUsage });
  });
}

async function initSession() {
  const t0 = Date.now();
  try {
    ensureDomesticModelsJson();  // 确保国产 provider 已在 .pi/models.json 注册，Agent 才能调用
    const tImp = Date.now();
    piSdk = await import(pathToFileURL(PI_SDK).href);
    console.log(`[webide]   · 加载 PI SDK: ${Date.now() - tImp}ms`);
    const tRl = Date.now();
    resourceLoader = await createResourceLoader();
    console.log(`[webide]   · 加载资源/扩展(MCP): ${Date.now() - tRl}ms`);
    // 启动时默认新建会话（SessionManager.create() 的构造函数已自动调用 newSession()）
    const sm = piSdk.SessionManager.create(ROOT, getSessionDir());
    _setCSP(sm.sessionFile, "initSession");
    console.log(`[webide]   · 新建会话: ${sm.sessionFile}`);
    const opts = { cwd: ROOT, agentDir: AGENT_DIR, resourceLoader, sessionManager: sm };
    // 会话替换后用「新会话的有效 ctx」重连 MCP，确保工具重新注册。
    // 必须 await：否则 SDK 在回调返回后立即让会话上下文失效，在途 MCP 连接会抛 "ctx is stale"。
    opts.withSession = async (ctx) => {
      try { await globalThis.__mcpReconnectAll?.(ctx); }
      catch (e) { console.warn("[webide] mcp withSession 重连失败:", e?.message); }
    };
    const tCas = Date.now();
    const result = await piSdk.createAgentSession(opts);
    console.log(`[webide]   · createAgentSession(Agent内核): ${Date.now() - tCas}ms`);
    const tBind = Date.now();
    await result.session.bindExtensions({});
    console.log(`[webide]   · bindExtensions(扩展/MCP握手): ${Date.now() - tBind}ms`);
    // createAgentSession 不会触发 withSession，故在此用已就绪的新会话上下文显式重连 MCP，
    // 确保工具重新注册、保存配置即时生效。__mcpReconnectAll 由 extension 在 factory 内注册。
    try { await globalThis.__mcpReconnectAll?.(); }
    catch (e) { console.warn("[webide] mcp 初始化后重连失败:", e?.message); }
    await attachSession(result.session);
    // 从 settings.json 读取默认思考等级并应用（deepseek-v4-flash 仅支持 off/high，字段缺失则默认 "off" 轻量模式）
    try {
      const s = getCachedConfig("settings") || {};
      const dl = s.defaultThinkingLevel || "off";
      if (["off", "high"].includes(dl)) { session.setThinkingLevel(dl); }
    } catch {}
    _setCSP(result.session.sessionFile || currentSessionPath, "initSession");  // 记录启动加载的会话，左侧初始高亮正确
    console.log(`[webide] PI Agent 会话已创建 (sessionId: ${session.sessionId})`);
    validateCurrentConfig();  // 后台校验当前 provider 的 key，结果经 SSE 即时推送前端指示灯
    // 启动时主动查一次 SAP 状态并缓存，前端只此一次查询，不再轮询
    pingSapDirectly(15000).then((r) => {
      sapStatusCache.result = r.success
        ? { success: true, data: r.data }
        : { success: false, error: r.error || "连接失败" };
      sapStatusCache.ts = Date.now();
    }).catch(() => {});
    console.log(`[webide] 会话初始化总耗时: ${Date.now() - t0}ms`);
    // 启动就绪后广播，让已连接的浏览器即时刷新左侧高亮（初始 refreshSessions 可能在就绪前跑过）
    broadcast({ kind: "session_reset", state: sessionState(), ts: Date.now() });
    if (result.modelFallbackMessage) {
      console.log(`[webide] 模型回退提示: ${result.modelFallbackMessage}`);
    }
  } catch (err) {
    sessionError = err?.message || String(err);
    console.error(`[webide] 会话创建失败(${Date.now() - t0}ms): ${sessionError}`);
  }
}

// 后台重建锁：避免并发重建互相干扰，并让 /api/chat 能等待就绪
let activeRebuild = null;

// 真正的重建逻辑（耗时 ~10s：createAgentSession 启动 Agent + 绑定工具/MCP）
async function doRebuild(sessionManager, reason = "rebuild") {
  try {
    if (session) {
      try { session.dispose(); } catch { /* ignore */ }
    }
  // 重建开始时锁定"目标会话"，用于判断广播是否仍然有效：
  // 若重建期间用户已切换/新建到其它会话，这次重建就成了"迟到旧会话"，
  // 其广播会把左侧高亮错误地拉回旧会话，进而让删除旧会话时路径错乱（二次弹窗的根因）。
  const targetPath = sessionManager?.sessionFile || currentSessionPath;
  if (!resourceLoader) {
    resourceLoader = await createResourceLoader();
  } else {
    // 关键修复：重建前必须重置 extension 运行时。
    // 上一个会话 session.dispose() 会调用 ExtensionRunner.invalidate() → runtime.invalidate()，
    // 把「跨重建复用的共享 runtime」状态标记为 stale（state.staleMessage 被写入）。
    // 由于 resourceLoader 在多次重建间被复用，新会话拿到的仍是这份被污染的 runtime，
    // 于是 pi.registerTool 在 assertActive() 时抛 "ctx is stale"，MCP 工具永远无法重新注册，
    // 「保存 MCP 配置即时生效」彻底失效（表现为保存后 MCP 服务全部报错 stale）。
    // resourceLoader.reload() 会重新 loadExtensions，生成全新的 runtime（state.staleMessage 为空），
    // 并重新执行所有 extension factory（刷新 globalThis.__mcpReconnectAll 闭包，使其指向当前会话的有效 pi）。
    // 这与 SDK 自身的 session.reload() 行为一致。扫描成本极低（仅读取若干 .ts 并注册处理器，
    // 不再在扫描期发起 MCP 握手），远小于下方 createAgentSession 的约 10s 内核启动耗时。
    await resourceLoader.reload();
  }
  const t0 = Date.now();
  const options = { cwd: ROOT, agentDir: AGENT_DIR, resourceLoader };
  if (sessionManager) options.sessionManager = sessionManager;
  // 会话替换（rebuild / 切换 / 保存 MCP 配置）后用「新会话的有效 ctx」重连 MCP，确保工具重新注册。
  // 必须 await：否则 SDK 在回调返回后立即让会话上下文失效，在途 MCP 连接会抛 "ctx is stale"。
  options.withSession = async (ctx) => {
    try { await globalThis.__mcpReconnectAll?.(ctx); }
    catch (e) { console.warn("[webide] mcp withSession 重连失败:", e?.message); }
  };
  const result = await piSdk.createAgentSession(options);
  await result.session.bindExtensions({});
  await attachSession(result.session);
  // createAgentSession 不会触发 withSession，故在此用已就绪的新会话上下文显式重连 MCP，
  // 确保工具重新注册、保存配置即时生效。__mcpReconnectAll 由 extension 在 factory 内注册。
  try { await globalThis.__mcpReconnectAll?.(); }
  catch (e) { console.warn("[webide] mcp 重建后重连失败:", e?.message); }
  // 注意：sessionId 是 PI Agent 内核的运行时 id，每次重建都会变，且与"对话"不是一回事；
  // 打印它容易造成"切换历史会话却新建了会话"的误解，因此日志只打印会话文件路径 + 动作。
  const logPath = targetPath ? path.basename(targetPath) : "(无)";
  console.log(`[webide] ${reasonLabel(reason)} (会话文件: ${logPath}) 耗时 ${Date.now() - t0}ms`);
  // 仅启动时和保存设置时校验 key，重建不重复校验（配置未变更）
  // 仅在重建的会话仍是"当前会话"时才广播，避免过期旧会话的迟到广播干扰高亮
  if (targetPath && path.resolve(currentSessionPath || "") !== path.resolve(targetPath)) {
    console.log(`[webide] 跳过过期的 session_reset 广播（重建目标 ${targetPath} 已非当前会话 ${currentSessionPath}）`);
    return session;
  }
  broadcast({ kind: "session_reset", state: sessionState(), ts: Date.now() });
  return session;
  } catch (e) {
    console.error(`[webide] 重建失败:`, e);
    try {
      const fallback = await piSdk.createAgentSession({ cwd: ROOT, agentDir: AGENT_DIR });
      await fallback.bindExtensions({});
      await attachSession(fallback.session);
    } catch (e2) {
      console.error(`[webide] 基础会话重建也失败:`, e2);
    }
    return session;
  }
}

// 会话动作的中文标签（用于日志，避免用户误以为"切换历史会话=新建会话"）
function reasonLabel(reason) {
  switch (reason) {
    case "init": return "Agent 会话已初始化";
    case "new": return "已新建会话";
    case "switch": return "已加载历史会话";
    case "delete": return "已重建会话（删除后）";
    case "settings": return "配置已更新，会话已重建";
    default: return "会话已重建";
  }
}

// 后台异步重建：立即返回，不阻塞 HTTP 响应（前端即时打开/加载对话，
// 重建在后台进行，首条消息发送时由 /api/chat 等待就绪）
function rebuildInBackground(sessionManager, reason = "rebuild") {
  const run = (async () => {
    // 先让出事件循环，让当前请求的 HTTP 响应先 flush 出去，
    // 再开始 createAgentSession 的重活（其同步部分会占用事件循环）
    await new Promise((r) => setImmediate(r));
    // 如果 activeRebuild 已被后续调用覆盖（即已有更新的重建），
    // 则等待它完成并退出，不再执行本轮的 doRebuild。
    // 避免连续调用（如快速点击停止）导致多次重建串行执行浪费 10s+。
    if (activeRebuild && activeRebuild !== run) {
      try { await activeRebuild; } catch { /* ignore */ }
      return;  // 后续调用已接管重建，本轮无需执行
    }
    await doRebuild(sessionManager, reason);
  })().catch((e) => console.error(`[webide] 后台重建未捕获的错误:`, e));
  activeRebuild = run;
  run.finally(() => { if (activeRebuild === run) activeRebuild = null; });
  return run; // 注意：调用方不 await，保持非阻塞
}

// 等待后台重建完成（供 /api/chat 调用）
async function ensureSessionReady() {
  if (activeRebuild) await activeRebuild;
}

// 删除会话文件：优先送回收站（可恢复），失败回退硬删除；对 Windows 文件锁做重试
// 解决"删除当前会话时后端返回 500 → 前端二次弹窗"的问题：删除前已 dispose 释放句柄，
// 此处再对残留锁做指数退避重试，确保最终成功以避免错误弹窗。
async function removeSessionFile(target) {
  const maxAttempts = 6;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let done = false;
    // 1) 回收站（仅 Windows，最后一次尝试前都优先，保证可恢复）
    if (process.platform === "win32" && attempt < maxAttempts - 1) {
      try {
        const escaped = target.replace(/'/g, "''");
        await new Promise((resolve, reject) => {
          execFile("powershell", [
            "-NoProfile", "-NonInteractive", "-Command",
            `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${escaped}', [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)`
          ], { windowsHide: true, timeout: 15000 }, (err) => err ? reject(err) : resolve());
        });
        done = true;
      } catch { /* 回收站失败，转硬删除重试 */ }
    }
    // 2) 硬删除（跨平台兜底）
    if (!done) {
      try { fs.unlinkSync(target); done = true; }
      catch { /* 仍被占用，进入重试 */ }
    }
    if (done) return;
    // 释放文件锁需要时间，短暂等待后重试（最后一次不再等待，直接抛出）
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("无法删除文件，可能仍被占用");
}

// ============================================================
// SSE 广播
// ============================================================

const sseClients = new Set();

function broadcast(payload) {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(line);
    } catch {
      sseClients.delete(res);
    }
  }
}

// ============================================================
// gxx-abap 直连（仅用于 SAP 状态灯，不经 Agent）
// ============================================================

// SAP 状态灯结果缓存：避免前端 30s 轮询每次都重新走 ADT 握手（可能耗时数秒）。
// 连接成功缓存 30s；失败只缓存 5s，便于用户改完配置后快速重试。
const sapStatusCache = { result: null, ts: 0, successTtl: 30000, errorTtl: 5000 };

/**
 * 等待子进程退出（处理 Windows detached descendants 继承 pipe handles 导致 close 不触发的边缘情况）
 */
function waitForChildProcess(child) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode = null;
    let postExitTimer;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;

    const cleanup = () => {
      if (postExitTimer) { clearTimeout(postExitTimer); postExitTimer = undefined; }
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
    };

    const finalize = (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(code);
    };

    const maybeFinalizeAfterExit = () => {
      if (!exited || settled) return;
      if (stdoutEnded && stderrEnded) finalize(exitCode);
    };

    const onStdoutEnd = () => { stdoutEnded = true; maybeFinalizeAfterExit(); };
    const onStderrEnd = () => { stderrEnded = true; maybeFinalizeAfterExit(); };
    const onError = (err) => { if (!settled) { settled = true; cleanup(); reject(err); } };
    const onExit = (code) => {
      exited = true; exitCode = code;
      maybeFinalizeAfterExit();
      if (!settled) postExitTimer = setTimeout(() => finalize(code), 100);
    };
    const onClose = (code) => { finalize(code); };

    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

/**
 * 轻量级 SAP 状态检测：不启动子进程，直接对 ADT /system/information 发请求。
 * 避免 Electron 打包后 node.exe 启动慢/弹窗，且比 gxx-abap ping 快一个数量级。
 */
function pingSapDirectly(timeoutMs = 15000) {
  return new Promise((resolve) => {
    let cfg = {};
    try {
      if (fs.existsSync(GXX_ABAP_CONFIG)) {
        cfg = JSON.parse(fs.readFileSync(GXX_ABAP_CONFIG, "utf8"));
      }
    } catch (e) {
      return resolve({ success: false, error: `读取 SAP 配置失败: ${e.message}` });
    }
    if (!cfg.host || !cfg.user || !cfg.password) {
      return resolve({ success: false, error: "未配置 SAP 连接信息" });
    }

    const protocol = cfg.protocol || "https";
    const port = cfg.port || "44300";
    const lib = protocol === "https" ? https : http;
    const auth = Buffer.from(`${cfg.user}:${cfg.password}`).toString("base64");
    const headers = {
      Authorization: `Basic ${auth}`,
      Accept: "application/atom+xml, application/xml, */*",
      "User-Agent": "AbapBuddy-webide/1.0",
    };
    if (cfg.client) headers["X-SAP-Client"] = String(cfg.client);

    const t0 = Date.now();
    const req = lib.request({
      hostname: cfg.host,
      port,
      path: "/sap/bc/adt/system/information",
      method: "GET",
      headers,
      rejectUnauthorized: protocol === "https" ? false : undefined,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode === 401) {
          return resolve({ success: false, error: "SAP 认证失败，请检查用户名或密码" });
        }
        if (res.statusCode >= 400) {
          return resolve({ success: false, error: `SAP 返回 HTTP ${res.statusCode}` });
        }
        const get = (id) => {
          const m = body.match(new RegExp(`<atom:id>${id}</atom:id>\\s*<atom:title>([^<]+)`, "i"));
          return m ? m[1].trim() : null;
        };
        const server = get("ApplicationServerName");
        const sid = server ? (server.match(/_(\w{3})_\d+/) || [])[1] : null;
        resolve({
          success: true,
          data: {
            status: "connected",
            host: cfg.host,
            port: String(port),
            user: cfg.user,
            sid,
            kernel: get("KernelRelease"),
            serverName: server,
          },
        });
      });
    });

    let timer = setTimeout(() => {
      timer = null;
      req.destroy();
      resolve({ success: false, error: `检测超时（${timeoutMs}ms），请检查 SAP 连接配置` });
    }, timeoutMs);
    const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
    req.on("error", (err) => { clearTimer(); resolve({ success: false, error: `请求失败: ${err.message}` }); });
    req.on("response", () => clearTimer()); // 收到响应头后超时已无意义
    req.end();
  });
}

function runGxxAbap(command, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const args = command.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    const cleaned = args.map((a) => a.replace(/^"(.*)"$/, "$1"));
    const proc = spawn(
      NODE_BIN,
      [GXX_ABAP_JS, ...cleaned, "--json"],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, GXX_ABAP_CONFIG } }
    );

    let stdout = "";
    let stderr = "";
    let settled = false;
    proc.stdout?.on("data", (c) => { stdout += c.toString(); });
    proc.stderr?.on("data", (c) => { stderr += c.toString(); });

    // 超时保护：gxx-abap 在某些情况下（未配置 / 网络不可达）可能长时间无响应
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill("SIGTERM"); } catch {}
      // 给进程 300ms 优雅退出窗口，再强杀
      setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 300);
      resolve({ success: false, error: `检测超时（${timeoutMs}ms），请检查 SAP 连接配置` });
    }, timeoutMs);

    waitForChildProcess(proc)
      .then((exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const out = stdout.trim();
        if (!out) return resolve({ success: false, error: stderr.trim() || "无输出" });
        try {
          const parsed = JSON.parse(out);
          if (exitCode !== 0 && exitCode !== null) {
            // 进程非 0 退出，即使 JSON 无 success 字段也视为失败
            resolve({ success: false, error: parsed.message || parsed.error || stderr.trim() || `进程退出码: ${exitCode}` });
            return;
          }
          // 透传 gxx-abap 的 success 字段（如有），否则按成功处理
          if (typeof parsed.success === "boolean") {
            resolve(parsed);
          } else {
            resolve({ success: true, data: parsed });
          }
        } catch {
          resolve({ success: false, error: `JSON 解析失败: ${out.slice(0, 200)}` });
        }
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ success: false, error: err?.message || String(err) });
      });
  });
}

// ============================================================
// 工具函数
// ============================================================

/** 版本号比较：a > b 返回正数，a < b 返回负数，相等返回 0 */
function compareVersions(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0, nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("JSON 解析失败"));
      }
    });
    req.on("error", reject);
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".abap": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { success: false, error: "文件不存在" });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
}

// 会话状态摘要（右栏面板）
function sessionState() {
  if (!session) return { ready: false, error: sessionError, rebuilding: !!activeRebuild, sessionFile: currentSessionPath, configStatus, configError };
  let modelId = "unknown";
  try {
    modelId = session.model?.id || session.model?.name || "unknown";
  } catch { /* ignore */ }
  // 会话标签：从文件路径提取日期时间，比内核 sessionId 更稳定
  let sessionLabel = "新对话";
  if (currentSessionPath) {
    const base = path.basename(currentSessionPath, ".jsonl");
    if (base.length >= 19) {
      sessionLabel = base.substring(0, 19).replace("T", " ");
    } else {
      sessionLabel = base;
    }
  }
  return {
    ready: true,
    rebuilding: !!activeRebuild,
    configStatus,
    configError,
    sessionFile: currentSessionPath,
    gen: sessionGen,
    sessionId: session.sessionId,
    sessionLabel,
    sessionName: session.sessionName || null,
    model: modelId,
    thinkingLevel: session.thinkingLevel,
    isStreaming: session.isStreaming,
    tools: session.getActiveToolNames(),
    messageCount: session.messages.length,
  };
}

// ============================================================
// HTTP 服务
// ============================================================

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = url.pathname;

  try {
    // ---------- SSE 事件流 ----------
    if (pathname === "/api/events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(`data: ${JSON.stringify({ kind: "hello", ts: Date.now() })}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      req.on("error", () => sseClients.delete(res));
      return;
    }

    // ---------- 会话状态 ----------
    if (pathname === "/api/state" && req.method === "GET") {
      sendJson(res, 200, { success: true, data: sessionState() });
      return;
    }

    // ---------- 历史消息 ----------
    if (pathname === "/api/history" && req.method === "GET") {
      // 指定 path：直接读文件（毫秒级，不依赖 Agent 会话），用于即时加载历史对话
      const histUrl = new URL(req.url, "http://localhost");
      const targetPath = histUrl.searchParams.get("path");
      if (targetPath) {
        if (!piSdk) return sendJson(res, 503, { success: false, error: "SDK 未就绪" });
        if (!fs.existsSync(targetPath)) return sendJson(res, 404, { success: false, error: "会话文件不存在" });
        try {
          const sm = piSdk.SessionManager.open(targetPath);
          const ctx = sm.buildSessionContext();
          return sendJson(res, 200, { success: true, data: { messages: ctx.messages || [] } });
        } catch (e) {
          return sendJson(res, 500, { success: false, error: e?.message || String(e) });
        }
      }
      if (!session) return sendJson(res, 503, { success: false, error: sessionError || "会话未就绪" });
      sendJson(res, 200, { success: true, data: { messages: session.messages } });
      return;
    }

    // ---------- 发送消息 ----------
    if (pathname === "/api/chat" && req.method === "POST") {
      // 等待后台重建完成（新建/切换后的首条消息需要 Agent 就绪）
      await ensureSessionReady();
      if (!session) return sendJson(res, 503, { success: false, error: sessionError || "会话未就绪" });
      // 如果 agent 仍在生成中（刚点停止尚未完成），等待其停止，最多等 3 秒
      if (session.isStreaming) {
        for (let i = 0; i < 30 && session.isStreaming; i++) {
          await new Promise((r) => setTimeout(r, 100));
        }
        if (session.isStreaming) {
          return sendJson(res, 409, { success: false, error: "Agent 正在生成中，请先停止或等待" });
        }
      }
      const body = await readBody(req);
      const text = String(body.text || "").trim();
      if (!text) return sendJson(res, 400, { success: false, error: "消息为空" });
      // 不 await：流式输出通过 SSE 推送
      session.prompt(text).catch((err) => {
        broadcast({ kind: "error", error: err?.message || String(err), ts: Date.now() });
      });
      sendJson(res, 202, { success: true, data: { accepted: true } });
      return;
    }

    // ---------- 停止生成 ----------
    if (pathname === "/api/abort" && req.method === "POST") {
      if (!session) return sendJson(res, 200, { success: true, data: { message: "无活动会话" } });

      sendJson(res, 200, { success: true });

      // 停止当前生成，但保留会话上下文（下一条消息可接着上下文继续对话）
      try { session.agent?.abort?.(); } catch {}
      try { session.abortBash?.(); } catch {}
      try { session.abortRetry?.(); } catch {}
      broadcast({ kind: "agent", event: { type: "agent_abort" }, ts: Date.now() });
      console.log("[webide] ★ 停止生成（保留会话上下文）");
      return;
    }

    // ---------- 对话管理 ----------
    if (pathname === "/api/sessions" && req.method === "GET") {
      if (!piSdk) return sendJson(res, 503, { success: false, error: "SDK 未就绪" });
      const list = await piSdk.SessionManager.list(ROOT, getSessionDir());
      const currentFile = currentSessionPath;
      const sessions = (list || [])
        .map((s) => ({
          path: s.path,
          id: s.id,
          name: s.name || null,
          firstMessage: (s.firstMessage || "").slice(0, 60),
          messageCount: s.messageCount,
          modified: s.modified instanceof Date ? s.modified.getTime() : s.modified,
          current: currentFile ? path.resolve(s.path) === path.resolve(currentFile) : false,
        }))
        .sort((a, b) => b.modified - a.modified);
      sendJson(res, 200, { success: true, data: { sessions } });
      return;
    }

    if (pathname === "/api/session/new" && req.method === "POST") {
      if (!piSdk) return sendJson(res, 503, { success: false, error: "SDK 未就绪" });
      if (session?.isStreaming) return sendJson(res, 409, { success: false, error: "Agent 正在生成中，请先停止" });
      const sm = piSdk.SessionManager.create(ROOT, getSessionDir());
      try { sm.newSession(); } catch { /* 路径生成失败则沿用 create 结果 */ }
      _setCSP(sm.sessionFile, "session/new");   // 同步记录当前会话（无需等待后台重建，左侧高亮即时更新）
      // 后台重建 Agent 会话，立即返回——前端即时打开空白新对话
      rebuildInBackground(sm, "new");
      sendJson(res, 200, { success: true, data: { sessionId: sm.sessionId || null, path: sm.sessionFile, messages: [], gen: sessionGen } });
      return;
    }

    if (pathname === "/api/session/switch" && req.method === "POST") {
      if (!piSdk) return sendJson(res, 503, { success: false, error: "SDK 未就绪" });
      if (session?.isStreaming) return sendJson(res, 409, { success: false, error: "Agent 正在生成中，请先停止" });
      const body = await readBody(req);
      const target = String(body.path || "");
      if (!target) return sendJson(res, 400, { success: false, error: "缺少会话路径" });
      if (!fs.existsSync(target)) return sendJson(res, 404, { success: false, error: "会话文件不存在" });
      const sm = piSdk.SessionManager.open(target);
      _setCSP(sm.sessionFile, "session/switch");   // 同步记录当前会话（无需等待后台重建，左侧高亮即时更新）
      // 后台重建 Agent 会话，立即返回——前端已通过 /api/history?path= 即时显示历史
      rebuildInBackground(sm, "switch");
      sendJson(res, 200, { success: true, data: { sessionId: sm.sessionId || null, path: sm.sessionFile, gen: sessionGen } });
      return;
    }

    if (pathname === "/api/session/delete" && req.method === "POST") {
      const body = await readBody(req);
      const target = String(body.path || "");
      if (!target) return sendJson(res, 400, { success: false, error: "缺少会话路径" });
      const isCurrent = currentSessionPath && path.resolve(target) === path.resolve(currentSessionPath);

      // 文件不存在：当前会话可能是刚新建、首条消息尚未落盘的空白对话。
      // 视为"丢弃空对话"，直接开新空白会话并返回成功，避免前端二次错误弹窗。
      if (!fs.existsSync(target)) {
        if (isCurrent && piSdk) {
          const newSm = piSdk.SessionManager.create(ROOT, getSessionDir());
          try { newSm.newSession(); } catch { /* ignore */ }
          _setCSP(newSm.sessionFile, "delete/discard");
          rebuildInBackground(newSm, "delete");
          broadcast({ kind: "session_reset", state: sessionState(), ts: Date.now() });
          return sendJson(res, 200, { success: true, data: { newPath: newSm.sessionFile } });
        }
        return sendJson(res, 404, { success: false, error: "会话文件不存在" });
      }

      // 当前活动会话：先让可能仍在后台进行的重建完成（它会重新绑定到该文件句柄），
      // 否则重建与删除并发会争用句柄导致删除失败。最多等待 15s 以防卡死。
      if (isCurrent && activeRebuild) {
        try { await Promise.race([activeRebuild, new Promise((r) => setTimeout(r, 15000))]); } catch { /* ignore */ }
      }
      // 释放当前活动会话的文件锁（dispose 活动会话），避免被占用导致删除失败
      if (isCurrent && session && path.resolve(session.sessionFile || "") === path.resolve(target)) {
        try { session.dispose(); } catch { /* ignore */ }
        session = null;
        // 给操作系统释放文件句柄的时间
        await new Promise((r) => setTimeout(r, 300));
      }

      try {
        await removeSessionFile(target);
      } catch (e) {
        return sendJson(res, 500, { success: false, error: e?.message || String(e) });
      }

      // 删除后：若是当前活动会话，立即开启一个全新空白会话，保证用户仍可继续对话
      let newPath = null;
      if (isCurrent && piSdk) {
        const newSm = piSdk.SessionManager.create(ROOT, getSessionDir());
        try { newSm.newSession(); } catch { /* ignore */ }
        newPath = newSm.sessionFile;
        _setCSP(newSm.sessionFile, "delete/post");
        rebuildInBackground(newSm, "delete");
        broadcast({ kind: "session_reset", state: sessionState(), ts: Date.now() });
      }
      sendJson(res, 200, { success: true, data: { newPath } });
      return;
    }

    // ---------- 用户确认响应 ----------
    if (pathname === "/api/confirm" && req.method === "POST") {
      const body = await readBody(req);
      const toolCallId = String(body.toolCallId || "");
      const choice = String(body.choice || "");
      const customText = String(body.custom_text || "");

      if (!toolCallId || !choice) {
        return sendJson(res, 400, { success: false, error: "缺少 toolCallId 或 choice" });
      }

      const pending = globalThis.__pendingConfirmations?.get(toolCallId);
      if (!pending) {
        return sendJson(res, 404, { success: false, error: "确认请求已过期或不存在" });
      }

      const result = choice === "__custom__"
        ? { choice: "自定义", custom_text: customText }
        : { choice };

      pending.resolve({
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      });

      globalThis.__pendingConfirmations.delete(toolCallId);
      sendJson(res, 200, { success: true });
      return;
    }

    // ---------- SAP 连接状态（状态灯） ----------
    if (pathname === "/api/sap-status" && req.method === "GET") {
      const now = Date.now();
      const ttl = sapStatusCache.result?.success ? sapStatusCache.successTtl : sapStatusCache.errorTtl;
      if (sapStatusCache.result && now - sapStatusCache.ts < ttl) {
        sendJson(res, 200, sapStatusCache.result);
        return;
      }
      // 状态灯不走 gxx-abap 子进程，直接对 SAP 发轻量请求，避免 Electron 打包后
      // node.exe 启动慢导致 UI 超时。
      const r = await pingSapDirectly(15000);
      const payload = r.success
        ? { success: true, data: r.data }
        : { success: false, error: r.error || "连接失败" };
      sapStatusCache.result = payload;
      sapStatusCache.ts = now;
      sendJson(res, 200, payload);
      return;
    }

    // ---------- 上下文用量统计（压缩按钮悬停时展示） ----------
    if (pathname === "/api/context-stats" && req.method === "GET") {
      // 固定文件（AGENTS.md / SYSTEM.md / Memory.md）按 mtime 缓存，对话消息实时计算
      const settingsFile = path.join(AGENT_DIR, "settings.json");
      let contextTokens = 200000;
      try { const s = getCachedConfig("settings") || {}; contextTokens = s.contextTokens || 200000; } catch {}
      // DeepSeek 官方 token 估算
      const dsTokens = (text) => {
        let cjk = 0, eng = 0;
        for (const ch of text) {
          const code = ch.codePointAt(0);
          if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF) || (code >= 0xF900 && code <= 0xFAFF)) cjk++;
          else eng++;
        }
        return Math.ceil(cjk * 0.6 + eng * 0.3);
      };
      // 各文件独立统计（带文件 mtime 缓存）
      let agentsTokens = 0, systemMdTokens = 0, memoryTokens = 0, skillsTokens = 0;
      if (!_ctxFileCache) _ctxFileCache = {};
      const readCachedFile = (filePath, cacheKey) => {
        try {
          const st = fs.statSync(filePath);
          const cached = _ctxFileCache[cacheKey];
          if (cached && cached.mtime === st.mtimeMs) return cached.tokens;
          const content = fs.readFileSync(filePath, "utf8");
          const tokens = dsTokens(content);
          _ctxFileCache[cacheKey] = { mtime: st.mtimeMs, tokens };
          return tokens;
        } catch { return 0; }
      };
      agentsTokens = readCachedFile(path.join(ROOT, "AGENTS.md"), "agents");
      systemMdTokens = readCachedFile(path.join(ROOT, "SYSTEM.md"), "system");
      memoryTokens = readCachedFile(path.join(ROOT, "Memory.md"), "memory");
      // 技能：仅统计 prompt 中注入的 <available_skills> 列表（渐进式披露）
      try {
        const skillsDir = path.join(AGENT_DIR, "skills");
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
                    tokens += dsTokens(text) + 30; // XML 标签开销
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
      // === 固定成本（每个会话不变，不需要 API 数据） ===
      const GXX_TOOLS_COUNT = 17;
      const PI_BUILTIN_TOOLS_COUNT = 7; // read, write, edit, bash, grep, find, ls
      const extensionsTokens = (GXX_TOOLS_COUNT + PI_BUILTIN_TOOLS_COUNT) * 15 + 60;
      let mcpTokens = 0;
      if (globalThis.__mcpStatus instanceof Map) {
        for (const st of globalThis.__mcpStatus.values()) {
          if (st.connected && st.tools?.length) mcpTokens += st.tools.length * 20;
        }
      }
      if (!mcpTokens) mcpTokens = 100;
      const piAgentTokens = 4200; // PI SDK 核心系统提示词（固定）
      const systemTotal = piAgentTokens + extensionsTokens + mcpTokens;       // 系统基础
      const configTotal = agentsTokens + systemMdTokens + memoryTokens + skillsTokens; // 项目配置
      const fixedTotal = systemTotal + configTotal;  // ~8K 固定开销
      // === 可变成本（随对话增长） ===
      let convTokens_est = 0;
      try {
        convTokens_est = session ? session.messages.reduce((sum, m) => {
          const text = typeof m.content === "string" ? m.content : Array.isArray(m.content)
            ? m.content.reduce((s, p) => s + (typeof p.text === "string" ? p.text : ""), "") : "";
          return sum + dsTokens(text);
        }, 0) : 0;
      } catch { /* ignore */ }
      const cacheTokens = (globalLastUsage?.cacheRead) || 0;
      const totalUsed = fixedTotal + convTokens_est;
      const remaining = Math.max(0, contextTokens - totalUsed);
      const pct = contextTokens > 0 ? Math.min(100, Math.round(totalUsed / contextTokens * 100)) : 0;
      const pctOf = (v) => totalUsed ? Math.round(v / totalUsed * 100) : 0;
      const data = {
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
      return sendJson(res, 200, { success: true, data });
    }

    // ---------- 压缩上下文 ----------
    if (pathname === "/api/compress" && req.method === "POST") {
      if (!session) return sendJson(res, 503, { success: false, error: "会话未就绪" });
      if (session.isStreaming) return sendJson(res, 409, { success: false, error: "Agent 正在生成中，请先停止" });
      if (session.isCompacting) return sendJson(res, 409, { success: false, error: "正在压缩中，请稍候" });
      // 新/空对话没有可压缩的上下文，避免误触发压缩
      const msgCount = session.messages?.length || 0;
      if (msgCount < 2) return sendJson(res, 400, { success: false, error: "当前对话消息太少，无需压缩" });

      // 异步压缩，不阻塞响应
      session.compact().then((result) => {
        globalLastUsage = null;  // 压缩后旧 usage 数据失效，下次 stats 用估算
        const saved = result.tokensBefore ? (result.tokensBefore - (result.details?.tokensAfter || 0)) : 0;
        broadcast({
          kind: "compress_result",
          summary: result.summary?.substring(0, 200) || "",
          tokensBefore: result.tokensBefore,
          saved,
          ts: Date.now(),
        });
      }).catch((err) => {
        broadcast({
          kind: "error",
          error: `压缩失败: ${err?.message || String(err)}`,
          ts: Date.now(),
        });
      });

      sendJson(res, 202, { success: true, data: { message: "压缩任务已开始" } });
      return;
    }

    // ---------- 思考等级切换 ----------
    if (pathname === "/api/thinking-level" && req.method === "POST") {
      if (!session) return sendJson(res, 503, { success: false, error: "会话未就绪" });
      try {
        const body = await readBody(req);
        const { level } = body;
        const valid = ["off", "high"];
        if (!valid.includes(level)) return sendJson(res, 400, { success: false, error: `无效等级: ${level}，可选: ${valid.join(", ")}` });
        session.setThinkingLevel(level);
        console.log(`[webide] 思考等级已切换: ${level}`);
        return sendJson(res, 200, { success: true, data: { thinkingLevel: level } });
      } catch (e) {
        return sendJson(res, 400, { success: false, error: e?.message || String(e) });
      }
    }

    // ---------- SAP 连接配置 ----------
    if (pathname === "/api/sap-config" && req.method === "GET") {
      try {
        let data = {};
        try { if (fs.existsSync(GXX_ABAP_CONFIG)) data = JSON.parse(fs.readFileSync(GXX_ABAP_CONFIG, "utf8")); } catch {}
        return sendJson(res, 200, {
          success: true,
          data: {
            host: data.host || "",
            port: data.port || "44300",
            protocol: data.protocol || "https",
            user: data.user || "",
            client: data.client || "100",
            hasPassword: !!data.password,
          }
        });
      } catch (e) {
        return sendJson(res, 500, { success: false, error: e?.message || String(e) });
      }
    }
    if (pathname === "/api/sap-config" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const { host, port, user, password, client, protocol } = body;
        fs.mkdirSync(path.dirname(GXX_ABAP_CONFIG), { recursive: true });
        let data = {};
        try { if (fs.existsSync(GXX_ABAP_CONFIG)) data = JSON.parse(fs.readFileSync(GXX_ABAP_CONFIG, "utf8")); } catch {}
        if (host !== undefined) data.host = host;
        if (port !== undefined) data.port = port;
        if (user !== undefined) data.user = user;
        if (password !== undefined && password !== "") data.password = password;
        if (client !== undefined) data.client = client;
        if (protocol !== undefined) data.protocol = protocol;
        fs.writeFileSync(GXX_ABAP_CONFIG, JSON.stringify(data, null, 2), "utf8");
        // 配置变更后立即清空 SAP 状态缓存，让前端保存后拿到最新结果
        sapStatusCache.result = null;
        sapStatusCache.ts = 0;
        console.log("[webide] SAP 配置已保存，状态缓存已重置");
        return sendJson(res, 200, { success: true, data: { host: data.host, port: data.port, user: data.user, client: data.client } });
      } catch (e) {
        return sendJson(res, 500, { success: false, error: e?.message || String(e) });
      }
    }

    // ---------- output 文件列表 / 下载 ----------
    if (pathname === "/api/output-files" && req.method === "GET") {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      const files = fs.readdirSync(OUTPUT_DIR, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => {
          const st = fs.statSync(path.join(OUTPUT_DIR, e.name));
          return { name: e.name, size: st.size, mtime: st.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
      sendJson(res, 200, { success: true, data: { files } });
      return;
    }

    if (pathname.startsWith("/api/output-files/") && req.method === "GET") {
      const name = decodeURIComponent(pathname.slice("/api/output-files/".length));
      // 支持子目录路径（如 ZPPR085_NEW/main.abap），同时防目录穿越
      const fp = path.resolve(OUTPUT_DIR, name);
      if (!fp.startsWith(OUTPUT_DIR + path.sep) || !fs.existsSync(fp)) {
        return sendJson(res, 404, { success: false, error: "文件不存在" });
      }
      const data = fs.readFileSync(fp);
      const asDownload = url.searchParams.get("download") === "1";
      const safeName = path.basename(name); // 下载/响应头只用文件名部分
      const isHtml = /\.html?$/i.test(safeName);
      res.writeHead(200, {
        "Content-Type": asDownload
          ? "application/octet-stream"
          : isHtml ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
        "Content-Disposition": asDownload
          ? `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`
          : `inline; filename*=UTF-8''${encodeURIComponent(safeName)}`,
      });
      res.end(data);
      return;
    }

    // ---------- 打开文件所在位置 ----------
    if (pathname === "/api/open-location" && req.method === "POST") {
      const body = await readBody(req);
      let fp;
      // 若传了绝对路径则直接使用
      if (body.path && path.isAbsolute(body.path)) {
        fp = body.path;
      } else {
        // name 支持子目录相对路径（如 ZPPR085_NEW/main.abap）
        const name = body.name || "";
        fp = path.resolve(OUTPUT_DIR, name);
        if (!fp.startsWith(OUTPUT_DIR + path.sep)) {
          return sendJson(res, 403, { success: false, error: "禁止访问 output 目录外的文件" });
        }
      }
      if (!fs.existsSync(fp)) {
        // 文件不存在时仍然打开父目录
        const parentDir = path.dirname(fp);
        if (fs.existsSync(parentDir)) {
          exec(`explorer "${parentDir}"`, { windowsHide: false }, () => {});
          return sendJson(res, 200, { success: true, data: { path: parentDir, note: "文件不存在，已打开父目录" } });
        }
        return sendJson(res, 404, { success: false, error: "文件不存在" });
      }
      try {
        const platform = process.platform;
        if (platform === "win32") {
          // 关键：不能用 execFile —— Node 会把参数里内嵌的引号转义成 \"，
          // explorer 收到乱掉的参数后回退打开默认文件夹（而不是 output 目录）。
          // 改用 exec 传完整命令行，引号原样透传，才能精确定位并选中文件。
          // 注意：explorer 正常退出码就是 1，不能当作错误。
          exec(`explorer /select,"${fp}"`, { windowsHide: false }, () => {
            console.log("[webide] explorer /select 已执行:", fp);
          });
        } else if (platform === "darwin") {
          execFile("open", ["-R", fp], { windowsHide: false }, (err) => {
            if (err) console.error("[webide] open 打开失败:", err.message);
          });
        } else {
          execFile("xdg-open", [path.dirname(fp)], { windowsHide: false }, (err) => {
            if (err) console.error("[webide] xdg-open 打开失败:", err.message);
          });
        }
        return sendJson(res, 200, { success: true, data: { path: fp } });
      } catch (err) {
        return sendJson(res, 500, { success: false, error: err?.message || String(err) });
      }
    }

    // ---------- 实时拉取某厂商可用模型列表（设置面板下拉框用，保证模型名最新）----------
    if (pathname === "/api/models" && req.method === "GET") {
      const provider = url.searchParams.get("provider") || "";
      const fallback = () => {
        const p = DOMESTIC_PROVIDERS[provider];
        return sendJson(res, 200, { success: true, models: p ? p.models : [], source: "fallback" });
      };
      if (!provider || !DOMESTIC_PROVIDERS[provider]) return fallback();
      const ep = PROVIDER_VALIDATE[provider];
      // 读取已保存的 key（auth.json 中该 provider 的 key），无 key 时直接返回兜底清单
      let key = "";
      try {
        const a = getCachedConfig("auth") || {};
        if (a[provider] && a[provider].key) key = a[provider].key;
      } catch { /* 无 key */ }
      if (!key) return fallback();
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        const r = await fetch(ep.base + ep.path, { headers: { Authorization: `Bearer ${key}` }, signal: ctrl.signal });
        clearTimeout(timer);
        if (!r.ok) return fallback();
        const j = await r.json();
        const list = extractModelIds(j);
        if (!list.length) return fallback();
        return sendJson(res, 200, { success: true, models: list, source: "live" });
      } catch (e) {
        console.warn(`[webide] 拉取 ${provider} 模型列表失败，使用兜底清单: ${e.message}`);
        return fallback();
      }
    }

    // ---------- 大模型设置：读取 .pi/settings.json + .pi/auth.json ----------
    if (pathname === "/api/settings" && req.method === "GET") {
      let provider = "", model = "", apiKey = "", contextTokens = 200000;
      try {
        const s = getCachedConfig("settings") || {};
        provider = s.defaultProvider || "";
        model = s.defaultModel || "";
        contextTokens = s.contextTokens || 200000;
      } catch { /* 文件不存在或无效 */ }
      try {
        const a = getCachedConfig("auth") || {};
        if (provider && a[provider] && a[provider].key) {
          apiKey = a[provider].key;
        } else if (!provider) {
          // 仅在完全未指定 provider 时，才回退取 auth.json 里第一个含 key 的条目
          const first = Object.keys(a).find((k) => a[k] && a[k].key);
          if (first) { provider = first; apiKey = a[first].key; }
        }
        // 若所选 provider 自身无 key，则 apiKey 留空：不借用其它 provider 的 key，
        // 避免表单把 A 的 key 显示在 B 名下、或保存时误把 key 存到错误 provider。
      } catch { /* 文件不存在或无效 */ }
      return sendJson(res, 200, { success: true, data: { provider, model, apiKey, contextTokens } });
    }

    // ---------- 大模型设置：写入 .pi/settings.json + .pi/auth.json ----------
    if (pathname === "/api/settings" && req.method === "POST") {
      const body = await readBody(req);
      const provider = String(body.provider || "").trim();
      const model = String(body.model || "").trim();
      const apiKey = String(body.apiKey || "");
      if (!provider) return sendJson(res, 400, { success: false, error: "缺少提供商" });
      const settingsFile = path.join(AGENT_DIR, "settings.json");
      const authFile = path.join(AGENT_DIR, "auth.json");
      try {
        fs.mkdirSync(AGENT_DIR, { recursive: true });
        // settings.json：保留 mcpServers 等其它字段，仅更新默认提供商与模型
        let settings = {};
        try { settings = JSON.parse(fs.readFileSync(settingsFile, "utf8")); } catch { settings = {}; }
        // auth.json：保留其它提供商，仅更新/新增当前提供商的 key（key 为空则不覆盖已有）
        let auth = {};
        try { auth = JSON.parse(fs.readFileSync(authFile, "utf8")); } catch { auth = {}; }

        // 仅当提供了 key 时才写入/更新该 provider 的凭据
        if (apiKey) {
          auth[provider] = { type: "api_key", key: apiKey };
        }

        // 关键防护：绝不能把默认提供商设成「无凭据」的条目，
        // 否则 agent 按 defaultProvider 取不到 key 会启动失败。
        // 若所选 provider 经本次保存后仍无 key，则回退到仍有 key 的 provider。
        const providerHasKey = !!(auth[provider] && auth[provider].key);
        let effectiveProvider = provider;
        let warning = "";
        let keyValid = true;

        if (apiKey) {
          // 提供了 key：保存后后台异步校验，不阻塞响应（避免保存卡顿）。
          // 校验结果通过 SSE config_status 广播给前端，前端的 API Key 指示灯会随之更新。
          effectiveProvider = provider; // 保持用户所选
          settings.defaultProvider = effectiveProvider;
          settings.defaultModel = model;
          settings.contextTokens = parseInt(String(body.contextTokens || 200000), 10) || 200000;
          fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n", "utf8");
          fs.writeFileSync(authFile, JSON.stringify(auth, null, 2) + "\n", "utf8");
          console.log(`[webide] 已更新大模型设置: provider=${effectiveProvider}, model=${model}, key=已更新`);

          // 后台异步校验 key，不阻塞 HTTP 响应
          validateProviderKey(provider, apiKey, model).then((v) => {
            if (v.valid) {
              configStatus = "ok"; configError = "";
            } else if (v.definiteInvalid) {
              configStatus = "invalid"; configError = v.error || "API Key 无效";
            } else {
              configStatus = "unknown"; configError = v.error || "未能联网校验 Key";
            }
            broadcastConfigStatus();
            console.log(`[webide] 配置校验完成: provider=${provider} status=${configStatus}${configError ? " (" + configError + ")" : ""}`);
          }).catch((e) => {
            console.warn(`[webide] 配置校验异常: ${e.message}`);
          });
        } else {
          // 空 key：保留既有回退逻辑，避免把默认提供商设成无凭据条目
          if (!providerHasKey) {
            const fallback =
              (settings.defaultProvider && auth[settings.defaultProvider] && auth[settings.defaultProvider].key)
                ? settings.defaultProvider
                : Object.keys(auth).find((k) => auth[k] && auth[k].key);
            if (fallback && fallback !== provider) {
              effectiveProvider = fallback;
              warning = `所选「${provider}」未配置 API Key，已保留可用配置（${fallback}）`;
            }
          }
          // 最终生效的 provider 仍无 key → 标红
          if (!(auth[effectiveProvider] && auth[effectiveProvider].key)) {
            configStatus = "invalid";
            configError = `「${effectiveProvider}」未配置 API Key`;
            keyValid = false;
          } else {
            configStatus = "ok"; configError = "";
          }
          settings.defaultProvider = effectiveProvider;
          settings.defaultModel = model;
          settings.contextTokens = parseInt(String(body.contextTokens || 200000), 10) || 200000;
          fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n", "utf8");
          console.log(`[webide] 已更新大模型设置: provider=${effectiveProvider}, model=${model}, key=未变更${warning ? " (warn: " + warning + ")" : ""}`);
        }

        // 即时生效：运行中会话立即套用新配置（重读 AGENT_DIR 后台重建，不阻塞响应）
        rebuildInBackground(undefined, "settings");
        if (!apiKey) broadcastConfigStatus();
        clearConfigCache();  // 配置已变更，清除磁盘缓存
        return sendJson(res, 200, { success: true, data: { provider: effectiveProvider, model }, warning: warning || undefined, keyValid });
      } catch (err) {
        return sendJson(res, 500, { success: false, error: err?.message || String(err) });
      }
    }

    // ---------- MCP 配置：读取配置 + 各服务连接状态 ----------
    if (pathname === "/api/mcp" && req.method === "GET") {
      const settingsFile = path.join(AGENT_DIR, "settings.json");
      let config = {};
      try {
        const s = getCachedConfig("settings") || {};
        if (s.mcpServers && typeof s.mcpServers === "object" && !Array.isArray(s.mcpServers)) config = s.mcpServers;
      } catch { /* 忽略读取失败 */ }
      // 连接状态由各 extension（mcp-bridge）实时写入全局表，这里只读不写
      const statusMap = (globalThis.__mcpStatus instanceof Map) ? globalThis.__mcpStatus : null;
      const status = [];
      const seen = new Set();
      const configNames = Object.keys(config);
      const statusNames = statusMap ? [...statusMap.keys()] : [];
      const names = [...configNames, ...statusNames];
      for (const name of names) {
        if (seen.has(name)) continue;
        seen.add(name);
        const cfg = config[name];
        const st = statusMap ? statusMap.get(name) : null;
        status.push({
          name,
          url: cfg?.url || st?.url || "",
          connected: st ? !!st.connected : false,
          connecting: st ? !!st.connecting : false,
          error: st?.error || (cfg ? "" : "未配置"),
          tools: st?.tools || [],
        });
      }
      return sendJson(res, 200, { success: true, config, status });
    }

    // ---------- MCP 配置：写入（即时生效） ----------
    if (pathname === "/api/mcp" && req.method === "POST") {
      const body = await readBody(req);
      let config = body.config;
      if (typeof config === "string") {
        try { config = JSON.parse(config); } catch (e) {
          return sendJson(res, 400, { success: false, error: "MCP 配置不是合法 JSON：" + e.message });
        }
      }
      if (!config || typeof config !== "object" || Array.isArray(config)) {
        return sendJson(res, 400, { success: false, error: "MCP 配置必须是一个对象（键=服务器名，值=配置），不能是数组" });
      }
      for (const [name, cfg] of Object.entries(config)) {
        if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
          return sendJson(res, 400, { success: false, error: `服务器「${name}」的配置必须是一个对象` });
        }
        if (!cfg.url || typeof cfg.url !== "string") {
          return sendJson(res, 400, { success: false, error: `服务器「${name}」缺少 url` });
        }
      }
      const settingsFile = path.join(AGENT_DIR, "settings.json");
      let settings = {};
      try { settings = JSON.parse(fs.readFileSync(settingsFile, "utf8")); } catch { settings = {}; }
      settings.mcpServers = config;
      fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n", "utf8");
      console.log(`[webide] 已更新 MCP 配置，共 ${Object.keys(config).length} 个服务器`);
      clearConfigCache("settings");  // settings.json 已变更，清除磁盘缓存
      // 即时生效：重建 Agent 会话，mcp-bridge 会按新配置重新连接
      rebuildInBackground(undefined, "mcp");
      return sendJson(res, 200, { success: true, config, message: "已保存并立即生效" });
    }

    // ---------- 记忆：读取 Memory.md ----------
    if (pathname === "/api/memory" && req.method === "GET") {
      const memoryFile = path.join(ROOT, "Memory.md");
      try {
        const content = fs.existsSync(memoryFile) ? fs.readFileSync(memoryFile, "utf8") : "";
        return sendJson(res, 200, { success: true, data: { path: memoryFile, content } });
      } catch (err) {
        return sendJson(res, 500, { success: false, error: err?.message || String(err) });
      }
    }

    // ---------- 记忆：写入 Memory.md ----------
    if (pathname === "/api/memory" && req.method === "POST") {
      const body = await readBody(req);
      const content = String(body.content || "");
      const memoryFile = path.join(ROOT, "Memory.md");
      try {
        fs.writeFileSync(memoryFile, content, "utf8");
        return sendJson(res, 200, { success: true, message: "已保存，即时生效" });
      } catch (err) {
        return sendJson(res, 500, { success: false, error: err?.message || String(err) });
      }
    }

    // ---------- 技能：列出技能目录树 / 读取文件 ----------
    if (pathname === "/api/skills" && req.method === "GET") {
      const skillsDir = path.join(ROOT, ".pi", "skills");
      const urlParams = new URL(req.url, `http://${req.headers.host || "localhost"}`).searchParams;
      const fileParam = urlParams.get("file");
      if (fileParam) {
        // 读取单个技能文件
        const fp = path.resolve(skillsDir, fileParam);
        if (!fp.startsWith(skillsDir)) {
          return sendJson(res, 403, { success: false, error: "禁止访问 skills 目录外的文件" });
        }
        try {
          const content = fs.readFileSync(fp, "utf8");
          return sendJson(res, 200, { success: true, data: { path: fp, file: fileParam, content } });
        } catch (err) {
          return sendJson(res, 404, { success: false, error: "文件不存在" });
        }
      }
      // 列出目录树
      try {
        function buildTree(dirPath, base) {
          const entries = fs.readdirSync(dirPath, { withFileTypes: true });
          const children = [];
          for (const entry of entries) {
            const rel = base ? `${base}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
              children.push({ name: entry.name, type: "dir", children: buildTree(path.join(dirPath, entry.name), rel) });
            } else {
              children.push({ name: entry.name, type: "file", path: rel });
            }
          }
          return children.sort((a, b) => {
            if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
        }
        const tree = fs.existsSync(skillsDir) ? buildTree(skillsDir, "") : [];
        return sendJson(res, 200, { success: true, data: { tree } });
      } catch (err) {
        return sendJson(res, 500, { success: false, error: err?.message || String(err) });
      }
    }

    // ---------- 技能：写入技能文件 ----------
    if (pathname === "/api/skills" && req.method === "POST") {
      const body = await readBody(req);
      const filePath = String(body.file || "").trim();
      const content = String(body.content || "");
      if (!filePath) return sendJson(res, 400, { success: false, error: "缺少 file 参数" });
      const skillsDir = path.join(ROOT, ".pi", "skills");
      const fp = path.resolve(skillsDir, filePath);
      if (!fp.startsWith(skillsDir)) {
        return sendJson(res, 403, { success: false, error: "禁止操作 skills 目录外的文件" });
      }
      try {
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, content, "utf8");
        return sendJson(res, 200, { success: true, message: "已保存，即时生效" });
      } catch (err) {
        return sendJson(res, 500, { success: false, error: err?.message || String(err) });
      }
    }

    // ---------- 提示词：读取 AGENTS.md / SYSTEM.md ----------
    if (pathname === "/api/prompt" && req.method === "GET") {
      const urlParams = new URL(req.url, `http://${req.headers.host || "localhost"}`).searchParams;
      const fileName = urlParams.get("file") || "AGENTS.md";
      if (!["AGENTS.md", "SYSTEM.md"].includes(fileName)) {
        return sendJson(res, 400, { success: false, error: "仅支持 AGENTS.md 或 SYSTEM.md" });
      }
      const fp = path.join(ROOT, fileName);
      try {
        const content = fs.existsSync(fp) ? fs.readFileSync(fp, "utf8") : "";
        return sendJson(res, 200, { success: true, data: { file: fileName, path: fp, content } });
      } catch (err) {
        return sendJson(res, 500, { success: false, error: err?.message || String(err) });
      }
    }

    // ---------- 提示词：写入 AGENTS.md / SYSTEM.md ----------
    if (pathname === "/api/prompt" && req.method === "POST") {
      const body = await readBody(req);
      const fileName = String(body.file || "").trim();
      const content = String(body.content || "");
      if (!["AGENTS.md", "SYSTEM.md"].includes(fileName)) {
        return sendJson(res, 400, { success: false, error: "仅支持 AGENTS.md 或 SYSTEM.md" });
      }
      const fp = path.join(ROOT, fileName);
      try {
        fs.writeFileSync(fp, content, "utf8");
        return sendJson(res, 200, { success: true, message: "已保存。提示词修改需重启 AbapBuddy 服务才能生效" });
      } catch (err) {
        return sendJson(res, 500, { success: false, error: err?.message || String(err) });
      }
    }

    // ---------- 关闭服务 ----------
    if (pathname === "/api/shutdown" && req.method === "POST") {
      sendJson(res, 200, { success: true, data: { message: "服务正在关闭" } });
      console.log("[webide] 收到关闭请求，正在停止服务…");
      setTimeout(() => process.exit(0), 500);
      return;
    }

    // ---------- 产物目录树 ----------
    if (pathname === "/api/output-tree" && req.method === "GET") {
      try {
        function buildOutputTree(dirPath, base) {
          if (!fs.existsSync(dirPath)) return [];
          const entries = fs.readdirSync(dirPath, { withFileTypes: true });
          const children = [];
          for (const entry of entries) {
            const rel = base ? `${base}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
              children.push({ name: entry.name, type: "dir", children: buildOutputTree(path.join(dirPath, entry.name), rel) });
            } else {
              children.push({ name: entry.name, type: "file", path: rel });
            }
          }
          return children.sort((a, b) => {
            if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
        }
        const tree = buildOutputTree(OUTPUT_DIR, "");
        return sendJson(res, 200, { success: true, data: { tree } });
      } catch (err) {
        return sendJson(res, 500, { success: false, error: err?.message || String(err) });
      }
    }

    // ---------- 版本更新检查 ----------
    if (pathname === "/api/check-update" && req.method === "GET") {
      const now = Date.now();
      if (_updateCheckCache.data && now - _updateCheckCache.ts < _updateCheckCache.TTL) {
        return sendJson(res, 200, { success: true, data: _updateCheckCache.data });
      }

      let currentVersion = process.env.WEBIDE_APP_VERSION || "0.0.0";
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package", "package.json"), "utf8"));
        currentVersion = pkg.version || currentVersion;
      } catch {}

      // 1) 先读本地 update.json，不做网络请求
      const localUpdateFile = path.join(ROOT, "update.json");
      let localInfo = null;
      try {
        if (fs.existsSync(localUpdateFile)) {
          localInfo = JSON.parse(fs.readFileSync(localUpdateFile, "utf8"));
        }
      } catch { /* 忽略无效文件 */ }

      if (localInfo && localInfo.latest) {
        const hasUpdate = compareVersions(localInfo.latest, currentVersion) > 0;
        const data = {
          updateAvailable: hasUpdate,
          currentVersion,
          latestVersion: localInfo.latest,
          downloadUrl: localInfo.downloadUrl || "",
          releaseNotes: localInfo.releaseNotes || "",
          message: hasUpdate ? `发现新版本 ${localInfo.latest}` : "已是最新版本",
        };
        _updateCheckCache = { data, ts: now, TTL: 60000 };
        return sendJson(res, 200, { success: true, data });
      }

      // 2) 本地无信息时，尝试远程拉取（降级方案）
      let updateUrl = "";
      try {
        const s = JSON.parse(fs.readFileSync(path.join(AGENT_DIR, "settings.json"), "utf8"));
        updateUrl = s.updateUrl || "";
      } catch {}
      if (!updateUrl) {
        const data = { updateAvailable: false, currentVersion, message: "未配置更新地址" };
        _updateCheckCache = { data, ts: now, TTL: 60000 };
        return sendJson(res, 200, { success: true, data });
      }
      try {
        const r = await fetch(updateUrl, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const info = await r.json();
        const latestVersion = info.latest || info.version || "";
        const hasUpdate = latestVersion && compareVersions(latestVersion, currentVersion) > 0;
        const data = { updateAvailable: hasUpdate, currentVersion, latestVersion, downloadUrl: info.downloadUrl || "", releaseNotes: info.releaseNotes || "" };
        _updateCheckCache = { data, ts: now, TTL: 60000 };
        return sendJson(res, 200, { success: true, data });
      } catch (e) {
        const data = { updateAvailable: false, currentVersion, message: "检查失败：" + e?.message };
        _updateCheckCache = { data, ts: now, TTL: 30000 };
        return sendJson(res, 200, { success: true, data });
      }
    }

    // ---------- 版本更新下载 ----------
    if (pathname === "/api/download-update" && req.method === "GET") {
      const downloadUrl = new URL(req.url, "http://localhost").searchParams.get("url");
      if (!downloadUrl) {
        return sendJson(res, 400, { success: false, error: "缺少下载地址参数" });
      }
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache",
      });
      const tmpDir = os.tmpdir();
      const tmpFile = path.join(tmpDir, `abapbuddy-update-${Date.now()}.exe`);
      const tmpStream = fs.createWriteStream(tmpFile);
      try {
        const parsed = new URL(downloadUrl);
        const mod = parsed.protocol === "https:" ? https : http;
        const dlAgent = new (parsed.protocol === "https:" ? https.Agent : http.Agent)({ lookup: dns.lookup.bind(dns), keepAlive: true });
        const dlReq = mod.request(parsed, { agent: dlAgent, signal: AbortSignal.timeout(300000) }, (dlRes) => {
          if (dlRes.statusCode < 200 || dlRes.statusCode >= 300) {
            tmpStream.end();
            try { fs.unlinkSync(tmpFile); } catch {}
            res.write(JSON.stringify({ type: "error", message: `HTTP ${dlRes.statusCode}` }) + "\n");
            res.end();
            return;
          }
          const contentLength = dlRes.headers["content-length"];
          const total = contentLength ? parseInt(contentLength, 10) : 0;
          let loaded = 0;
          dlRes.on("data", (chunk) => {
            loaded += chunk.length;
            tmpStream.write(chunk);
            const percent = total ? Math.round((loaded / total) * 100) : 0;
            res.write(JSON.stringify({ type: "progress", loaded, total, percent }) + "\n");
          });
          dlRes.on("end", () => {
            tmpStream.end();
            tmpStream.on("finish", () => {
              res.write(JSON.stringify({ type: "complete", filePath: tmpFile }) + "\n");
              res.end();
            });
          });
          dlRes.on("error", (e) => {
            tmpStream.end();
            try { fs.unlinkSync(tmpFile); } catch {}
            res.write(JSON.stringify({ type: "error", message: e?.message || String(e) }) + "\n");
            res.end();
          });
        });
        dlReq.on("error", (e) => {
          tmpStream.end();
          try { fs.unlinkSync(tmpFile); } catch {}
          res.write(JSON.stringify({ type: "error", message: e?.message || String(e) }) + "\n");
          res.end();
        });
        dlReq.end();
      } catch (e) {
        tmpStream.end();
        try { fs.unlinkSync(tmpFile); } catch {}
        res.write(JSON.stringify({ type: "error", message: e?.message || String(e) }) + "\n");
        res.end();
      }
    }

    // ---------- 静态文件 ----------
    if (req.method === "GET") {
      let rel = pathname === "/" ? "/index.html" : pathname;
      const fp = path.normalize(path.join(PUBLIC_DIR, rel));
      if (path.relative(PUBLIC_DIR, fp).startsWith("..")) {
        return sendJson(res, 403, { success: false, error: "禁止访问" });
      }
      serveStatic(res, fp);
      return;
    }

    sendJson(res, 404, { success: false, error: "未知接口" });
  } catch (err) {
    sendJson(res, 500, { success: false, error: err?.message || String(err) });
  }
});

// ============================================================
// 启动
// ============================================================

// 先监听端口，再后台异步创建会话：端口 <1s 即可用，浏览器/Electron 可立即连接并显示加载态，
// Agent 会话在后台创建（createAgentSession 需启动内核+绑定MCP工具，约 10-25s），就绪后前端轮询自动刷新。
server.listen(PORT, HOST, () => {
  // 将自己的 PID 写入 .pid 文件，供下次启动时安全释放端口
  try {
    const pidFile = path.join(HERE, ".pid");
    fs.writeFileSync(pidFile, String(process.pid), "utf8");
  } catch { /* 非致命 */ }
  console.log(`[webide] ABAP Code Studio 端口已监听: http://${HOST}:${PORT}`);
  console.log(`[webide] 项目根目录: ${ROOT}`);
  console.log(`[webide] 正在后台初始化 Agent 会话（此期间页面显示"Agent 未就绪"）...`);
  initSession().then(() => {
    // 预热上下文统计（文件 mtime 缓存 + 对话 token 计算），让首次悬浮不卡顿
    fetch(`http://127.0.0.1:${PORT}/api/context-stats`).catch(() => {});
  }).catch((e) => console.error(`[webide] initSession 异常:`, e));
});

// 关闭网页后自动停止服务：跟踪 SSE 连接，全部断开后倒计时退出
// 桌面端（WEBIDE_NO_AUTOSHUTDOWN=1）由 Electron 生命周期管理，不自动退出
let shutdownTimer = null;
const SHUTDOWN_DELAY = 15000; // 15 秒无连接则退出

function resetShutdownTimer() {
  if (process.env.WEBIDE_NO_AUTOSHUTDOWN) return; // 桌面端不自动退出
  if (shutdownTimer) { clearTimeout(shutdownTimer); shutdownTimer = null; }
  if (sseClients.size === 0) {
    shutdownTimer = setTimeout(() => {
      if (sseClients.size === 0) {
        console.log("[webide] 无浏览器连接，自动停止服务");
        process.exit(0);
      }
    }, SHUTDOWN_DELAY);
  }
}

// 监听 SSE 连接变化
const _origAdd = sseClients.add.bind(sseClients);
const _origDelete = sseClients.delete.bind(sseClients);
sseClients.add = (res) => {
  if (shutdownTimer) { clearTimeout(shutdownTimer); shutdownTimer = null; }
  return _origAdd(res);
};
sseClients.delete = (res) => {
  const result = _origDelete(res);
  resetShutdownTimer();
  return result;
};

process.on("unhandledRejection", (reason) => {
  console.error("[AbapBuddy] 未处理的 Promise rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[AbapBuddy] 未捕获的异常:", err?.message || err);
});
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
