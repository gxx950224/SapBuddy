/**
 * texts 命令 - 查看/修改文本元素
 */

const fs = require('fs');
const { jsonOrText } = require('../lib/helpers');
const { guessType } = require('../lib/sdk-types');
const { silentUnlock } = require('../lib/unlock');

function register(program, client, cfg) {
  program
    .command('texts')
    .description('查看/修改文本元素')
    .argument('<name>', '程序/类/函数组名')
    .option('-t, --type <type>', '对象类型: program, class, function')
    .option('--json', 'JSON格式输出')
    .option('--set <sub>', '写入子对象: selections, symbols, headings')
    .option('--force-unlock', '写入前强制解锁')
    .option('--file <path>', '写入的文件路径（不传从stdin读取）')
    .action(async (objName, opts) => {
      try {
        const type = opts.type || guessType(objName);
        const name = objName.toUpperCase();

        // ── 写入模式 ──
        if (opts.set) {
          if (!['selections', 'symbols', 'headings'].includes(opts.set)) {
            console.error('--set 只支持: selections, symbols, headings');
            process.exit(1);
          }
          let source;
          if (opts.file) {
            source = fs.readFileSync(opts.file, 'utf8');
          } else {
            if (process.stdin.isTTY) throw new Error('请通过 --file 或管道传入内容');
            source = await new Promise((resolve, reject) => {
              const chunks = [];
              process.stdin.on('data', c => chunks.push(c));
              process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
              process.stdin.on('error', reject);
            });
          }

          let baseEp;
          switch (type) {
            case 'class':     baseEp = '/sap/bc/adt/textelements/classes'; break;
            case 'function':  baseEp = '/sap/bc/adt/textelements/functiongroups'; break;
            default:          baseEp = '/sap/bc/adt/textelements/programs';
          }
          const ctMap = {
            'symbols': 'application/vnd.sap.adt.textelements.symbols.v1',
            'selections': 'application/vnd.sap.adt.textelements.selections.v1',
            'headings': 'application/vnd.sap.adt.textelements.headings.v1',
          };
          const ct = ctMap[opts.set];
          const subPath = `${baseEp}/${name.toLowerCase()}/source/${opts.set}`;

          await client.autoConnect();

          const crypto = require('crypto');
          const sessHeaders = {
            'sap-adt-connection-id': crypto.randomUUID(),
            'x-sap-adt-sessiontype': 'stateful',
            'Cookie': client.cookie,
            'X-CSRF-Token': client.csrfToken,
          };

          // Force unlock
          if (opts.forceUnlock) {
            await client.rawRequest('POST', `${subPath}?_action=UNLOCK&lockHandle=0`, {
              body: '',
              headers: { 'Content-Type': 'application/atom+xml; type=entry', ...sessHeaders }
            }).catch(() => {});
            sessHeaders['sap-adt-connection-id'] = crypto.randomUUID();
          }

          // Lock
          const lockRes = await client.rawRequest('POST', `${subPath}?_action=LOCK&accessMode=MODIFY`, {
            body: '',
            headers: { 'Content-Type': 'application/atom+xml; type=entry', ...sessHeaders }
          });
          if (lockRes.status !== 200) throw new Error(`锁定失败: ${lockRes.body.match(/<message[^>]*>([^<]+)/)?.[1] || lockRes.status}`);

          const lockHandle = lockRes.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/i)?.[1];
          const corrNr = lockRes.body.match(/<CORRNR>([^<]+)<\/CORRNR>/i)?.[1];
          if (!lockHandle) throw new Error('获取 lockHandle 失败');

          try {
            const corrNrParam = corrNr ? `&corrNr=${encodeURIComponent(corrNr)}` : '';
            const putRes = await client.rawRequest('PUT', `${subPath}?lockHandle=${encodeURIComponent(lockHandle)}${corrNrParam}`, {
              body: source,
              headers: { 'Content-Type': ct, ...sessHeaders }
            });
            if (putRes.status !== 200) throw new Error(`写入失败: ${putRes.body.match(/<message[^>]*>([^<]+)/)?.[1] || putRes.status}`);
          } finally {
            await client.rawRequest('POST', `${subPath}?_action=UNLOCK&lockHandle=${encodeURIComponent(lockHandle)}`, {
              body: '',
              headers: { 'Content-Type': 'application/atom+xml; type=entry', ...sessHeaders }
            }).catch(() => {});
            // 统一解锁（使用公共模块）
            await silentUnlock(objName, client);
          }

          console.log(`写入成功: ${name} ${opts.set}`);
          return;
        }

        // ── 查看模式 ──
        let baseEndpoint;
        switch (type) {
          case 'class':     baseEndpoint = '/sap/bc/adt/textelements/classes'; break;
          case 'function':  baseEndpoint = '/sap/bc/adt/textelements/functiongroups'; break;
          default:          baseEndpoint = '/sap/bc/adt/textelements/programs';
        }

        const mainRes = await client.request('GET', `${baseEndpoint}/${name.toLowerCase()}`);
        if (mainRes.status !== 200) throw new Error(mainRes.body.match(/<message[^>]*>([^<]+)/)?.[1] || `HTTP ${mainRes.status}`);

        // 发现子对象
        const subRe = /<rept:subobject\s+adtcore:name="([^"]+)">/g;
        const subObjects = [];
        let sm;
        while ((sm = subRe.exec(mainRes.body)) !== null) subObjects.push(sm[1]);

        const contentTypes = {
          'symbols': 'application/vnd.sap.adt.textelements.symbols.v1',
          'selections': 'application/vnd.sap.adt.textelements.selections.v1',
          'headings': 'application/vnd.sap.adt.textelements.headings.v1',
        };

        const allTexts = {};
        for (const sub of subObjects) {
          try {
            const ct = contentTypes[sub] || 'text/plain';
            const subRes = await client.request('GET', `${baseEndpoint}/${name.toLowerCase()}/source/${sub}`, {
              headers: { 'Accept': ct }
            });
            if (subRes.status === 200) {
              const items = [];
              const lines = subRes.body.split('\n');
              for (const line of lines) {
                const m = line.match(/^(.+?)\s*=\s*(.*)/);
                if (m) {
                  const key = m[1].trim();
                  const text = m[2].trim();
                  if (key) items.push({ key, text });
                }
              }
              if (items.length > 0) allTexts[sub] = items;
            }
          } catch(e) {}
        }

        if (opts.json) {
          console.log(JSON.stringify({ name, type, ...allTexts }, null, 2));
        } else {
          const totalItems = Object.values(allTexts).reduce((s, a) => s + a.length, 0);
          console.log(`\n文本元素: ${name} (${totalItems} 条)\n`);
          const labels = { 'symbols': '文本符号', 'selections': '选择文本', 'headings': '标题' };
          for (const [sub, items] of Object.entries(allTexts)) {
            console.log(`\n  ${labels[sub] || sub} (${items.length}):`);
            for (const item of items) {
              console.log(`    ${item.key.padEnd(8)} ${item.text}`);
            }
          }
        }
      } catch (e) {
        console.error(`获取文本元素失败: ${e.message}`);
        process.exit(1);
      }
    });
}

module.exports = { register };
