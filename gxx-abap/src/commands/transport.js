/**
 * transport 命令 - 传输管理
 */

const { jsonOrText } = require('../lib/helpers');
const { guessType, resolveAdtBase } = require('../lib/sdk-types');

function register(program, client, cfg) {
  program
    .command('transport')
    .description('传输管理')
    .argument('<action>', '操作: list, object')
    .argument('[args...]', '参数')
    .option('--json', 'JSON格式输出')
    .action(async (action, args, opts) => {
      if (!action) {
        console.error('请指定操作: list, object');
        process.exit(1);
      }

      try {
        switch (action) {
          case 'list': {
            const res = await client.request('GET', '/sap/bc/adt/cts/transportrequests');

            if (opts.json) {
              console.log(JSON.stringify({ transports: res.body }, null, 2));
              return;
            }

            // 解析 XML 输出可读列表
            const regex = /<tm:request[^>]*tm:number="([^"]+)"[^>]*tm:owner="([^"]+)"[^>]*tm:desc="([^"]*)"[^>]*tm:status="([^"]+)"[^>]*tm:target="([^"]*)"[^>]*>/g;
            const items = [];
            let m;
            while ((m = regex.exec(res.body)) !== null) {
              const statusMap = { 'D': '可修改', 'R': '已发布' };
              items.push({ number: m[1], owner: m[2], desc: m[3], status: statusMap[m[4]] || m[4], target: m[5] || '-' });
            }

            const statusCounts = {};
            for (const item of items) {
              statusCounts[item.status] = (statusCounts[item.status] || 0) + 1;
            }

            console.log(`传输请求列表 (共 ${items.length} 个)\n`);
            for (const item of items) {
              console.log(`  ${item.number.padEnd(12)} ${item.status.padEnd(6)} ${item.owner.padEnd(8)} ${item.desc}`);
            }
            console.log(`\n状态: ${Object.entries(statusCounts).map(([k,v]) => k + '=' + v).join(', ')}`);
            break;
          }
          case 'object': {
            const objPath = args[0];
            if (!objPath) {
              console.error('用法: gxx-abap transport object <对象名>');
              process.exit(1);
            }
            const objType = guessType(objPath);
            const name = objPath.replace(/^.*[/\\]/, '').toLowerCase();
            const base = resolveAdtBase(name, objType);
            const uri = encodeURIComponent(base);

            const res = await client.request('GET', `/sap/bc/adt/repository/informationsystem/objectproperties/transports?uri=${uri}`);

            const trNum = res.body.match(/tpr:transport\s+number="([^"]+)"/)?.[1];
            const trDesc = res.body.match(/description="([^"]+)"/)?.[1];
            const trOwner = res.body.match(/owner="([^"]+)"/)?.[1];
            const trStatus = res.body.match(/status="([^"]+)"/)?.[1];

            if (trNum) {
              jsonOrText(
                `对象: ${objPath}\n  请求号: ${trNum}\n  描述: ${trDesc || ''}\n  负责人: ${trOwner || ''}\n  状态: ${trStatus === 'D' ? '可修改' : trStatus}`,
                { object: objPath, transportNumber: trNum, description: trDesc, owner: trOwner, status: trStatus },
                opts.json
              );
            } else {
              jsonOrText(`对象 ${objPath} 未关联传输请求`, { object: objPath, transportNumber: null }, opts.json);
            }
            break;
          }
          default:
            console.error(`未知传输操作: ${action}，支持: list, object`);
            process.exit(1);
        }
      } catch (e) {
        console.error(`传输操作失败: ${e.message}`);
        process.exit(1);
      }
    });
}

module.exports = { register };
