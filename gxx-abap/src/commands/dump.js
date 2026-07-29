/**
 * dump 命令 - 查看短转储(DUMP)
 */

const { jsonOrText } = require('../lib/helpers');
const { cleanDumpText, parseDumpSections } = require('../lib/dump-parser');

function register(program, client, cfg) {
  program
    .command('dump')
    .description('查看短转储(DUMP)')
    .argument('[id]', 'DUMP ID（不传则列出所有）')
    .option('--from <time>', '起始时间 (YYYYMMDDHHMMSS)')
    .option('--json', 'JSON格式输出')
    .action(async (id, opts) => {
      try {
        if (id) {
          // 如果 ID 不是完整路径，先从列表中查找完整 ID
          let fullId = id;
          if (!id.includes('/') && !id.includes('%')) {
            const listRes = await client.request('GET', '/sap/bc/adt/runtime/dumps');
            const entryRegex = /<(?:atom:)?entry>([\s\S]*?)<\/(?:atom:)?entry>/g;
            let m;
            while ((m = entryRegex.exec(listRes.body)) !== null) {
              const eid = m[1].match(/<(?:atom:)?id>([^<]+)/)?.[1] || '';
              const ts = (eid.match(/\/(\d{14})/) || [])[1];
              if (ts === id) { fullId = eid.split('/').pop(); break; }
            }
          }
          const encodedId = fullId.includes('%') ? fullId : encodeURIComponent(fullId);
          const res = await client.request('GET', `/sap/bc/adt/runtime/dump/${encodedId}`);

          const title = res.body.match(/title="([^"]+)"/)?.[1] || '';
          const error = res.body.match(/error="([^"]+)"/)?.[1] || '';
          const prog = res.body.match(/terminatedProgram="([^"]+)"/)?.[1] || '';
          const author = res.body.match(/author="([^"]+)"/)?.[1] || '';
          const dt = res.body.match(/datetime="([^"]+)"/)?.[1] || '';
          const time = dt.replace('T', ' ').substring(0, 19);
          const exception = res.body.match(/exception="([^"]+)"/)?.[1] || '';

          // 解析章节
          const chapterList = [];
          const chRegex = /<dump:chapter\s+name="([^"]+)"\s+title="([^"]+)"\s+category="([^"]+)"\s+line="([^"]+)"\s+chapterOrder="([^"]+)"\s+categoryOrder="([^"]+)"/g;
          let cm;
          while ((cm = chRegex.exec(res.body)) !== null) {
            chapterList.push({ name: cm[1], title: cm[2], category: cm[3], line: parseInt(cm[4]), chapterOrder: parseInt(cm[5]), categoryOrder: parseInt(cm[6]) });
          }
          chapterList.sort((a, b) => a.chapterOrder - b.chapterOrder);

          const chapterGroups = {};
          for (const ch of chapterList) {
            if (!chapterGroups[ch.category]) chapterGroups[ch.category] = [];
            chapterGroups[ch.category].push({ title: ch.title, line: ch.line });
          }

          const contUri = res.body.match(/relation="contents"\s+uri="([^"]+)"/)?.[1] || '';
          const termMatch = res.body.match(/relation="[^"]*termination"\s+uri="adt:\/\/\w+([^"]+)"/);
          const termination = termMatch ? termMatch[1] : null;
          let termSource = null;
          let termLine = null;
          if (termination) {
            const lm = termination.match(/#start=(\d+)/);
            termSource = termination.replace(/#start=\d+/, '');
            termLine = lm ? parseInt(lm[1]) : null;
          }

          let contentText = '';
          if (contUri) {
            try {
              const contRes = await client.request('GET', contUri);
              contentText = contRes.body.replace(/\r/g, '');
            } catch(e) { /* ignore */ }
          }

          if (opts.json) {
            const cleanedContent = contentText ? cleanDumpText(contentText) : '';
            const parsedSections = contentText ? parseDumpSections(contentText) : [];
            const jsonObj = {
              dumpId: id,
              title: res.body.match(/title="([^"]+)"/)?.[1] || '',
              error: res.body.match(/error="([^"]+)"/)?.[1] || '',
              exception: res.body.match(/exception="([^"]+)"/)?.[1] || '',
              program: res.body.match(/terminatedProgram="([^"]+)"/)?.[1] || '',
              author: res.body.match(/author="([^"]+)"/)?.[1] || '',
              datetime: res.body.match(/datetime="([^"]+)"/)?.[1] || '',
              server: res.body.match(/serverInstance="([^"]+)"/)?.[1] || '',
              termination: termSource ? { uri: termSource, line: termLine } : null,
              chapters: chapterGroups,
              chapterList: chapterList.map(c => ({ title: c.title, category: c.category, line: c.line })),
              content: contentText,
              cleanedContent: cleanedContent,
              sections: parsedSections,
            };
            console.log(JSON.stringify(jsonObj, null, 2));
            return;
          }

          console.log(`\nDUMP 详情\n`);
          console.log(`  时间:      ${time}`);
          console.log(`  错误:      ${error}`);
          console.log(`  异常:      ${exception || '(无)'}`);
          console.log(`  程序:      ${prog}`);
          console.log(`  用户:      ${author}`);
          if (termSource) console.log(`  出错行:    ${termLine || '?'}`);
          console.log(`\n  章节 (${chapterList.length}):`);
          const categories = [...new Set(chapterList.map(c => c.category))];
          for (const cat of categories) {
            console.log(`\n  ${cat}:`);
            for (const ch of chapterList.filter(c => c.category === cat)) {
              console.log(`    - ${ch.title} (行 ${ch.line})`);
            }
          }

        } else {
          const fromVal = opts.from && opts.from.length === 8 ? opts.from + '000000' : opts.from;
          const url = '/sap/bc/adt/runtime/dumps' + (fromVal ? '?from=' + fromVal : '');
          const res = await client.request('GET', url);

          const entries = [];
          const entryRegex = /<(?:atom:)?entry>([\s\S]*?)<\/(?:atom:)?entry>/g;
          let m;
          while ((m = entryRegex.exec(res.body)) !== null) {
            const e = m[1];
            const title = e.match(/<(?:atom:)?title[^>]*>([^<]+)/)?.[1] || '';
            const time = e.match(/<(?:atom:)?updated>([^<]+)/)?.[1] || '';
            const errId = e.match(/<(?:atom:)?id>([^<]+)/)?.[1] || '';
            const shortId = (errId.match(/\/(\d{14})/) || [])[1] || errId.substring(0, 20);
            const fullId = errId.split('/').pop();
            entries.push({ id: shortId, fullId, title, time: time.replace('T', ' ').substring(0, 19) });
          }

          if (opts.json) {
            console.log(JSON.stringify({ count: entries.length, dumps: entries }, null, 2));
          } else if (entries.length === 0) {
            console.log('暂无短转储记录');
          } else {
            console.log(`短转储列表 (共 ${entries.length} 条)\n`);
            for (const e of entries) {
              console.log(`  ${e.time}  ${e.id} ${e.title}`);
            }
          }
        }
      } catch (e) {
        console.error(`获取DUMP失败: ${e.message}`);
        process.exit(1);
      }
    });
}

module.exports = { register };
