// afterPack — 打包后清理：只保留 en-US 和 zh-CN 语言包
exports.default = async function (context) {
  const fs = require("fs");
  const path = require("path");
  const localesDir = path.join(context.appOutDir, "locales");
  if (!fs.existsSync(localesDir)) return;
  const keep = new Set(["en-US.pak", "zh-CN.pak", "en-US.pak", "zh.pak"]);
  let removed = 0;
  for (const f of fs.readdirSync(localesDir)) {
    if (!keep.has(f) && f.endsWith(".pak")) {
      fs.unlinkSync(path.join(localesDir, f));
      removed++;
    }
  }
  console.log(`[afterPack] 已清理 ${removed} 个多余语言包`);
};
