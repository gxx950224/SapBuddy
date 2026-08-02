// transportInfo: 查询 ZAIR005 的传输/锁信息
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

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
<asx:values><DATA>
<DEVCLASS>$TMP</DEVCLASS>
<OPERATION>I</OPERATION>
<URI>/sap/bc/adt/programs/programs/zair005</URI>
</DATA></asx:values></asx:abap>`;

  r = await req(
    "POST",
    "/sap/bc/adt/cts/transportchecks",
    {
      Accept: "application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.transport.service.checkData",
      "Content-Type": "application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.transport.service.checkData",
    },
    body
  );
  console.log("transportcheck:", r.status);
  console.log(r.body.slice(0, 3000));
  agent.destroy();
}

main().catch((e) => {
  console.error(e);
  agent.destroy();
});
