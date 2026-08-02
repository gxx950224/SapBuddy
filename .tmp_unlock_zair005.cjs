// 检查/释放 ZAIR005 的锁 (program + include 两个 URI)
const https = require("https");
const { URL } = require("url");

const BASE = "https://10.8.202.35:44300";
const USER = "BC01";
const PASS = "Root..sap1111";
const CLIENT = "100";

const agent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });
let csrf = "";
let cookies = "";

function req(method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + path);
    const h = {
      Authorization: "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64"),
      "x-sap-client": CLIENT,
      "X-sap-adt-sessiontype": "stateful",
      Accept: "*/*",
      ...headers,
    };
    if (cookies) h.Cookie = cookies;
    if (csrf) h["x-csrf-token"] = csrf;
    const r = https.request(
      { method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: h, agent, rejectUnauthorized: false },
      (res) => {
        const setc = res.headers["set-cookie"];
        if (setc) {
          for (const c of setc) {
            const name = c.split("=")[0];
            if (!/SAP_SESSIONID|sap-usercontext/.test(name)) continue;
            const val = c.split(";")[0];
            if (!cookies.includes(name + "=")) cookies += (cookies ? "; " : "") + val;
          }
        }
        if (res.headers["x-csrf-token"]) csrf = res.headers["x-csrf-token"];
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    r.on("error", reject);
    r.end();
  });
}

async function main() {
  let r = await req("GET", "/sap/bc/adt/core/discovery", {
    Accept: "application/vnd.sap.adt.core.discovery+json",
    "x-csrf-token": "fetch",
  });
  console.log("login:", r.status);

  for (const uri of [
    "/sap/bc/adt/programs/includes/zair005",
    "/sap/bc/adt/programs/programs/zair005",
  ]) {
    // 尝试 lock: 成功则返回 handle 并立即 unlock; 失败则输出错误信息
    r = await req("POST", uri + "?_action=LOCK&accessMode=MODIFY", {
      Accept: "application/*,application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result",
    });
    console.log("\nLOCK", uri, "->", r.status);
    console.log("  body:", r.body.slice(0, 300).replace(/\n/g, " "));
    const m = r.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/);
    if (m) {
      r = await req("POST", uri + "?_action=UNLOCK&lockHandle=" + encodeURIComponent(m[1]));
      console.log("  UNLOCK ->", r.status, r.body.slice(0, 200));
    }
  }
  agent.destroy();
}

main().catch((e) => {
  console.error(e);
  agent.destroy();
});
