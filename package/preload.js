/**
 * AbapBuddy — Electron Preload
 * 拦截 /api/open-location 交给主进程用系统原生方式打开文件，
 * 并注入桌面端窗口控制按钮。
 */
const { ipcRenderer, contextBridge } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  installUpdate: (filePath) => ipcRenderer.invoke('update:install', filePath),
  isElectron: true,
});

// 1) 拦截 open-location
const realFetch = window.fetch.bind(window);
window.fetch = ((input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.includes('/api/open-location')) {
    let name = '';
    try { name = JSON.parse((init?.body || '{}')).name || ''; } catch {}
    return ipcRenderer.invoke('open-location', name).then((res) =>
      new Response(JSON.stringify(res), {
        status: res?.success ? 200 : 500,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  }
  return realFetch(input, init);
});

// 2) 桌面窗口控制
const CSS = `
#topbar { -webkit-app-region: drag; padding-right: 10px; }
#topbar button, #topbar input, #topbar a, #topbar .status-pill,
#topbar .titlebar-controls { -webkit-app-region: no-drag; }
.titlebar-controls { display: inline-flex; align-items: center; gap: 2px; margin-left: 10px; }
.titlebar-controls button {
  width: 30px; height: 30px; border-radius: 6px;
  color: var(--text-dim); font-size: 13px; line-height: 1;
  display: inline-flex; align-items: center; justify-content: center;
}
.titlebar-controls button:hover { background: var(--bg-hover); color: var(--text); }
.titlebar-controls [data-act="close"]:hover { background: #e81123; color: #fff; }
`;

function inject() {
  const topbar = document.getElementById('topbar');
  if (!topbar || topbar.querySelector('.titlebar-controls')) return;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  const controls = document.createElement('div');
  controls.className = 'titlebar-controls';
  controls.style.webkitAppRegion = 'no-drag';
  controls.innerHTML = `
    <button data-act="min" title="最小化">&ndash;</button>
    <button data-act="max" title="最大化">&#9744;</button>
    <button data-act="close" title="关闭">&#10005;</button>`;
  topbar.appendChild(controls);
  controls.querySelector('[data-act="min"]').addEventListener('click', () => ipcRenderer.send('window:minimize'));
  controls.querySelector('[data-act="max"]').addEventListener('click', () => ipcRenderer.send('window:maximize'));
  controls.querySelector('[data-act="close"]').addEventListener('click', () => ipcRenderer.send('window:close'));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject);
else inject();
setTimeout(inject, 600);
