/**
 * config 命令 - 配置系统连接信息
 */

const { jsonOrText } = require('../lib/helpers');

function register(program, client, cfg) {
  program
    .command('config')
    .description('配置系统连接信息（持久化到 ~/.gxx-abap/config.json）')
    .option('--host <host>', 'SAP 系统主机名或IP')
    .option('--port <port>', '端口号')
    .option('-u, --user <user>', '用户名')
    .option('-p, --password <password>', '密码')
    .option('-c, --client <client>', 'Client')
    .option('--http', '使用HTTP而不是HTTPS')
    .option('--show', '查看当前配置（密码不显示）')
    .option('--json', 'JSON格式输出')
    .action((opts) => {
      if (opts.show) {
        const info = cfg.showConnection();
        if (!info) {
          jsonOrText('未配置', { configured: false }, opts.json);
          return;
        }
        const display = {
          ...info,
          password: info.hasPassword ? '******' : '(未设置)',
        };
        delete display.hasPassword;
        jsonOrText(
          `当前配置\n  系统: ${display.host}\n  端口: ${display.port}\n  用户: ${display.user}\n  Client: ${display.client}\n  密码: ${display.password}`,
          { configured: true, ...display },
          opts.json
        );
        return;
      }

      if (!opts.host && !opts.user && !opts.password) {
        console.error('错误: 至少需要 --host、-u、-p 中的一项');
        process.exit(1);
      }

      const c = cfg.setConnection({
        host: opts.host,
        port: opts.port,
        user: opts.user,
        password: opts.password,
        client: opts.client,
        protocol: opts.http ? 'http' : undefined,
      });

      jsonOrText(
        `配置已保存到 ~/.gxx-abap/config.json\n  系统: ${c.host}\n  端口: ${c.port || '44300'}\n  用户: ${c.user}\n  Client: ${c.client || '100'}\n  ${c.protocol === 'http' ? 'HTTP' : 'HTTPS'}`,
        { saved: true, host: c.host, port: c.port || '44300', user: c.user, client: c.client || '100' },
        opts.json
      );
    });
}

module.exports = { register };
