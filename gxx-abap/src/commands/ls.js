/**
 * ls 命令 - 搜索ABAP对象
 */

const { jsonOrText } = require('../lib/helpers');

function register(program, client, cfg) {
  program
    .command('ls')
    .description('搜索ABAP对象')
    .argument('<pattern>', '对象名称（支持*通配符）')
    .option('--json', 'JSON格式输出')
    .action(async (pattern, opts) => {
      try {
        const query = pattern || '*';
        const res = await client.request('GET',
          `/sap/bc/adt/repository/informationsystem/executableObjects?query=${encodeURIComponent(query)}&maxResults=50`
        );

        // 解析 XML
        const objRegex = /<adtcore:objectReference[^>]*adtcore:uri="([^"]*)"[^>]*adtcore:type="([^"]+)"[^>]*adtcore:name="([^"]+)"[^>]*\/>/g;
        const objRegex2 = /<adtcore:objectReference[^>]*adtcore:uri="([^"]*)"[^>]*adtcore:name="([^"]+)"[^>]*adtcore:type="([^"]+)"[^>]*\/>/g;
        const items = [];
        let m;
        while ((m = objRegex.exec(res.body)) !== null) {
          items.push({ name: m[3], type: m[2], uri: m[1] || '' });
        }
        while ((m = objRegex2.exec(res.body)) !== null) {
          if (!items.find(i => i.name === m[1])) {
            items.push({ name: m[2], type: m[3], uri: m[1] || '' });
          }
        }

        if (opts.json) {
          console.log(JSON.stringify({ search: query, count: items.length, objects: items }, null, 2));
          return;
        }
        const typeMap = {
          'PROG/P': '程序', 'CLAS/OC': '类', 'INTF/OI': '接口',
          'TABL/DT': '表', 'TABL/DS': '结构',
          'DDLS/DF': 'CDS视图', 'FUGR/I': '函数组Include', 'TRAN/T': '事务码',
          'FUGR/FF': '函数模块',
        };
        for (const item of items) {
          item.typeLabel = typeMap[item.type] || item.type;
        }

        if (items.length === 0) {
          console.log(`未找到匹配"${query}"的对象`);
        } else {
          console.log(`找到 ${items.length} 个对象 (${query})\n`);
          for (const item of items) {
            console.log(`  ${item.name.padEnd(35)} ${item.typeLabel}`);
          }
        }
      } catch (e) {
        console.error('搜索失败:', e.message);
        process.exit(1);
      }
    });
}

module.exports = { register };
