/**
 * ping 命令 - 测试与SAP系统的连接
 */

const { jsonOrText } = require('../lib/helpers');

function register(program, client, cfg) {
  program
    .command('ping')
    .description('测试与SAP系统的连接')
    .option('--json', 'JSON格式输出')
    .action(async (opts) => {
      try {
        const info = await client.testConnection();
        jsonOrText(
          `连接成功\n  系统: ${info.sid || '未知'}\n  SAP_BASIS: ${info.basisVersion || '未知'}\n  服务器: ${info.host}\n  用户: ${info.user}`,
          { status: 'connected', ...info },
          opts.json
        );
      } catch (e) {
        jsonOrText(`连接失败: ${e.message}`, { status: 'error', message: e.message }, opts.json);
        process.exit(1);
      }
    });
}

module.exports = { register };
