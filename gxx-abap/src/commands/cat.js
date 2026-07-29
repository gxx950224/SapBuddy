/**
 * cat 命令 - 查看对象源码
 */

const { jsonOrText, discoverFmGroup } = require('../lib/helpers');
const { guessType, resolveAdtPath } = require('../lib/sdk-types');

function register(program, client, cfg) {
  program
    .command('cat')
    .description('查看对象源码')
    .argument('<path>', '对象名（自动识别类/程序/接口）')
    .option('-t, --type <type>', '对象类型: class, program, interface, table, fm')
    .option('--json', 'JSON格式输出')
    .action(async (objPath, opts) => {
      try {
        const type = opts.type || guessType(objPath);
        if (type === 'fm' && !opts.group) {
          const found = await discoverFmGroup(objPath, client);
          if (!found) throw new Error('未找到函数模块 ' + objPath + '，请手动指定 --group');
          opts.group = found;
        }
        const adtPath = resolveAdtPath(objPath, type, opts.group);
        const res = await client.request('GET', adtPath);
        if (res.status !== 200) {
          const errMsg = res.body.match(/<message[^>]*>([^<]+)/);
          throw new Error(errMsg ? errMsg[1] : `HTTP ${res.status}`);
        }
        jsonOrText(res.body, { path: objPath, type, source: res.body }, opts.json);
      } catch (e) {
        console.error(`读取失败 (${objPath}): ${e.message}`);
        process.exit(1);
      }
    });
}

module.exports = { register };
