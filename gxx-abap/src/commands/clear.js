/**
 * clear 命令 - 清除所有配置信息
 */

function register(program, client, cfg) {
  program
    .command('clear')
    .description('清除所有配置信息')
    .action(() => {
      cfg.clear();
      client.reset();
      console.log('配置已清除');
    });
}

module.exports = { register };
