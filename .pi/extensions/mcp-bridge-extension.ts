/**
 * MCP Bridge Extension - 通用 MCP 服务器桥接器
 *
 * 从 .pi/settings.json 的 mcpServers 数组读取配置，
 * 支持配置多个 MCP 服务器（不限于 SAP），
 * 动态发现并注册每个服务器的工具。
 *
 * 工具命名规则：mcp__<server-name>__<TOOL_NAME>
 * 连接失败时优雅降级，不阻塞 Agent 启动。
 *
 * 会话重建（rebuild / 切换 / 保存 MCP 配置）后，PI SDK 会：
 *   1. 调用 bindExtensions 以"新会话的有效 pi"重新加载本 extension（全局
 *      __mcpReconnectAll 被刷新为最新 factory 的闭包，pi 对应当前会话）；
 *   2. 触发 withSession(ctx)，此时 ctx/pi 对当前会话有效。
 * 因此重连逻辑必须放在 withSession 回调内、且必须 await，否则 SDK 会在
 * 回调返回后立即让会话上下文失效（"ctx is stale"），导致在途的 MCP 连接被中断。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Agent, fetch as undiciFetch } from "undici";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================
// 配置类型（市场通用 MCP 格式）
// settings.json 中 mcpServers 是一个对象，键为服务器名，值为：
//   { type?: "sse"|"streamable-http", url: string, headers?: {...}, tls?: {...} }
// 同时兼容旧格式（数组 [{ name, url, apiKey, transport, tls }]）。
// ============================================================

interface McpServerConfig {
  name: string;
  type?: "sse" | "streamable-http";
  url: string;
  headers?: Record<string, string>;
  tls?: {
    rejectUnauthorized?: boolean;
  };
}

interface SettingsJson {
  defaultProvider?: string;
  defaultModel?: string;
  mcpServers?: McpServerConfig[] | Record<string, any>;
}

// ============================================================
// 配置加载（每次重连都重新读取，确保保存后的增删即时生效）
// ============================================================

function loadMcpSettings(): McpServerConfig[] {
  const extDir = typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(extDir, "..", "settings.json"),
    path.join(process.cwd(), ".pi", "settings.json"),
    path.join(process.cwd(), "settings.json"),
  ];

  for (const filePath of candidates) {
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, "utf-8");
        const settings: SettingsJson = JSON.parse(raw);
        if (settings.mcpServers) {
          if (Array.isArray(settings.mcpServers)) {
            // 旧格式（兼容）：[{ name, url, apiKey, transport, tls }]
            const arr = settings.mcpServers.map((item: any) => ({
              name: item.name,
              type: item.transport || "streamable-http",
              url: item.url || "",
              headers: item.apiKey ? { "X-API-Key": item.apiKey } : {},
              tls: item.tls,
            }));
            console.log("[mcp-bridge] 从 " + filePath + " 加载了 " + arr.length + " 个 MCP 服务器配置（旧数组格式）");
            return arr;
          } else if (typeof settings.mcpServers === "object") {
            // 新格式（通用）：{ "server-name": { type, url, headers, tls } }
            const arr: McpServerConfig[] = Object.entries(settings.mcpServers).map(([name, cfg]: [string, any]) => ({
              name,
              type: cfg.type || "streamable-http",
              url: cfg.url || "",
              headers: cfg.headers || {},
              tls: cfg.tls,
            }));
            console.log("[mcp-bridge] 从 " + filePath + " 加载了 " + arr.length + " 个 MCP 服务器配置（通用对象格式）");
            return arr;
          }
        }
      }
    } catch (err) {
      console.warn("[mcp-bridge] 读取 " + filePath + " 失败:", err);
    }
  }

  console.log("[mcp-bridge] 未找到 MCP 服务器配置，跳过 MCP 桥接");
  return [];
}

// ============================================================
// 创建 MCP 客户端
// ============================================================

function createMcpClient(
  config: McpServerConfig,
): { client: Client; transport: any } | null {
  try {
    const transportType = config.type || "streamable-http";
    const rejectUnauthorized = config.tls?.rejectUnauthorized ?? true;

    // 构建请求头：合并 config.headers + 通用头
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(config.headers || {}),
    };

    let transport: any;

    if (transportType === "sse") {
      // SSE 传输：使用 SSEClientTransport（MCP SDK 1.x 标记为 deprecated，但仍可用）
      const agent = new Agent({ connect: { rejectUnauthorized } });
      const sseFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        return undiciFetch(input, { ...init, dispatcher: agent }) as Promise<Response>;
      };
      transport = new SSEClientTransport(new URL(config.url), {
        requestInit: { headers },
        fetch: sseFetch,
      });
    } else {
      // streamable-http（默认）：使用 StreamableHTTPClientTransport
      const agent = new Agent({ connect: { rejectUnauthorized } });
      const mcpFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        return undiciFetch(input, { ...init, dispatcher: agent }) as Promise<Response>;
      };
      transport = new StreamableHTTPClientTransport(new URL(config.url), {
        fetch: mcpFetch,
        requestInit: { headers },
      });
    }

    const client = new Client(
      { name: "mcp-bridge-" + config.name, version: "1.0.0" },
      { capabilities: {} },
    );

    return { client, transport };
  } catch (err) {
    console.error("[mcp-bridge] 创建 " + config.name + " 客户端失败:", err);
    return null;
  }
}

// ============================================================
// Extension 入口
// ============================================================

export default function (pi: ExtensionAPI) {
  // 全局状态表：供 Web 后端 /api/mcp 读取各服务连接状态与工具
  const statusMap: any = (globalThis as any).__mcpStatus = (globalThis as any).__mcpStatus || new Map();
  // 当前已建立的 MCP 客户端连接（按服务名索引）
  const connections = new Map<string, Client>();
  // 正在连接中的服务名（防止 session_start 与 withSession 并发双连）
  const connecting = new Set<string>();

  // 重新连接所有 MCP 服务器（读取最新配置 + 清理已移除的服务器）。
  // 必须在 withSession 回调内被 await，确保 pi 对当前会话有效。
  async function reconnectAll() {
    const cfgs = loadMcpSettings();
    const names = new Set(cfgs.map((c) => c.name));

    // 清理已从配置中移除的服务器（关闭连接、清除状态）
    for (const name of [...statusMap.keys()]) {
      if (!names.has(name)) {
        const c = connections.get(name);
        if (c) { try { await c.close(); } catch { /* ignore */ } connections.delete(name); }
        connecting.delete(name);
        statusMap.delete(name);
        console.log("[mcp-bridge] 已移除配置中不再存在的 MCP 服务器: " + name);
      }
    }

    const tasks: Promise<void>[] = [];
    for (const cfg of cfgs) {
      if (connecting.has(cfg.name)) continue; // 已有连接在途，跳过重置与重连
      statusMap.set(cfg.name, { connected: false, connecting: true, error: "", url: cfg.url, tools: [] });
      tasks.push(connectServer(cfg));
    }
    await Promise.all(tasks);
  }

  // 连接单个 MCP 服务器并注册其工具。连接中/已连接时幂等（由 connecting 守卫）。
  async function connectServer(config: McpServerConfig) {
    if (connecting.has(config.name)) return;
    connecting.add(config.name);

    const MAX_ATTEMPTS = 3;
    let lastErr = "";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const pair = createMcpClient(config);
      if (!pair) { connecting.delete(config.name); return; }
      const { client, transport } = pair;

      try {
        await Promise.race([
          client.connect(transport),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("连接超时 (10s)")), 10000),
          ),
        ]);

        const { tools } = await client.listTools();
        connections.set(config.name, client);

        for (const tool of tools) {
          const piToolName = "mcp__" + config.name + "__" + tool.name;
          const parameters =
            tool.inputSchema &&
            typeof tool.inputSchema === "object" &&
            (tool.inputSchema as any).type === "object"
              ? tool.inputSchema
              : { type: "object", properties: {}, additionalProperties: true };

          pi.registerTool({
            name: piToolName,
            label: "[" + config.name + "] " + tool.name,
            description: tool.description || "MCP tool: " + tool.name,
            parameters: parameters as any,
            async execute(_toolCallId, params, signal) {
              const conn = connections.get(config.name);
              if (!conn) {
                throw new Error("[" + config.name + "] MCP 服务器未连接");
              }
              try {
                const result = await conn.callTool(
                  { name: tool.name, arguments: params as Record<string, unknown> },
                  undefined,
                  { signal },
                );
                const contentArr = (result as any)?.content || [];
                const textParts = contentArr
                  .filter((c: any) => c.type === "text")
                  .map((c: any) => c.text);
                const text =
                  textParts.length > 0
                    ? textParts.join("\n")
                    : JSON.stringify(result, null, 2);

                // ABAP_DOWNLOAD：返回文件数组时自动落盘到 output/<对象名>/
                if (tool.name.toUpperCase().includes("DOWNLOAD")) {
                  try {
                    let files: any[] | null = null;
                    const parsed = JSON.parse(text);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                      const first = parsed[0];
                      if (first && typeof first === "object" && !Array.isArray(first)) {
                        files = parsed;
                      }
                    }
                    if (files) {
                      const p = params as any;
                      const objName = p.SOPROG || p.programName || p.functionName
                        || p.objectName || p.name || "download";
                      const safeName = String(objName).replace(/[<>:"/\\|?*]/g, "_");
                      const outputDir = (globalThis as any).__OUTPUT_DIR || path.join(process.cwd(), "output");
                      const subDir = path.join(outputDir, safeName);
                      fs.mkdirSync(subDir, { recursive: true });
                      const saved: string[] = [];
                      for (const file of files) {
                        const fn = file["FILENAME"] || file["文件名"] || file["文件"] || file.filename
                          || file.name || file.PROGRAM || file.PROGNAME || file.NAME || "unknown";
                        const fc = file["CONTENT"] || file["内容"] || file.content || file.text
                          || file.SOURCE || file.CODE || file.source || "";
                        const safeFn = String(fn).replace(/[<>:"/\\|?*]/g, "_");
                        const fp = path.join(subDir, safeFn);
                        if (fs.existsSync(fp)) {
                          fs.appendFileSync(fp, "\n" + fc, "utf8");
                        } else {
                          fs.writeFileSync(fp, fc, "utf8");
                        }
                        saved.push(fp);
                      }
                      console.log("[mcp-bridge] ABAP_DOWNLOAD 已保存 " + saved.length + " 个文件到 " + subDir);
                      return {
                        content: [{
                          type: "text" as const,
                          text: "已下载 " + files.length + " 个文件到 output/" + safeName + "/：\n"
                            + saved.map((f) => "  - " + path.basename(f)).join("\n"),
                        }],
                        details: result,
                      };
                    }
                  } catch { /* 非 JSON 数组��按原文本返回 */ }
                }

                return {
                  content: [{ type: "text" as const, text }],
                  details: result,
                };
              } catch (err: any) {
                throw new Error(
                  "[" + config.name + "] " + tool.name + " 调用失败: " + (err.message || String(err)),
                );
              }
            },
          });
        }

        const toolNames = tools.map((t) => t.name).join(", ");
        console.log("[mcp-bridge] " + config.name + " 已连接，注册 " + tools.length + " 个工具: " + toolNames);
        statusMap.set(config.name, {
          connected: true,
          connecting: false,
          error: "",
          url: config.url,
          tools: tools.map((t) => ({ name: t.name, description: t.description || "" })),
        });
        connecting.delete(config.name);
        return;
      } catch (err: any) {
        lastErr = err?.message || String(err);
        try { await client.close(); } catch { /* ignore */ }

        // 会话替换导致的 ctx 失效：等待后重试（withSession 已 await，重试时上下文已稳定）
        if (/stale/i.test(lastErr) && attempt < MAX_ATTEMPTS) {
          console.log("[mcp-bridge] " + config.name + " 第 " + attempt + " 次连接被会话替换中断，2s 后重试");
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }

        console.error("[mcp-bridge] " + config.name + " 连接失败: " + lastErr);
        statusMap.set(config.name, { connected: false, connecting: false, error: lastErr, url: config.url, tools: [] });
        connecting.delete(config.name);
        return;
      }
    }
    connecting.delete(config.name);
  }

  // 初始会话连接：仅首次触发（flag 跨 factory 复用，因为每次重建都会新建 runner 并重新
  // 执行 factory）。重建/切换后的重连由 server.mjs 的 withSession（已 await）负责——那里
  // 的 ctx 对当前会话有效。若此处也在重建时连接，会因 session_start 未被 SDK await、
  // 会话上下文已失效而抛 "ctx is stale"。
  pi.on("session_start", (_event, _ctx) => {
    const g = globalThis as any;
    if (!g.__mcpInitialConnected) {
      g.__mcpInitialConnected = true;
      reconnectAll().catch(() => {});
    }
  });

  // 供 server.mjs 在会话替换（rebuild / 切换 / 保存 MCP 配置）后重连 MCP。
  // 必须被 withSession 回调 await，确保 pi 对当前会话有效、工具重新注册。
  (globalThis as any).__mcpReconnectAll = () => reconnectAll();

  pi.on("session_shutdown", async () => {
    for (const [_name, client] of connections) {
      try { await client.close(); } catch { /* ignore */ }
    }
    connections.clear();
    connecting.clear();
    console.log("[mcp-bridge] 所有 MCP 连接已断开");
  });

  console.log("[mcp-bridge] MCP 桥接 extension 已加载（" + loadMcpSettings().length + " 个服务器配置）");
}
