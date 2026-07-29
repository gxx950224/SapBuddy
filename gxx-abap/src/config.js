const fs = require('fs');
const path = require('path');
const os = require('os');

// 项目根目录（gxx-abap/src → gxx-abap → AbapBuddy）
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function resolveConfigPath(p) {
  if (!p) {
    // 默认：先查项目根 .gxx-abap/config.json，其次用户目录 ~/.gxx-abap/config.json
    const projCfg = path.join(PROJECT_ROOT, '.gxx-abap', 'config.json');
    if (fs.existsSync(projCfg)) return projCfg;
    return path.join(os.homedir(), '.gxx-abap', 'config.json');
  }
  if (path.isAbsolute(p)) return p;
  // 相对路径 → 解析到项目根
  return path.resolve(PROJECT_ROOT, p);
}

const CONFIG_FILE = resolveConfigPath(process.env.GXX_ABAP_CONFIG);
const CONFIG_DIR = path.dirname(CONFIG_FILE);

function ensureDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function load() {
  ensureDir();
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return {};
}

function save(data) {
  ensureDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function clear() {
  ensureDir();
  if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE);
}

function getConnection() {
  const c = load();
  if (c.host && c.user && c.password) return c;
  return null;
}

function setConnection(opts) {
  const c = load();
  if (opts.host) c.host = opts.host;
  if (opts.user) c.user = opts.user;
  if (opts.password) c.password = opts.password;
  if (opts.client) c.client = opts.client;
  if (opts.port) c.port = opts.port;
  if (opts.protocol) c.protocol = opts.protocol;
  save(c);
  return c;
}

function showConnection() {
  const c = load();
  if (!c.host) return null;
  return {
    host: c.host,
    port: c.port || '44300',
    user: c.user,
    client: c.client || '100',
    protocol: c.protocol || 'https',
    hasPassword: !!c.password,
  };
}

module.exports = { load, save, clear, getConnection, setConnection, showConnection, CONFIG_FILE };
