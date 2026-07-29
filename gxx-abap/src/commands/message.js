/**
 * message 命令 - 查看消息类
 */

const { jsonOrText } = require('../lib/helpers');

function register(program, client, cfg) {
  program
    .command('message')
    .description('查看消息类')
    .argument('<name>', '消息类名')
    .option('--json', 'JSON格式输出')
    .action(async (msgName, opts) => {
      try {
        const name = msgName.toUpperCase();
        const metaRes = await client.request('GET', `/sap/bc/adt/messageclass/${name.toLowerCase()}`);
        if (metaRes.status !== 200) throw new Error(metaRes.body.match(/<message[^>]*>([^<]+)/)?.[1] || '未找到');

        // 解析消息
        const messages = [];
        const msgRe = /<mc:messages\s+mc:msgno="(\d+)"[^>]*mc:msgtext="([^"]*)"[^>]*>/g;
        let mm;
        while ((mm = msgRe.exec(metaRes.body)) !== null) {
          messages.push({ number: mm[1], text: mm[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') });
        }

        if (opts.json) {
          console.log(JSON.stringify({ name, count: messages.length, messages }, null, 2));
        } else {
          console.log(`\n消息类: ${name} (${messages.length} 条)\n`);
          for (const msg of messages) {
            console.log(`  ${msg.number}: ${msg.text}`);
          }
        }
      } catch (e) {
        console.error(`获取消息类失败: ${e.message}`);
        process.exit(1);
      }
    });
}

module.exports = { register };
