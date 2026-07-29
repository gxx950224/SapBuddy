/**
 * activate 命令 - 激活对象（含语法检查）
 */

const { jsonOrText } = require('../lib/helpers');
const { guessType, resolveAdtPath, resolveAdtType } = require('../lib/sdk-types');

function register(program, client, cfg) {
  program
    .command('activate')
    .description('激活对象')
    .argument('<path>', '对象名（程序/类/接口/表）')
    .option('-t, --type <type>', '对象类型: class, program, interface, fm')
    .option('--json', 'JSON格式输出')
    .action(async (objPath, opts) => {
      try {
        const type = opts.type || guessType(objPath);
        const name = objPath.replace(/^.*[/\\\\]/, '').toLowerCase();
        const sourceUri = resolveAdtPath(name, type);
        const adtType = resolveAdtType(type);

        const xml = `<?xml version="1.0" encoding="UTF-8"?><adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core"><adtcore:objectReference adtcore:uri="${sourceUri}" adtcore:type="${adtType}" adtcore:name="${name.toUpperCase()}"/></adtcore:objectReferences>`;

        const res = await client.request('POST', '/sap/bc/adt/activation?method=activate', {
          body: xml,
          headers: { 'Content-Type': 'application/xml' },
        });

        if (res.status !== 200) {
          throw new Error(res.body.match(/<message[^>]*>([^<]+)/)?.[1] || `HTTP ${res.status}`);
        }

        const checkOk = res.body.includes('checkExecuted="true"');
        const actOk = res.body.includes('activationExecuted="true"');
        const genOk = res.body.includes('generationExecuted="true"');

        const errors = [];
        const msgRegex = /<msg[^>]*>([\s\S]*?)<\/msg>/g;
        let msgMatch;
        while ((msgMatch = msgRegex.exec(res.body)) !== null) {
          const fullTag = msgMatch[0];
          const msgContent = msgMatch[1];
          const type = fullTag.match(/type="([^"]+)"/)?.[1] || '';
          const line = fullTag.match(/line="([^"]+)"/)?.[1];
          const stMatch = msgContent.match(/<shortText>([\s\S]*?)<\/shortText>/);
          const text = stMatch ? stMatch[1].replace(/<[^>]+>/g, '').trim() : '';
          if (text) errors.push({ type, line, text });
        }

        const parts = [];
        let hasError = false;
        if (errors.length > 0) {
          for (const e of errors) {
            const icon = e.type === 'E' ? '❌' : e.type === 'W' ? '⚠' : 'ℹ';
            parts.push(`${icon} L${e.line||'?'}: ${e.text}`);
            if (e.type === 'E') hasError = true;
          }
        }
        if (hasError) parts.unshift('❌ 语法检查未通过');
        else if (checkOk) parts.unshift('✅ 语法检查通过');
        if (actOk) parts.unshift('✅ 激活成功');
        if (genOk) parts.push('✅ 生成成功');
        if (!actOk && !hasError && !errors.length) parts.unshift('ℹ 无需激活（已为最新）');

        const text = `激活完成\n  对象: ${objPath}\n  类型: ${type}\n  ${parts.join('\n  ')}`;
        const jsonObj = {
          success: !hasError,
          path: objPath,
          type,
          checkExecuted: checkOk,
          activationExecuted: actOk,
          generationExecuted: genOk,
          errors: errors.length > 0 ? errors : undefined,
        };

        jsonOrText(text, jsonObj, opts.json);
        if (hasError) process.exit(1);
      } catch (e) {
        console.error(`激活失败: ${e.message}`);
        process.exit(1);
      }
    });
}

module.exports = { register };
