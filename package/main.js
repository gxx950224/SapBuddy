/**
 * AbapBuddy — Electron 桌面壳
 * 启动 webide 后端服务，加载网页版 UI。
 */
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

// WorkBuddy safe-delete 清理
delete process.env.CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR;
delete process.env.CODEBUDDY_TOOL_CALL_ID;
delete process.env.CODEBUDDY_SAFE_DELETE_BULK_GUARD;
delete process.env.CODEBUDDY_NODE_BIN;

const isPackaged = app.isPackaged;
const PROJECT_ROOT = isPackaged ? process.resourcesPath : path.resolve(__dirname, '..');
const WEBIDE_DIR = path.join(PROJECT_ROOT, 'webide');
const PORT = Number(process.env.WEBIDE_PORT || 7400);

// 输出 / Agent 目录：始终相对项目根目录，与源项目一致
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'output');
const AGENT_DIR = path.join(PROJECT_ROOT, '.pi');

let mainWindow = null;
let serverProc = null;

function getNodeBin() {
  if (isPackaged) {
    const bundled = path.join(process.resourcesPath, 'node', 'node.exe');
    if (fs.existsSync(bundled)) return bundled;
  }
  const managed = process.env.WORKBUDDY_NODE || (process.platform === 'win32'
    ? path.join(process.env.USERPROFILE || '~', '.workbuddy', 'binaries', 'node', 'versions', '22.22.2', 'node.exe')
    : 'node');
  if (fs.existsSync(managed)) return managed;
  return 'node';
}

function bootstrapUserData() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(AGENT_DIR, { recursive: true });
}

function startServer() {
  return new Promise((resolve, reject) => {
    const nodeBin = getNodeBin();
    const serverJs = path.join(WEBIDE_DIR, 'server.mjs');
    const env = {
      ...process.env,
      WEBIDE_CWD: PROJECT_ROOT,
      WEBIDE_OUTPUT_DIR: OUTPUT_DIR,
      WEBIDE_AGENT_DIR: AGENT_DIR,
      WEBIDE_NO_AUTOSHUTDOWN: '1',
      WEBIDE_PORT: String(PORT),
      WEBIDE_NODE_BIN: nodeBin,
      WEBIDE_APP_VERSION: require('./package.json').version,
      GXX_ABAP_CONFIG: path.join(AGENT_DIR, '..', '.gxx-abap', 'config.json'),
      GXX_ABAP_JS: path.join(PROJECT_ROOT, 'gxx-abap', 'bin', 'gxx-abap.js'),
    };
    serverProc = spawn(nodeBin, [serverJs], {
      env, cwd: PROJECT_ROOT, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout?.on('data', (d) => process.stdout.write(`[server] ${d}`));
    serverProc.stderr?.on('data', (d) => process.stderr.write(`[server-err] ${d}`));
    serverProc.on('error', reject);

    const deadline = Date.now() + 60000;
    const poll = setInterval(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/api/state`);
        if (res.ok) { clearInterval(poll); resolve(); }
      } catch { /* not ready */ }
      if (Date.now() > deadline) { clearInterval(poll); reject(new Error('后端启动超时')); }
    }, 500);
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 840, minWidth: 900, minHeight: 600,
    show: false, backgroundColor: '#0d0e12',
    titleBarStyle: 'hidden', titleBarOverlay: false, autoHideMenuBar: true,
    title: 'AbapBuddy',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.loadURL(`http://127.0.0.1:${PORT}/`);
  win.on('closed', () => { mainWindow = null; });
  return win;
}

// ===== IPC =====
const { ipcMain } = require('electron');
ipcMain.handle('open-location', (_e, name) => {
  try {
    const safe = path.normalize(name || '').replace(/\.\./g, '');
    const fp = path.join(OUTPUT_DIR, safe);
    if (!fp.startsWith(OUTPUT_DIR)) return { success: false, error: '非法路径' };
    shell.showItemInFolder(fp);
    return { success: true, data: { path: fp } };
  } catch (e) { return { success: false, error: e?.message || String(e) }; }
});
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => { mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize(); });
ipcMain.on('window:close', () => mainWindow?.close());

ipcMain.handle('update:install', async (_event, filePath) => {
  try {
    if (!fs.existsSync(filePath)) {
      return { success: false, error: '安装文件不存在' };
    }

    // 直接让 Windows Shell 打开安装程序。
    // shell.openPath 底层走 ShellExecuteEx：
    //   - perMachine 安装程序自动触发 UAC 提权
    //   - elevated 进程脱离 Electron 进程树，不受 Job Object 影响
    //   - 不需要批处理中转
    const err = await shell.openPath(filePath);
    if (err) {
      return { success: false, error: '无法启动安装程序: ' + err };
    }
    // 尝试立即删掉下载的安装程序（ShellExecuteEx 打开后可能已释放文件句柄）
    try { fs.unlinkSync(filePath); } catch {}

    stopServer();
    setTimeout(() => app.exit(0), 1500);
    return { success: true };
  } catch (e) {
    return { success: false, error: e?.message || String(e) };
  }
});

function stopServer() {
  if (serverProc && !serverProc.killed) {
    try { serverProc.kill('SIGTERM'); } catch {}
    serverProc = null;
  }
}

// 清理 Temp 目录中遗留的更新安装程序文件
function cleanupOldUpdateFiles() {
  try {
    const tmpDir = os.tmpdir();
    const files = fs.readdirSync(tmpDir);
    for (const f of files) {
      if (f.startsWith('abapbuddy-update-') && f.endsWith('.exe')) {
        try { fs.unlinkSync(path.join(tmpDir, f)); } catch {}
      }
    }
  } catch {}
}

app.whenReady().then(async () => {
  bootstrapUserData();
  // 清理上次更新遗留的临时安装程序文件
  cleanupOldUpdateFiles();
  try { await startServer(); } catch (e) { app.quit(); return; }
  mainWindow = createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow(); });
});

app.on('window-all-closed', () => { stopServer(); app.exit(0); });
app.on('before-quit', () => { stopServer(); });
