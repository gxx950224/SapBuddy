// 尝试用不同 accessMode 锁 ZAIR005（不存在的对象），以探测/清除编辑状态
const https = require("https");
const { URL } = require("url");

const BASE = "https://10.8.202.35:44300";
const USER = "BC01";
const PASS = "Root..sap1111";
const CLIENT = "100";

const agent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });
let csrf = "";
let cookies = "";

function req(method, path, headers = {}, body) {
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
      (resp) => {
        const setc = resp.headers["set-cookie"];
        if (setc) {
          for (const c of setc) {
            const n = c.split("=")[0];
            if (!/SAP_SESSIONID|sap-usercontext/.test(n)) continue;
            const v = c.split(";")[0];
            if (!cookies.includes(n + "=")) cookies += (cookies ? "; " : "") + v;
          }
        }
        if (resp.headers["x-csrf-token"]) csrf = resp.headers["x-csrf-token"];
        let d = "";
        resp.on("data", (x) => (d += x));
        resp.on("end", () => resolve({ status: resp.statusCode, body: d }));
      }
    );
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

async function main() {
  let r = await req("GET", "/sap/bc/adt/core/discovery", {
    Accept: "application/vnd.sap.adt.core.discovery+json",
    "x-csrf-token": "fetch",
  });
  console.log("login:", r.status);

  for (const mode of ["CREATE", "MODIFY", "DELETE"]) {
    for (const uri of [
      "/sap/bc/adt/programs/includes/zair005",
      "/sap/bc/adt/programs/programs/zair005",
    ]) {
      r = await req("POST", uri + "?_action=LOCK&accessMode=" + mode, {
        Accept: "application/*,application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result",
      });
      console.log(mode, uri, "->", r.status);
      if (r.status === 200) {
        const m = r.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/);
        if (m) {
          const u = await req("POST", uri + "?_action=UNLOCK&lockHandle=" + encodeURIComponent(m[1]));
          console.log("   unlocked ->", u.status);
        }
      } else {
        console.log("   ", r.body.slice(0, 160).replace(/\s+/g, " "));
      }
    }
  }
  agent.destroy();
}

main().catch((e) => {
  console.error(e);
  agent.destroy();
});
