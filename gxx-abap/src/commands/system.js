/**
 * system 命令 - 系统信息
 */

const { jsonOrText } = require('../lib/helpers');

function register(program, client, cfg) {
  program
    .command('system')
    .description('系统信息')
    .argument('<command>', '子命令: info, components')
    .option('--json', 'JSON格式输出')
    .action(async (cmd, opts) => {
      try {
        if (cmd === 'info') {
          const info = await client._getSystemInfo();
          jsonOrText(
            `系统信息\n  SID: ${info?.sid || '未知'}\n  SAP_BASIS: ${info?.basisVersion || '未知'}\n  Kernel: ${info?.kernel || '未知'}\n  服务器: ${info?.serverName || '未知'}`,
            info || { error: '获取失败' },
            opts.json
          );
        } else if (cmd === 'components') {
          const res = await client.request('GET', '/sap/bc/adt/system/components');
          // 解析 Atom feed
          const entries = [];
          const entryRe = /<(?:atom:)?entry>([\s\S]*?)<\/(?:atom:)?entry>/g;
          let em;
          while ((em = entryRe.exec(res.body)) !== null) {
            const e = em[1];
            const id = e.match(/<(?:atom:)?id>([^<]+)/)?.[1] || '';
            const title = e.match(/<(?:atom:)?title>([^<]+)/)?.[1] || '';
            const parts = title.split(';');
            entries.push({
              id,
              release: (parts[0] || '').trim(),
              patch: (parts[1] || '').trim(),
              spLevel: (parts[2] || '').trim(),
              description: (parts[3] || '').trim(),
            });
          }
          entries.sort((a, b) => a.id.localeCompare(b.id));
          if (opts.json) {
            console.log(JSON.stringify({ count: entries.length, components: entries }, null, 2));
          } else {
            console.log(`已安装组件 (共 ${entries.length} 个)\n`);
            console.log('组件ID'.padEnd(20) + '版本'.padEnd(8) + 'Patch'.padEnd(20) + 'SP'.padEnd(8) + '描述');
            console.log('-'.repeat(100));
            for (const e of entries) {
              console.log(e.id.padEnd(20) + e.release.padEnd(8) + e.patch.padEnd(20) + e.spLevel.padEnd(8) + e.description);
            }
          }
        } else {
          console.error(`未知系统命令: ${cmd}，支持: info, components`);
          process.exit(1);
        }
      } catch (e) {
        console.error(`系统命令失败: ${e.message}`);
        process.exit(1);
      }
    });
}

module.exports = { register };
