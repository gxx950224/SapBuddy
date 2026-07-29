/**
 * gxx-abap CLI 调用封装 — runGxxAbap, waitForChildProcess
 */

import { spawn } from "node:child_process";
import path from "node:path";

const GXX_ABAP_JS =
  process.env.GXX_ABAP_JS || path.join(import.meta.dirname, "..", "..", "gxx-abap", "bin", "gxx-abap.js");
const GXX_ABAP_CONFIG =
  process.env.GXX_ABAP_CONFIG || path.join(import.meta.dirname, "..", "..", ".gxx-abap", "config.json");

/**
 * 等待子进程退出（处理 Windows detached descendants 继承 pipe handles 导致 close 不触发的边缘情况）
 */
export function waitForChildProcess(child) {
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

export function runGxxAbap(command, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const args = command.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    const cleaned = args.map((a) => a.replace(/^"(.*)"$/, "$1"));
    const proc = spawn(
      process.execPath,
      ["--no-warnings", GXX_ABAP_JS, ...cleaned, "--json"],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, GXX_ABAP_CONFIG } }
    );

    let stdout = "";
    let stderr = "";
    let settled = false;
    proc.stdout?.on("data", (c) => { stdout += c.toString(); });
    proc.stderr?.on("data", (c) => { stderr += c.toString(); });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill("SIGTERM"); } catch {}
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
            resolve({ success: false, error: parsed.message || parsed.error || stderr.trim() || `进程退出码: ${exitCode}` });
            return;
          }
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
