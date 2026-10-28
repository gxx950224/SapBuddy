import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', '..');
// SapBuddy 技能随包放在 defaults/skills，运行时由 syncDefaultSkills 补发到 ~/.SapBuddy/skills
const skillsRoot = join(pkgRoot, 'defaults', 'skills');
const sapFs = join(skillsRoot, 'sap-fs');

const required = [
  'SKILL.md',
  'references/fs-contract.md',
  'references/system-verification.md',
  'references/grilling-integration.md',
  'references/review-checklist.md',
  'references/types/interface.md',
  'references/types/query-report.md',
  'references/types/functional-report.md',
  'references/types/enhancement.md',
  'assets/templates/fs-base.md',
  'assets/templates/interface.md',
  'assets/templates/query-report.md',
  'assets/templates/functional-report.md',
  'assets/templates/enhancement.md',
  'assets/templates/fs-archive.html',
  'references/archive-html.md',
];

test('sap-fs 技能树文件齐全', () => {
  for (const rel of required) {
    assert.ok(existsSync(join(sapFs, rel)), `缺少 ${rel}`);
  }
});

test('sap-fs 与 grilling 可被 skills 根目录发现', () => {
  const names = readdirSync(skillsRoot);
  assert.ok(names.includes('sap-fs'));
  assert.ok(names.includes('grilling'));
  assert.ok(!names.includes('grill-me'), '不应再保留 grill-me 别名');
  assert.ok(!existsSync(join(skillsRoot, 'THIRD_PARTY_NOTICES.md')), '通知应内嵌 grilling');
  assert.ok(existsSync(join(skillsRoot, 'grilling', 'SKILL.md')));
});

test('SKILL.md frontmatter 名称正确', () => {
  const text = readFileSync(join(sapFs, 'SKILL.md'), 'utf8');
  assert.match(text, /^---\nname: sap-fs\n/m);
  assert.match(text, /grilling/);
  assert.match(text, /output\/fs\//);
  assert.doesNotMatch(text, /grill-me/);
});

test('sap-fs description 收紧意图：明确交付 + 不明先问 + 不触发日常', () => {
  const text = readFileSync(join(sapFs, 'SKILL.md'), 'utf8');
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(fm, '应有 frontmatter');
  const desc = fm[1];
  assert.match(desc, /明确/);
  assert.match(desc, /先问/);
  assert.match(desc, /不触发/);
  assert.doesNotMatch(desc, /用户描述业务需求.*时触发/);
  assert.match(text, /意图不明/);
  assert.match(text, /先问一句/);
  assert.match(text, /日常问答/);
});

test('grilling 含上游钉选注释且覆盖 grill me 触发', () => {
  const text = readFileSync(join(skillsRoot, 'grilling', 'SKILL.md'), 'utf8');
  assert.match(text, /name: grilling/);
  assert.match(text, /mattpocock\/skills/);
  assert.match(text, /df69d9936880cd3314c28858c6c52f48db23b856/);
  assert.match(text, /grill me/i);
});

test('模板相对路径在技能目录内可解析', () => {
  const skill = readFileSync(join(sapFs, 'SKILL.md'), 'utf8');
  const refs = [...skill.matchAll(/`((?:references|assets)\/[^`]+)`/g)].map((m) => m[1]);
  assert.ok(refs.length >= 5, 'SKILL 应引用若干相对资源');
  for (const rel of refs) {
    if (rel.includes('<')) continue;
    assert.ok(existsSync(join(sapFs, rel)), `相对路径不可解析: ${rel}`);
  }
});

test('fs-base 编号含 M；功能报表 3.2 有示范行；查询含实现方式', () => {
  const base = readFileSync(join(sapFs, 'assets/templates/fs-base.md'), 'utf8');
  assert.match(base, /M 消息/);
  const functional = readFileSync(join(sapFs, 'assets/templates/functional-report.md'), 'utf8');
  assert.match(functional, /WERKS/);
  assert.match(functional, /实现方式与取舍/);
  const query = readFileSync(join(sapFs, 'assets/templates/query-report.md'), 'utf8');
  assert.match(query, /实现方式与取舍/);
});

test('示例无尖括号示例项目残留，T-03/T-04 含依赖标注', () => {
  const ex = join(sapFs, 'references/example-enhancement.md');
  if (!existsSync(ex)) return;
  const text = readFileSync(ex, 'utf8');
  assert.doesNotMatch(text, /<示例项目>/);
  assert.match(text, /依赖 Q-01/);
});

test('SYSTEM.md 铁律 9 是 FS 意图门禁，铁律 8 钩到 sap-fs', () => {
  const system = readFileSync(join(pkgRoot, 'SYSTEM.md'), 'utf8');
  assert.match(system, /写 FS \/ 功能设计书时遵循 `sap-fs`/);
  assert.match(system, /9\. \*\*FS 意图门禁（强制）\*\*/);
  assert.match(system, /先问一句/);
  assert.match(system, /禁止\*\*触发 sap-fs/);
  assert.match(system, /dev-write/);
  assert.match(system, /abap-code-review/);
  assert.match(system, /abap-explain/);
  assert.match(system, /~\/\.SapBuddy\/skills\/sap-fs\/SKILL\.md/);
  assert.match(system, /~\/\.SapBuddy\/skills\/grilling\/SKILL\.md/);
  assert.match(system, /~\/\.SapBuddy\/output\/fs\//);
  assert.doesNotMatch(system, /~\/\.dsh/);
  assert.doesNotMatch(system, /Skill 工具/);
  assert.doesNotMatch(system, /sapbuddy-dsh/);
});

test('技能正文不依赖 DSH Skill 工具或 preset 路径', () => {
  const files = [
    join(sapFs, 'SKILL.md'),
    join(sapFs, 'references/grilling-integration.md'),
    join(sapFs, 'references/archive-html.md'),
    join(skillsRoot, 'grilling', 'SKILL.md'),
  ];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /sapbuddy-dsh/);
    assert.doesNotMatch(text, /~\/\.dsh/);
    assert.doesNotMatch(text, /Skill 工具/);
    assert.doesNotMatch(text, /用 Skill /);
    assert.doesNotMatch(text, /\bcordis\b/);
  }
  const grilling = readFileSync(join(skillsRoot, 'grilling', 'SKILL.md'), 'utf8');
  assert.match(grilling, /no sub-agent tool/);
  assert.match(grilling, /built-in read-only tools/);
});

test('HTML 归档模板无 logo，接口模板含样例 JSON', () => {
  const html = readFileSync(join(sapFs, 'assets/templates/fs-archive.html'), 'utf8');
  assert.doesNotMatch(html, /<img\b/i);
  assert.match(html, /Generated by SapBuddy/);
  assert.doesNotMatch(html, /Claude-style archive/);
  // footer must not carry the old "no logo" branding phrase
  const footerMatch = html.match(/<footer>[\s\S]*?<\/footer>/i);
  assert.ok(footerMatch, '应有 footer');
  assert.match(footerMatch[0], /Generated by SapBuddy/);
  assert.doesNotMatch(footerMatch[0], /no logo/i);
  assert.doesNotMatch(footerMatch[0], /Claude-style/i);
  assert.match(html, /cds-clay/);
  assert.match(html, /Claude/i); // CSS comment / design tokens OK
  assert.match(html, /copy-btn|复制/);
  assert.match(html, /BODY_HTML/);
  const iface = readFileSync(join(sapFs, 'assets/templates/interface.md'), 'utf8');
  assert.match(iface, /样例 JSON/);
  assert.match(iface, /```json/);
});
