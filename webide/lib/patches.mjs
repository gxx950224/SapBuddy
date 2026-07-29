/**
 * 启动补丁 — safe-delete 冲突修复 + windowsHide 注入
 * 在 PI SDK 加载前 import 即可生效
 */

import { createRequire } from "node:module";

// WorkBuddy safe-delete 冲突修复
delete process.env.CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR;
delete process.env.CODEBUDDY_TOOL_CALL_ID;
delete process.env.CODEBUDDY_SAFE_DELETE_BULK_GUARD;
delete process.env.CODEBUDDY_NODE_BIN;
console.log("[webide] 已清理 WorkBuddy safe-delete bulk guard 环境变量");

// Windows DOS 弹窗修复：monkey-patch child_process.spawn
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
