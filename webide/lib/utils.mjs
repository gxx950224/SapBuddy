/**
 * HTTP 工具函数 — sendJson, readBody, MIME, serveStatic, sessionState
 */

import fs from "node:fs";
import path from "node:path";

export function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

export function readBody(req, limit = 8 * 1024 * 1024) {
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

export const MIME = {
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

export function serveStatic(res, filePath) {
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
export function sessionState(session, currentSessionPath, sessionGen, activeRebuild, configStatus, configError) {
  if (!session) return { ready: false, error: null, rebuilding: !!activeRebuild, sessionFile: currentSessionPath, configStatus, configError };
  let modelId = "unknown";
  try {
    modelId = session.model?.id || session.model?.name || "unknown";
  } catch { /* ignore */ }
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
