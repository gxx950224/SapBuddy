const https = require('https');
const http = require('http');
const config = require('./config');

// 保持同一个 HTTP 连接，确保 SAP session 不中断
const keepAliveAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 1,
  rejectUnauthorized: false,
});

class AdtClient {
  constructor() {
    this.reset();
  }

  reset() {
    this.baseUrl = null;
    this.csrfToken = null;
    this.cookie = null;
    this.connConfig = null;
  }

  /** 从配置文件读取连接信息 */
  loadConfig() {
    const c = config.getConnection();
    if (!c) return false;
    this.connConfig = c;
    this.baseUrl = `${c.protocol || 'https'}://${c.host}:${c.port || '44300'}`;
    return true;
  }

  isConnected() {
    return !!this.baseUrl;
  }

  /** 自动连接：读配置 → 获取 cookie → 获取 csrf token */
  async autoConnect() {
    if (!this.loadConfig()) {
      throw new Error('未配置连接信息，请先执行 gxx-abap config');
    }
    // 已经有 cookie 且没过期，直接复用
    if (this.cookie && this.csrfToken) return true;

    const c = this.connConfig;
    const auth = Buffer.from(`${c.user}:${c.password}`).toString('base64');

    // ADT 的 client 通过 X-SAP-Client header 传递
    const sapHeaders = { 'X-SAP-Client': c.client };

    const res = await this._request(`${this.baseUrl}/sap/bc/adt/discovery`, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/atomsvc+xml, application/xml, */*',
        'User-Agent': 'gxx-abap-cli/1.0',
        ...(c.client ? sapHeaders : {}),
      }
    });

    if (res.status === 401) {
      this.reset();
      throw new Error('认证失败，请检查用户名和密码');
    }
    if (res.status >= 400) {
      this.reset();
      throw new Error(`连接失败 (HTTP ${res.status}): ${res.body.substring(0, 200)}`);
    }

    // 存 cookie
    if (res.headers['set-cookie']) {
      const raw = Array.isArray(res.headers['set-cookie'])
        ? res.headers['set-cookie']
        : [res.headers['set-cookie']];
      this.cookie = raw.map(c => c.split(';')[0]).join('; ');
    }

    // 拿 csrf token
    await this._fetchCsrfToken();
    return true;
  }

  /** 测试连接并返回系统信息 */
  async testConnection() {
    await this.autoConnect();
    const info = await this._getSystemInfo();
    return {
      host: this.connConfig?.host,
      port: this.connConfig?.port,
      user: this.connConfig?.user,
      ...info,
    };
  }

  /** 通用请求方法 */
  async request(method, path, options = {}) {
    await this.autoConnect();
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const headers = {
      'Accept': 'application/atom+xml, application/xml, application/json, */*',
      'User-Agent': 'gxx-abap-cli/1.0',
      ...options.headers || {},
    };

    if (this.connConfig?.client) headers['X-SAP-Client'] = this.connConfig.client;
    if (this.cookie) headers['Cookie'] = this.cookie;

    const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase());
    if (isWrite && !this.csrfToken) {
      await this._fetchCsrfToken();
    }
    if (isWrite) headers['X-CSRF-Token'] = this.csrfToken || 'Fetch';

    if (options.body && !headers['Content-Type']) {
      headers['Content-Type'] = options.contentType || 'text/plain; charset=utf-8';
    }

    const res = await this._request(url, {
      method: method.toUpperCase(),
      headers,
      body: options.body,
    });

    if (res.headers['x-csrf-token'] && res.headers['x-csrf-token'] !== 'Fetch') {
      this.csrfToken = res.headers['x-csrf-token'];
    }

    if (res.status >= 300 && res.status < 400 && res.headers['location']) {
      return this.request('GET', res.headers['location'], options);
    }

    return res;
  }

  _request(urlStr, options) {
    return new Promise((resolve) => {
      const url = new URL(urlStr);
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;

      // 同一个 TCP 连接复用 SAP session
      const agent = isHttps ? keepAliveAgent : new http.Agent({ keepAlive: true });
      const req = lib.request({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: options.method || 'GET',
        headers: options.headers || {},
        agent,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      });

      req.on('error', (err) => resolve({ status: 0, headers: {}, body: `请求失败: ${err.message}` }));
      req.setTimeout(30000, () => { req.destroy(); resolve({ status: 0, headers: {}, body: '请求超时' }); });
      if (options.body) req.write(options.body);
      req.end();
    });
  }

  async _fetchCsrfToken() {
    if (!this.baseUrl) return;
    try {
      const csrfHeaders = {
        'X-CSRF-Token': 'Fetch',
        'Accept': 'application/atomsvc+xml, application/xml, */*',
        'User-Agent': 'gxx-abap-cli/1.0',
        'Cookie': this.cookie || '',
      };
      if (this.connConfig?.client) csrfHeaders['X-SAP-Client'] = this.connConfig.client;
      const res = await this._request(`${this.baseUrl}/sap/bc/adt/discovery`, {
        method: 'GET',
        headers: csrfHeaders,
      });
      if (res.headers['x-csrf-token']) this.csrfToken = res.headers['x-csrf-token'];
    } catch (e) { /* ignore */ }
  }

  /** 原始请求 - 绕过 autoConnect 和 CSRF 管理，保持 session 上下文 */
  async rawRequest(method, path, options = {}) {
    if (!this.baseUrl) this.loadConfig();
    if (!this.baseUrl) throw new Error('未配置连接信息，请先执行 gxx-abap config');
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const headers = {
      'Accept': 'application/atomsvc+xml, application/xml, */*',
      'User-Agent': 'gxx-abap-cli/1.0',
      ...options.headers || {},
    };
    if (this.connConfig?.client) headers['X-SAP-Client'] = this.connConfig.client;
    if (this.cookie) headers['Cookie'] = this.cookie;
    const res = await this._request(url, {
      method: method.toUpperCase(),
      headers,
      body: options.body,
    });
    return res;
  }

  /** 销毁 keep-alive 连接，强制 SAP 释放 stateful session */
  destroy() {
    keepAliveAgent.destroy();
  }

  async _getSystemInfo() {
    try {
      const c = this.connConfig;
      const auth = Buffer.from(`${c.user}:${c.password}`).toString('base64');
      const hdr = {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/atom+xml, application/xml, */*',
      };
      if (c.client) hdr['X-SAP-Client'] = c.client;
      if (this.cookie) hdr['Cookie'] = this.cookie;

      const res = await this._request(`${this.baseUrl}/sap/bc/adt/system/information`, {
        method: 'GET',
        headers: hdr,
      });

      if (res.status === 200) {
        const get = (id) => {
          const r = res.body.match(new RegExp(`<atom:id>${id}</atom:id>\\s*<atom:title>([^<]+)`, 'i'));
          return r ? r[1] : null;
        };
        const server = get('ApplicationServerName');
        const sid = server ? (server.match(/_(\w{3})_\d+/) || [])[1] : null;
        const info = { sid, kernel: get('KernelRelease'), serverName: server };
        try {
          const cr = await this._request(`${this.baseUrl}/sap/bc/adt/system/components`, {
            method: 'GET',
            headers: hdr,
          });

          if (cr.status === 200) {
            const m = cr.body.match(/<atom:id>SAP_BASIS<\/atom:id>\s*<atom:title>([^;]+)/);
            if (m) info.basisVersion = m[1].trim();
          }
        } catch (e) { /* ignore */ }
        return info;
      }
    } catch (e) { /* ignore */ }
    return null;
  }
}

module.exports = new AdtClient();
