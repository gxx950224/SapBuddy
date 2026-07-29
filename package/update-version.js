/**
 * 从 update.json 读取最新版本号，写入 package.json
 * 用法：node update-version.js
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const updateFile = path.join(root, "update.json");
const pkgFile = path.join(__dirname, "package.json");

if (!fs.existsSync(updateFile)) {
  console.log("[版本] update.json 不存在，跳过");
  process.exit(0);
}

function stripBom(s) { return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; }

let update;
try {
  update = JSON.parse(stripBom(fs.readFileSync(updateFile, "utf8")));
} catch (e) {
  console.log("[版本] update.json 解析失败:", e.message);
  process.exit(0);
}

const ver = (update.latest || "").trim();
if (!ver) {
  console.log("[版本] update.json 中 latest 为空，跳过");
  process.exit(0);
}

let pkg;
try {
  pkg = JSON.parse(stripBom(fs.readFileSync(pkgFile, "utf8")));
} catch (e) {
  console.log("[版本] package.json 解析失败:", e.message);
  process.exit(1);
}

pkg.version = ver;
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n", "utf8");
console.log(`[版本] package.json version → ${ver}`);
