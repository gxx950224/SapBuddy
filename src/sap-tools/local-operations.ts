import { readFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import path from "node:path"
import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { parseBashCommand } from "./local-file-policy.js"

/** Keep the familiar command input, but never pass model text to a shell.
 * curl is an HTTPS GET, cat reads the validated upload, and open uses a fixed launcher.
 * This also avoids .bashrc/.curlrc, PATH wrappers and command expansion bypasses.
 */
export function installLocalOperations(pi: ExtensionAPI): void {
  const tool = createBashToolDefinition(process.cwd(), {
    exposeSessionEnvironment: false,
    operations: {
      async exec(command, _cwd, options) {
        const operation = parseBashCommand(command)
        if (!operation) throw new Error("安全拦截：仅允许打开产物、cat 读取上传文本、curl 查询 HTTPS。")
        const deadline = AbortSignal.timeout(Math.min(Math.max(options.timeout ?? 30, 1), 120) * 1000)
        const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
        signal.throwIfAborted()
        if (operation.kind === "upload") {
          options.onData(await readFile(operation.target, { signal }))
        } else if (operation.kind === "https") {
          const response = await fetch(operation.target, { signal, redirect: "error" })
          if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTPS 查询失败：HTTP ${response.status}`) }
          let bytes = 0
          for await (const chunk of response.body ?? []) {
            bytes += chunk.length
            if (bytes > 2 * 1024 * 1024) throw new Error("HTTPS 查询结果超过 2MB，请缩小查询范围。")
            options.onData(Buffer.from(chunk))
          }
        } else {
          const executable = process.platform === "win32"
            ? path.join(process.env.SystemRoot || "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe")
            : process.platform === "darwin" ? "/usr/bin/open" : "/usr/bin/xdg-open"
          const args = process.platform === "win32"
            ? ["-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath $env:SAPBUDDY_ARTIFACT"]
            : [operation.target]
          await new Promise<void>((resolve, reject) => {
            const child = spawn(executable, args, { shell: false, windowsHide: true, signal,
              env: { ...process.env, SAPBUDDY_ARTIFACT: operation.target }, stdio: "ignore" })
            child.once("error", reject)
            child.once("exit", code => code === 0 ? resolve() : reject(new Error(`打开产物失败：${code}`)))
          })
          options.onData(Buffer.from("已请求打开产物。"))
        }
        return { exitCode: 0 }
      },
    },
  })
  pi.registerTool({ ...tool, description: "仅支持固定操作：cat \"上传文本的绝对路径\"、curl -s \"https://网址\"、start \"\" \"产物绝对路径\"（或 open/explorer）。路径使用正斜杠。不执行脚本、管道、重定向或复合命令。Office 上传请用 read 读取提取后的 .txt 文件。" })
}
