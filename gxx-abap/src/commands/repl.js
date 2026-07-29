/**
 * REPL 交互模式 - 无参数时启动
 */

const readline = require('readline');
const { spawn } = require('child_process');
const path = require('path');

function start(client, cfg) {
  const hr = () => '─'.repeat(Math.max(process.stdout.columns || 80, 40));

  // Banner
  const conn = cfg.showConnection();
  const pkg = require('../../package.json');
  const B = '\x1b[94m'; // bright blue
  const W = '\x1b[97m'; // bright white
  const R = '\x1b[0m';   // reset
  const D = '\x1b[2m';   // dim

  const logo = [
    `${B} █████  ██   ██ ██   ██   ${W}█████  ██████   █████  ██████ ${R}`,
    `${B}██   ██  ██ ██   ██ ██   ${W}██   ██ ██   ██ ██   ██ ██   ██ ${R}`,
    `${B}██        ███     ███    ${W}███████ ██████  ███████ ██████ ${R}`,
    `${B}██ ███    ███     ███    ${W}██   ██ ██   ██ ██   ██ ██     ${R}`,
    `${B}██   ██  ██ ██   ██ ██   ${W}██   ██ ██   ██ ██   ██ ██     ${R}`,
    ` ${B}█████  ██   ██ ██   ██  ${W}██   ██ ██████  ██   ██ ██     ${R}`,
  ];

  console.log([
    '',
    ...logo,
    '',
    `  ${D}author: guoxiaoxi    version: v${pkg.version}${R}`,
    `  ${conn ? conn.host + ':' + (conn.port || '44300') + '  ' + D + conn.user + ' · Client ' + conn.client + R : '未配置'}`,
    `  ${process.cwd()}`,
    '',
  ].join('\n'));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\x1b[34;1m❯\x1b[0m ',
  });

  let waiting = false;

  const showPrompt = () => {
    if (waiting) return;
    console.log(hr());
    rl.prompt();
  };

  showPrompt();

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) { showPrompt(); return; }
    if (trimmed === '.exit' || trimmed === '.quit') {
      console.log('再见');
      rl.close();
      process.exit(0);
      return;
    }

    waiting = true;
    const args = trimmed.match(/(?:[^\s"]+|"[^"]*")+/g).map(s => s.replace(/^"|"$/g, ''));
    const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'bin', 'gxx-abap.js'), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let out = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => out += d);
    child.on('close', () => {
      if (out.trim()) {
        process.stdout.write(out.trimEnd() + '\n');
      }
      waiting = false;
      showPrompt();
    });
  });
}

module.exports = { start };
