/**
 * 可选访问令牌支持（配合 server security.apiKey）
 * - 若服务器开启了 API Key，前端所有请求自动附带 x-api-key
 * - 首次访问若服务器要求 Key 且本地未保存，则提示输入并存入 localStorage
 * - 通过全局 fetch 补丁实现，无需改动各模块的请求调用
 */
(function () {
  "use strict";
  const STORE_KEY = "sapbuddy_bearer";

  function readToken() {
    try { return localStorage.getItem(STORE_KEY) || ""; } catch (e) { return ""; }
  }
  function writeToken(t) {
    try { localStorage.setItem(STORE_KEY, t); } catch (e) { /* 忽略 */ }
  }

  // 有缓存令牌则立即补丁（同步），避免首次加载的请求漏带
  let token = readToken();
  if (token) patchFetch(token);

  // 异步确认服务器是否要求 Key：需要但本地没有 → 提示输入
  fetch("/api/security-status")
    .then((r) => r.json())
    .then((j) => {
      if (j && j.required) {
        if (!token) {
          const t = (window.prompt("此 SapBuddy 实例已开启访问密钥（connections.json security.apiKey）。\n请输入管理员提供的 API Key：", "") || "").trim();
          if (t) { writeToken(t); patchFetch(t); }
        }
      } else if (token) {
        // 服务器不再要求 Key，清理本地缓存
        try { localStorage.removeItem(STORE_KEY); } catch (e) { /* 忽略 */ }
      }
    })
    .catch(() => { /* 服务器未启动或不可达时静默 */ });

  function patchFetch(key) {
    const orig = window.fetch;
    if (orig.__sapbuddyPatched) return;
    window.fetch = function (input, init) {
      const opts = init || {};
      const headers = new Headers(opts.headers || {});
      if (!headers.has("x-api-key")) headers.set("x-api-key", key);
      return orig.call(this, input, { ...opts, headers });
    };
    window.fetch.__sapbuddyPatched = true;
  }
})();
