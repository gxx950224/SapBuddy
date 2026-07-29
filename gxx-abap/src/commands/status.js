/**
 * status 命令 - 查看当前连接状态
 */

const { jsonOrText } = require('../lib/helpers');

function register(program, client, cfg) {
  program
    .command('status')
    .description('查看当前连接状态')
    .option('--json', 'JSON格式输出')
    .action(async (opts) => {
      try {
        const info = await client.testConnection();
        jsonOrText(
          `已连接\n  系统: ${info.host}\n  SID: ${info.sid || '未知'}\n  SAP_BASIS: ${info.basisVersion || '未知'}\n  用户: ${info.user}\n  Client: ${cfg.showConnection()?.client || '未知'}`,
          { status: 'connected', ...info },
          opts.json
        );
      } catch (e) {
        jsonOrText('未配置或无法连接', { status: 'disconnected', message: e.message }, opts.json);
      }
    });
}

module.exports = { register };
