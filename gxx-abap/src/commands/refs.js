/**
 * refs 命令 - Where-Used 引用查询
 */

const { jsonOrText, discoverFmGroup } = require('../lib/helpers');
const { guessType, resolveAdtPath, resolveAdtType } = require('../lib/sdk-types');

function register(program, client, cfg) {
  program
    .command('refs')
    .description('Where-Used 引用查询')
    .argument('<name>', '对象名')
    .option('-t, --type <type>', '对象类型: program, class, table, interface, function, fm')
    .option('--json', 'JSON格式输出')
    .action(async (objName, opts) => {
      try {
        const type = opts.type || guessType(objName);
        if (type === 'fm' && !opts.group) {
          const found = await discoverFmGroup(objName, client);
          if (!found) throw new Error('未找到函数模块 ' + objName + '，请手动指定 --group');
          opts.group = found;
        }
        const name = objName.toUpperCase();
        const sourceUri = resolveAdtPath(name, type, opts.group);
        const adtType = resolveAdtType(type);

        const body = `<?xml version="1.0" encoding="UTF-8"?>
<ur:usageReferenceRequest xmlns:ur="http://www.sap.com/adt/ris/usageReferences" xmlns:adtcore="http://www.sap.com/adt/core">
  <adtcore:objectReference adtcore:uri="${sourceUri}" adtcore:type="${adtType}" adtcore:name="${name}"/>
</ur:usageReferenceRequest>`;

        const res = await client.request('POST', `/sap/bc/adt/repository/informationsystem/usageReferences?uri=${encodeURIComponent(sourceUri)}`, {
          body,
          headers: { 'Content-Type': 'application/vnd.sap.adt.repository.usagereferences.request.v1+xml' }
        });

        if (res.status !== 200) throw new Error(res.body.match(/<message[^>]*>([^<]+)/)?.[1] || `HTTP ${res.status}`);

        // 解析结果
        const refs = [];
        const objRe = /<usageReferences:referencedObject[^>]*uri="([^"]*)"[^>]*parentUri="([^"]*)"[^>]*>/g;
        let om;
        while ((om = objRe.exec(res.body)) !== null) {
          const fullTag = om[0];
          const uri = om[1];
          const parentUri = om[2] || '';
          const isResult = fullTag.includes('isResult="true"');
          if (!isResult) continue;
          const nextObj = res.body.substring(om.index).match(/<usageReferences:adtObject[^>]*adtcore:name="([^"]*)"[^>]*adtcore:type="([^"]*)"[^>]*adtcore:description="([^"]*)"/);
          if (nextObj) {
            refs.push({ name: nextObj[1], type: nextObj[2], description: nextObj[3], uri });
          }
        }

        if (refs.length === 0) {
          const objRe2 = /<usageReferences:adtObject[^>]*adtcore:name="([^"]*)"[^>]*adtcore:type="([^"]*)"[^>]*adtcore:description="([^"]*)"/g;
          let om2;
          while ((om2 = objRe2.exec(res.body)) !== null) {
            const name2 = om2[1];
            if (name2 !== name) refs.push({ name: name2, type: om2[2], description: om2[3] });
          }
        }

        const typeMap = {
          'PROG/P': '程序', 'PROG/I': 'Include', 'CLAS/OC': '类', 'INTF/OI': '接口',
          'FUGR/F': '函数组', 'FUGR/FF': '函数模块', 'TABL/DT': '表', 'TABL/DS': '结构',
          'DDLS/DF': 'CDS视图', 'DEVC/K': '包', 'TRAN/T': '事务码', 'MSAG/N': '消息类',
        };

        if (opts.json) {
          console.log(JSON.stringify({ object: name, type, count: refs.length, references: refs }, null, 2));
        } else if (refs.length === 0) {
          console.log(`未找到引用 ${name} 的对象`);
        } else {
          console.log(`\n引用 ${name} 的对象 (${refs.length}):\n`);
          for (const ref of refs) {
            const typeLabel = typeMap[ref.type] || ref.type;
            console.log(`  ${ref.name.padEnd(35)} ${typeLabel.padEnd(8)} ${ref.description || ''}`);
          }
        }
      } catch (e) {
        console.error(`引用查询失败: ${e.message}`);
        process.exit(1);
      }
    });
}

module.exports = { register };
