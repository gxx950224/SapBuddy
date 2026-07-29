/**
 * unlock 命令 - 调用 AI_PUT_UNLOCK 接口释放对象锁
 */

const { customUnlock } = require('../lib/unlock');

function register(program, client, cfg) {
  program
    .command('unlock')
    .description('调用 AI_PUT_UNLOCK 接口释放对象锁')
    .argument('<name>', '对象名（程序/函数组/类等）')
    .option('--json', 'JSON格式输出')
    .action(async (objName, opts) => {
      try {
        const result = await customUnlock(objName);
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`解锁结果: ${result.STATUS === 'S' ? '✅ 成功' : '❌ 失败'}`);
          if (result.MSGTXT) console.log(`  ${result.MSGTXT}`);
        }
      } catch (e) {
        console.error(`解锁失败: ${e.message}`);
        process.exit(1);
      }
    });
}

module.exports = { register };
