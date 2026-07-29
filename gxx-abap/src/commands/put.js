/**
 * put 命令 - 写入源码（锁定→写入→解锁）
 */

const fs = require('fs');
const { jsonOrText, extractErrMsg, discoverFmGroup } = require('../lib/helpers');
const { guessType, resolveAdtBase } = require('../lib/sdk-types');
const { silentUnlock } = require('../lib/unlock');

function register(program, client, cfg) {
  program
    .command('put')
    .description('写入源码（锁定→写入→解锁）')
    .argument('<path>', '对象名')
    .argument('[file]', '源码文件路径（不传则从stdin读取）')
    .option('-t, --type <type>', '对象类型: class, program, interface, fm')
    .option('--transport <tr>', '传输请求号（写入时关联此传输）')
    .option('--force-unlock', '写入前先强制解锁（用于解除残留锁）')
    .option('--json', 'JSON格式输出')
    .action(async (objPath, file, opts) => {
      let lockHandle = null;
      let objBase = null;
      let sessHeaders = null;

      try {
        const _type = opts.type || guessType(objPath);
        if (_type === 'table' || _type === 'cds') {
          throw new Error('此系统不支持通过 REST API 写入 ' + _type + ' 源码');
        }
        if (_type === 'fm' && !opts.group) {
          const found = await discoverFmGroup(objPath, client);
          if (!found) throw new Error('未找到函数模块 ' + objPath + '，请手动指定 --group');
          opts.group = found;
        }
        let source;
        if (file) {
          source = fs.readFileSync(file, 'utf8');
        } else {
          if (process.stdin.isTTY) throw new Error('请通过管道传入源码或指定文件路径');
          source = await new Promise((resolve, reject) => {
            const chunks = [];
            process.stdin.on('data', c => chunks.push(c));
            process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            process.stdin.on('error', reject);
          });
        }
        if (!source.trim()) throw new Error('源码为空');

        const type = opts.type || guessType(objPath);
        const name = objPath.replace(/^.*[/\\\\]/, '').toLowerCase();
        objBase = resolveAdtBase(name, type);
        const sourceUri = `${objBase}/source/main`;

        await client.autoConnect();
        const crypto = require('crypto');
        const connId = crypto.randomUUID();
        sessHeaders = {
          'sap-adt-connection-id': connId,
          'x-sap-adt-sessiontype': 'stateful',
          'Cookie': client.cookie,
          'X-CSRF-Token': client.csrfToken,
        };

        if (opts.forceUnlock) {
          const fur = await client.rawRequest('POST', `${objBase}?_action=UNLOCK&lockHandle=0`, {
            body: '',
            headers: { 'Content-Type': 'application/atom+xml; type=entry', ...sessHeaders },
          });
          if (fur.status === 200) {
            sessHeaders['sap-adt-connection-id'] = require('crypto').randomUUID();
          }
        }

        // 自动获取对象已有的传输号（用户未指定 --transport 时）
        let transportNr = opts.transport || '';
        if (!transportNr) {
          try {
            const trRes = await client.request('GET', `/sap/bc/adt/repository/informationsystem/objectproperties/transports?uri=${encodeURIComponent('/sap/bc/adt/' + objBase.split('/sap/bc/adt/')[1])}`);
            transportNr = trRes.body.match(/tpr:transport\s+number="([^"]+)"/)?.[1] || '';
          } catch {}
        }

        const lockUrl = `${objBase}?_action=LOCK&accessMode=MODIFY` + (transportNr ? `&corrNr=${transportNr.toUpperCase()}` : '');
        let r = await client.rawRequest('POST', lockUrl, {
          body: '',
          headers: { 'Content-Type': 'application/atom+xml; type=entry', ...sessHeaders },
        });
        if (r.status !== 200) throw new Error(`锁定失败: ${extractErrMsg(r.body)}`);
        lockHandle = r.body.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/i)?.[1];
        if (!lockHandle) throw new Error('获取 lockHandle 失败');

        const corrNr = transportNr;

        try {
          const putParams = `lockHandle=${encodeURIComponent(lockHandle)}` + (corrNr ? `&corrNr=${encodeURIComponent(corrNr)}` : '');
          r = await client.request('PUT', `${sourceUri}?${putParams}`, {
            body: source,
            headers: { 'Content-Type': 'text/plain; charset=utf-8', ...sessHeaders },
          });
          if (r.status !== 200) throw new Error(`写入失败: ${extractErrMsg(r.body)}`);
        } finally {
        }

        jsonOrText(
          `写入成功\n  对象: ${objPath}\n  类型: ${type}`,
          { success: true, path: objPath, type },
          opts.json
        );
      } catch (e) {
        console.error(`写入失败: ${e.message}`);
        process.exit(1);
      } finally {
        // 统一解锁（使用公共模块）
        await silentUnlock(objPath, client);
      }
    });
}

module.exports = { register };
