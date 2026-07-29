/**
 * gxx-abap CLI — 入口
 *
 * 自动加载 commands/ 目录下所有命令文件，无需手动注册。
 * 无参数时进入 REPL 交互模式。
 */

const { Command } = require('commander');
const fs = require('fs');
const path = require('path');

const client = require('./adt-client');
const cfg = require('./config');

function run() {
  const program = new Command()
    .name('gxx-abap')
    .description('ABAP ADT 命令行工具 — 从终端操作 SAP ABAP 开发系统')
    .version('1.0.0');

  // 自动加载所有命令
  const cmdDir = path.join(__dirname, 'commands');
  for (const file of fs.readdirSync(cmdDir).filter(f => f.endsWith('.js') && f !== 'repl.js')) {
    require(path.join(cmdDir, file)).register(program, client, cfg);
  }

  // 无参数时进入 REPL 交互模式
  if (process.argv.length <= 2) {
    require('./commands/repl').start(client, cfg);
    return;
  }

  program.parse(process.argv);
}

module.exports = { run };
