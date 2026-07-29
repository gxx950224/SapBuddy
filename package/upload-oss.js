/**
 * 上传 build 产物到阿里云 OSS
 * 用法：node upload-oss.js [accessKeyId] [accessKeySecret] [bucket] [region]
 * 或设环境变量 OSS_AK_ID / OSS_AK_SECRET
 * 默认 bucket=abapbuddy region=oss-cn-beijing
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const akId = process.argv[2] || process.env.OSS_AK_ID;
const akSecret = process.argv[3] || process.env.OSS_AK_SECRET;
const bucket = process.argv[4] || process.env.OSS_BUCKET || "abapbuddy";
const region = process.argv[5] || process.env.OSS_REGION || "oss-cn-beijing";

if (!akId || !akSecret) {
  console.error("错误：需要 AccessKeyId 和 AccessKeySecret");
  console.error("用法: node upload-oss.js <AccessKeyId> <AccessKeySecret>");
  console.error("或者设置环境变量 OSS_AK_ID 和 OSS_AK_SECRET");
  process.exit(1);
}

const endpoint = `https://${bucket}.${region}.aliyuncs.com`;
const root = path.resolve(__dirname, "..");

const files = [
  { local: path.join(__dirname, "release", "AbapBuddy-setup.exe"), remote: "AbapBuddy-setup.exe", mime: "application/octet-stream" },
  { local: path.join(root, "update.json"), remote: "update.json", mime: "application/json" },
];

function isoDate() {
  return new Date().toUTCString();
}

function hmacSha1(key, str) {
  return crypto.createHmac("sha1", key).update(str).digest("base64");
}

async function upload(localPath, remotePath, mime) {
  if (!fs.existsSync(localPath)) {
    console.log(`[跳过] 本地文件不存在: ${localPath}`);
    return;
  }
  const content = fs.readFileSync(localPath);
  const date = isoDate();
  const md5 = crypto.createHash("md5").update(content).digest("base64");

  const signStr = `PUT\n${md5}\n${mime}\n${date}\n/${bucket}/${remotePath}`;
  const signature = hmacSha1(akSecret, signStr);
  const auth = `OSS ${akId}:${signature}`;

  const url = `${endpoint}/${encodeURIComponent(remotePath)}`;

  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": mime,
        "Content-MD5": md5,
        "Date": date,
        "Authorization": auth,
      },
      body: content,
    });
    if (res.ok) {
      console.log(`[OK] ${remotePath} (${(content.length / 1048576).toFixed(1)}MB)`);
    } else {
      const err = await res.text();
      console.error(`[失败] ${remotePath} HTTP ${res.status}: ${err}`);
    }
  } catch (e) {
    console.error(`[失败] ${remotePath}: ${e.message}`);
  }
}

(async () => {
  console.log(`上传到 ${endpoint}`);
  for (const f of files) {
    await upload(f.local, f.remote, f.mime);
  }
  console.log("完成");
})();
