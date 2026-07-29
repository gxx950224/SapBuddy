/**
 * create 命令 - 创建ABAP对象
 */

const { jsonOrText, extractErrMsg } = require('../lib/helpers');

function register(program, client, cfg) {
  program
    .command('create')
    .description('创建ABAP对象')
    .argument('<name>', '对象名称')
    .requiredOption('-t, --type <type>', '对象类型 (class, program, interface)')
    .option('--description <desc>', '对象描述')
    .option('--package <pkg>', '开发类/包名（默认 $TMP）')
    .option('--transport <tr>', '传输请求号（不指定则 SAP 自动创建）')
    .option('--json', 'JSON格式输出')
    .action(async (name, opts) => {
      try {
        await client.autoConnect();
        const upperName = name.toUpperCase();
        const desc = opts.description || '';
        let adtPath, body, contentType = 'application/xml';

        switch (opts.type) {
          case 'program':
            contentType = 'application/vnd.sap.adt.programs.programs.v2+xml';
            break;
          case 'class':
            contentType = 'application/vnd.sap.adt.oo.classes.v2+xml';
            break;
          case 'interface':
            contentType = 'application/vnd.sap.adt.oo.interfaces.v4+xml';
            break;
          case 'table':
            contentType = 'application/vnd.sap.adt.tables.v2+xml';
            break;
        }

        switch (opts.type) {
          case 'program': {
            adtPath = '/sap/bc/adt/programs/programs';
            body = `<?xml version="1.0" encoding="UTF-8"?>
<program:abapProgram
  xmlns:program="http://www.sap.com/adt/programs/programs"
  xmlns:adtcore="http://www.sap.com/adt/core"
  program:programType="executableProgram"
  adtcore:name="${upperName}"
  adtcore:description="${desc}"
  adtcore:responsible="${cfg.showConnection()?.user || 'DEVUSER'}"
  adtcore:masterLanguage="ZH">
  <adtcore:packageRef adtcore:name="${opts.package || '$TMP'}"/>
  ${opts.transport ? `<adtcore:transportRequest adtcore:number="${opts.transport.toUpperCase()}"/>` : ''}

</program:abapProgram>`;
            break;
          }
          case 'class': {
            adtPath = '/sap/bc/adt/oo/classes';
            body = `<?xml version="1.0" encoding="UTF-8"?>
<class:abapClass
  xmlns:class="http://www.sap.com/adt/oo/classes"
  xmlns:adtcore="http://www.sap.com/adt/core"
  class:final="false" class:abstract="false" class:visibility="public"
  class:category="generalObjectType"
  adtcore:name="${upperName}"
  adtcore:description="${desc}"
  adtcore:responsible="${cfg.showConnection()?.user || 'DEVUSER'}"
  adtcore:masterLanguage="ZH">
  <adtcore:packageRef adtcore:name="${opts.package || '$TMP'}"/>
</class:abapClass>`;
            break;
          }
          case 'interface': {
            adtPath = '/sap/bc/adt/oo/interfaces';
            body = `<?xml version="1.0" encoding="UTF-8"?>
<interface:abapInterface
  xmlns:interface="http://www.sap.com/adt/oo/interfaces"
  xmlns:adtcore="http://www.sap.com/adt/core"
  adtcore:name="${upperName}"
  adtcore:description="${desc}"
  adtcore:responsible="${cfg.showConnection()?.user || 'DEVUSER'}"
  adtcore:masterLanguage="ZH">
  <adtcore:packageRef adtcore:name="${opts.package || '$TMP'}"/>
</interface:abapInterface>`;
            break;
          }

          default:
            throw new Error(`不支持的对象类型: ${opts.type}，支持: class, program, interface, fm`);
        }

        const url = adtPath + (opts.transport ? `?corrNr=${opts.transport.toUpperCase()}` : '');
        await client.autoConnect();
        const res = await client.rawRequest('POST', url, {
          body,
          headers: { 'Content-Type': contentType, 'X-CSRF-Token': client.csrfToken, 'Cookie': client.cookie },
        });

        if (res.status === 200 || res.status === 201) {
          const trMsg = opts.transport ? `请求号：${opts.transport.toUpperCase()}` : (opts.package && opts.package !== '$TMP' ? '(自动创建，请到 SE10 查看请求号)' : '');
          jsonOrText(
            `创建成功\n  对象: ${upperName}\n  类型: ${opts.type}${trMsg ? '\n  ' + trMsg : ''}`,
            { success: true, name: upperName, type: opts.type, transport: opts.transport || null },
            opts.json
          );
        } else {
          throw new Error(extractErrMsg(res.body) || `HTTP ${res.status}`);
        }
      } catch (e) {
        console.error(`创建失败: ${e.message}`);
        process.exit(1);
      }
    });
}

module.exports = { register };
