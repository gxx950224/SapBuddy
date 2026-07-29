/**
 * meta 命令 - 查看表/结构/数据元素
 */

const { jsonOrText } = require('../lib/helpers');

function register(program, client, cfg) {
  program
    .command('meta')
    .description('查看表/结构/数据元素')
    .argument('<name>', '表名/结构名/数据元素名')
    .option('--json', 'JSON格式输出')
    .option('--field <name>', '按字段名过滤（不区分大小写）')
    .action(async (name, opts) => {

      // 从 DDL 源码中提取字段名和数据元素
      function extractFields(ddlSource) {
        const fields = [];
        const lines = ddlSource.split('\n');
        for (const line of lines) {
          // 匹配: key fieldname : dataelement not null;
          let m = line.match(/^\s*key\s+(\w+)\s*:\s*(\w+)/);
          if (!m) {
            // 匹配: fieldname : dataelement;
            m = line.match(/^\s+(\w+)\s*:\s*(\w+)/);
          }
          if (m) {
            const dataElement = m[2].toLowerCase();
            if (dataElement !== '...' && !dataElement.startsWith('include')) {
              fields.push({ field: m[1], dataElement });
            }
          }
        }
        return fields;
      }

      // 从 DDL 源码中提取 include 的结构名
      function extractIncludes(ddlSource) {
        const includes = [];
        const re = /^\s*include\s+(\w+)/gm;
        let m;
        while ((m = re.exec(ddlSource)) !== null) {
          includes.push(m[1]);
        }
        return [...new Set(includes)];
      }

      // 获取数据元素的类型信息
      async function fetchElementInfo(elemNames) {
        const uniq = [...new Set(elemNames)];
        const results = await Promise.all(uniq.map(async (elem) => {
          try {
            const r = await client.request('GET', `/sap/bc/adt/ddic/dataelements/${elem}`);
            if (r.status !== 200) return null;
            const body = r.body;
            const getAttr = (attr) => { const x = body.match(new RegExp(`${attr}\\s*=\\s*"([^"]+)"`)); return x ? x[1] : ''; };
            const dtel = body.match(/<dtel:dataElement[^>]*>([\s\S]*?)<\/dtel:dataElement>/);
            let dataType = '', length = '', decimals = '';
            if (dtel) {
              const d = dtel[1];
              const gt = (tag) => { const x = d.match(new RegExp(`<${tag}>([^<]+)`)); return x ? x[1].trim() : ''; };
              dataType = gt('dtel:dataType');
              length = gt('dtel:dataTypeLength');
              decimals = gt('dtel:dataTypeDecimals');
            }
            const desc = getAttr('adtcore:description');
            return { name: elem, dataType, length, decimals, desc };
          } catch(e) { return null; }
        }));
        const map = {};
        results.filter(Boolean).forEach(r => map[r.name] = r);
        return map;
      }

      if (!name) { console.error('请指定表名'); process.exit(1); return; }
      try {
        const lowerName = name.toLowerCase();
        let ddlBody = null;
        let isDataElement = false;
        let dtelMeta = null;

        // 1. 依次尝试：表 → 结构 → 数据元素
        let ddlRes = await client.request('GET', `/sap/bc/adt/ddic/tables/${lowerName}/source/main`);
        if (ddlRes.status !== 200) {
          ddlRes = await client.request('GET', `/sap/bc/adt/ddic/structures/${lowerName}/source/main`);
        }
        if (ddlRes.status !== 200) {
          ddlRes = await client.request('GET', `/sap/bc/adt/functions/groups/${lowerName}/source/main`);
        }
        if (ddlRes.status === 200) {
          ddlBody = ddlRes.body;
        } else {
          // 尝试数据元素
          const dtelRes = await client.request('GET', `/sap/bc/adt/ddic/dataelements/${lowerName}`);
          if (dtelRes.status === 200) {
            isDataElement = true;
            dtelMeta = dtelRes.body;
          } else {
            throw new Error(ddlRes.body.match(/<message[^>]*>([^<]+)/)?.[1] || '未找到对象');
          }
        }

        // 数据元素：单独处理
        if (isDataElement) {
          const getAttr = (attr) => { const x = dtelMeta.match(new RegExp(`${attr}\\s*=\\s*"([^"]+)"`)); return x ? x[1] : ''; };
          const gt = (tag) => { const x = dtelMeta.match(new RegExp(`<dtel:${tag}>([^<]*)`)); return x ? x[1].trim() : ''; };
          const info = {
            name: getAttr('adtcore:name'),
            description: getAttr('adtcore:description'),
            typeKind: gt('typeKind'),
            typeName: gt('typeName'),
            dataType: gt('dataType'),
            length: gt('dataTypeLength'),
            decimals: gt('dataTypeDecimals'),
            shortLabel: gt('shortFieldLabel'),
            mediumLabel: gt('mediumFieldLabel'),
            longLabel: gt('longFieldLabel'),
            headingLabel: gt('headingFieldLabel'),
          };
          if (opts.json) {
            console.log(JSON.stringify(info, null, 2));
          } else {
            console.log(`\n数据元素: ${info.name}`);
            console.log(`  描述:       ${info.description || '(无)'}`);
            console.log(`  类型:       ${info.dataType || '(无)'}`);
            if (info.typeKind !== 'domain') console.log(`  类型类别:   ${info.typeKind || '(无)'}`);
            console.log(`  域:         ${info.typeName || '(无)'}`);
            if (info.length && info.length !== '000000') console.log(`  长度:       ${parseInt(info.length)}`);
            if (info.decimals && info.decimals !== '000000') console.log(`  小数:       ${parseInt(info.decimals)}`);
            if (info.shortLabel) console.log(`  标签:       ${info.shortLabel}`);
          }
          return;
        }

        // 表/结构：解析字段
        let allFields = extractFields(ddlBody);

        // 处理 include（递归获取 include 结构的字段）
        const includes = extractIncludes(ddlBody);
        for (const inc of includes) {
          try {
            const incRes = await client.request('GET', `/sap/bc/adt/ddic/structures/${inc.toLowerCase()}/source/main`);
            if (incRes.status === 200) {
              const incFields = extractFields(incRes.body);
              const nestedIncludes = extractIncludes(incRes.body);
              for (const nested of nestedIncludes) {
                try {
                  const nestedRes = await client.request('GET', `/sap/bc/adt/ddic/structures/${nested.toLowerCase()}/source/main`);
                  if (nestedRes.status === 200) {
                    allFields.push(...extractFields(nestedRes.body));
                  }
                } catch(e) { /* ignore */ }
              }
              allFields.push(...incFields);
            }
          } catch(e) { /* include 获取失败，忽略 */ }
        }

        // 扩展字段
        const extendRe = /^\s+extend\s+(\w+)\s*:/gm;
        let em;
        while ((em = extendRe.exec(ddlBody)) !== null) {
          const existing = allFields.find(f => f.field.toLowerCase() === em[1].toLowerCase());
          if (!existing) {
            allFields.push({ field: em[1], dataElement: em[1].toLowerCase() });
          }
        }

        // 去重
        const seen = new Set();
        allFields = allFields.filter(f => {
          const key = f.field.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        // 批量获取数据元素类型
        const elemNames = allFields.map(f => f.dataElement);
        const elemMap = await fetchElementInfo(elemNames);

        const fullFields = allFields.map(f => {
          const info = elemMap[f.dataElement] || {};
          return {
            field: f.field.toUpperCase(),
            dataElement: f.dataElement.toUpperCase(),
            type: info.dataType || '',
            length: parseInt(info.length || '0'),
            decimals: parseInt(info.decimals || '0'),
            description: info.desc || '',
          };
        });

        // --field 过滤
        const showFields = opts.field
          ? fullFields.filter(f => f.field.includes(opts.field.toUpperCase()))
          : fullFields;

        if (opts.json) {
          console.log(JSON.stringify({ table: name.toUpperCase(), fields: showFields }, null, 2));
        } else {
          console.log(`\n表: ${name.toUpperCase()} (${showFields.length}/${fullFields.length} 字段)\n`);
          console.log('字段名'.padEnd(18), '数据元素'.padEnd(18), '类型'.padEnd(8), '长度'.padEnd(6), '小数'.padEnd(4), '描述');
          console.log('-'.repeat(80));
          for (const f of showFields) {
            console.log(f.field.padEnd(18), f.dataElement.padEnd(18), f.type.padEnd(8), (f.length || '').toString().padEnd(6), (f.decimals || '').toString().padEnd(4), f.description);
          }
        }
      } catch (e) {
        console.error(`获取结构失败: ${e.message}`);
        process.exit(1);
      }
    });
}

module.exports = { register };
