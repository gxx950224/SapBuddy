/**
 * AI_PUT_UNLOCK 解锁接口
 * 消除 put 和 texts set 命令中的重复解锁代码
 */

/**
 * 调用 SAP 自定义解锁接口 AI_PUT_UNLOCK
 * @param {string} objName - 对象名
 * @returns {Promise<object>} 解锁结果
 */
async function customUnlock(objName) {
  const cfg = require('../config');
  const conn = cfg.getConnection();
  if (!conn) return { status: 'error', message: '未配置连接' };
  const http = require(conn.protocol === 'http' ? 'http' : 'https');
  const auth = Buffer.from(`${conn.user}:${conn.password}`).toString('base64');
  const name = objName.replace(/^.*[/\\]/, '').toUpperCase();
  const postData = JSON.stringify({ GRAG: name });
  return new Promise((resolve) => {
    const req = http.request({
      hostname: conn.host, port: conn.port || '44300',
      path: `/sap/bc/zsx_intf_serv/zsx_oa?sap-client=${conn.client || '100'}&INTFID=AI_PUT_UNLOCK`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}`, 'Content-Length': Buffer.byteLength(postData) },
      rejectUnauthorized: false, timeout: 10000,
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (_) { resolve({ raw: body }); }
      });
    });
    req.on('error', () => resolve({ status: 'error', message: '请求失败' }));
    req.write(postData);
    req.end();
  });
}

/**
 * 静默调用 AI_PUT_UNLOCK（忽略错误，用于 put/texts 的 finally 块）
 * @param {string} objName - 对象名
 * @param {object} client - ADT client 实例（可选，用于销毁连接）
 */
async function silentUnlock(objName, client) {
  try {
    const cfg = require('../config');
    const conn = cfg.getConnection();
    if (conn) {
      const http = require(conn.protocol === 'http' ? 'http' : 'https');
      const auth = Buffer.from(`${conn.user}:${conn.password}`).toString('base64');
      const postData = JSON.stringify({ GRAG: objName.toUpperCase().replace(/^.*[/\\]/, '') });
      const options = {
        hostname: conn.host,
        port: conn.port || '44300',
        path: `/sap/bc/zsx_intf_serv/zsx_oa?sap-client=${conn.client || '100'}&INTFID=AI_PUT_UNLOCK`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${auth}`,
          'Content-Length': Buffer.byteLength(postData),
        },
        rejectUnauthorized: false,
        timeout: 10000,
      };
      await new Promise((resolve, reject) => {
        const req = http.request(options, (res) => { res.resume(); res.on('end', resolve); });
        req.on('error', (e) => { resolve(); });
        req.write(postData);
        req.end();
      });
    }
  } catch (e) { /* 忽略 */ }
  if (client) {
    try { client.destroy(); } catch (e) { /* 忽略 */ }
  }
}

module.exports = { customUnlock, silentUnlock };
