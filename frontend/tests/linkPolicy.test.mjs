import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse, compileTemplate } from '@vue/compiler-sfc';
import { baseParse } from '@vue/compiler-dom';
import { providerForm, providerPayload, providerError, durationLabel, directoryLabel, folderKey, selectableDirectory } from '../lib/linkPolicy.ts';

test('loading an existing policy preserves disabled flags and advanced values', () => {
  const original = {
    provider: 'quark', enabled: true, targetDir: '/项目', targetDirName: '项目',
    retentionSeconds: 5400, deliveryMinRemainingSeconds: 120, platformShareDays: 30,
    checkIntervalSeconds: 5, checkValidSeconds: 900, checkInvalidSeconds: 3600,
    checkDailyBudget: 500, revision: 3,
  };
  const form = providerForm(original);
  assert.equal(form.hours, 1.5);
  assert.deepEqual(providerPayload(form), original);
  assert.equal(providerForm().enabled, false);
  assert.equal(providerPayload(providerForm()).retentionSeconds, null);
  assert.equal(providerForm().checkDailyBudget, 1000);
});
test('enabled transfer requires a non-root project directory', () => {
  const base = { ...providerForm({ provider: 'quark' }), enabled: true, targetDir: 'folder_123-abc', hours: 24 };
  for (const targetDir of ['', '/', '0', '///']) assert.match(providerError('quark', { ...base, targetDir }), /专用目录/);
  assert.equal(providerError('quark', base), '');
  assert.equal(providerError('baidu', { ...base, targetDir: '/项目/pansou' }), '');
  for (const targetDir of ['relative', '/a/../b', '/a/./b', '/a\\b', '/a\nb']) assert.match(providerError('baidu', { ...base, targetDir }), /完整路径/);
  assert.equal(providerError('quark', providerForm()), '');
});
test('retention conversion and advanced expiry window match server constraints', () => {
  const form = { ...providerForm({ provider: 'quark' }), enabled: true, targetDir: '123', hours: '24' };
  assert.equal(providerPayload(form).retentionSeconds, 86400);
  assert.equal(providerError('quark', { ...form, hours: '' }), '清理时间应在 1 分钟至 30 天之间。');
  for (const hours of ['invalid', 0, 721]) assert.match(providerError('quark', { ...form, hours }), /清理时间/);
  assert.match(providerError('quark', { ...form, deliveryMinRemainingSeconds: 86400 }), /必须小于/);
  assert.match(providerError('quark', { ...form, deliveryMinRemainingSeconds: 1.5 }), /必须小于/);
  assert.equal(providerError('quark', { ...form, hours: 1 / 60, deliveryMinRemainingSeconds: 0 }), '');
});
test('detection parameters are validated even while transfer stays disabled', () => {
  const disabled = providerForm({ provider: 'baidu' });
  assert.match(providerError('baidu', { ...disabled, checkIntervalSeconds: 1 }), /检测间隔/);
  assert.match(providerError('baidu', { ...disabled, checkValidSeconds: 10 }), /有效结果缓存/);
  assert.match(providerError('baidu', { ...disabled, checkInvalidSeconds: 10 }), /失效结果缓存/);
  assert.match(providerError('baidu', { ...disabled, checkDailyBudget: 0 }), /每日检测上限/);
  assert.equal(providerError('baidu', disabled), '');
});
test('duration and directory labels describe the stored policy', () => {
  assert.equal(durationLabel(86400), '1 天');
  assert.equal(durationLabel(3600), '1 小时');
  assert.equal(durationLabel(5400), '90 分钟');
  assert.equal(durationLabel(null), '未设置');
  assert.equal(directoryLabel({ provider: 'quark', targetDir: null, targetDirName: '' }), '未选择');
  assert.equal(directoryLabel({ provider: 'quark', targetDir: 'abc', targetDirName: '项目' }), '项目');
  assert.equal(directoryLabel({ provider: 'quark', targetDir: 'abc', targetDirName: '' }), '已配置项目专用目录');
  assert.equal(directoryLabel({ provider: 'baidu', targetDir: '/pansou', targetDirName: '' }), '/pansou');
});
test('folder selection uses Quark fid but Baidu path and excludes roots', () => {
  const folder = { id: '123', name: '专用目录', path: '/项目', isDir: true };
  assert.equal(folderKey('quark', folder), '123');
  assert.equal(folderKey('baidu', folder), '/项目');
  for (const value of ['', '0', '/', '///']) assert.equal(selectableDirectory(value), false);
});
test('the netdisk page merges account and policy into one card per provider', async () => {
  const page = await readFile(new URL('../pages/admin/cloud-accounts.vue', import.meta.url), 'utf8');
  const { descriptor } = parse(page);
  const root = compileTemplate({ source: descriptor.template.content, filename: 'cloud-accounts.vue', id: 'accounts' });
  assert.deepEqual(root.errors, []);
  const ast = baseParse(descriptor.template.content);
  function find(node, predicate) {
    if (predicate(node)) return node;
    for (const child of node.children || []) { const result = find(child, predicate); if (result) return result; }
  }
  const grid = find(ast, node => node.type === 1 && (node.props || []).some(prop => prop.name === 'class' && prop.value?.content === 'account-grid'));
  assert.ok(grid, 'the provider grid must exist');
  assert.ok(find(grid, node => node.tag === 'CloudProviderCard'), 'each provider is rendered as a card');
  assert.equal(find(grid, node => node.tag === 'LinkDeliverySettings'), undefined);
  assert.ok(find(ast, node => node.tag === 'CloudPolicyDialog'), 'the transfer dialog is rendered from the page');
  assert.equal(find(ast, node => node.type === 1 && (node.props || []).some(prop => prop.name === 'class' && prop.value?.content === 'account-tabs')), undefined);
  assert.doesNotMatch(page, /route\.query\.tab|LinkDeliverySettings/);
  assert.match(page, /'\/api\/settings\/cloud-providers'/);
  assert.match(page, /`\/api\/settings\/cloud-providers\/\$\{key\}`/);
});
test('the transfer dialog owns delivery and detection parameters', async () => {
  const dialog = await readFile(new URL('../components/admin/CloudPolicyDialog.vue', import.meta.url), 'utf8');
  assert.match(dialog, /按需转存/);
  assert.match(dialog, /有效性检测参数/);
  assert.match(dialog, /providerError\(props\.provider, form\)/);
  assert.match(dialog, /@click="save"/);
  const card = await readFile(new URL('../components/admin/CloudProviderCard.vue', import.meta.url), 'utf8');
  assert.match(card, /emit\('configure'\)/);
  assert.match(card, /durationLabel\(policy\.retentionSeconds\)/);
});
test('the netdisk page keeps page-level prose out and the card facts aligned', async () => {
  const page = await readFile(new URL('../pages/admin/cloud-accounts.vue', import.meta.url), 'utf8');
  const template = parse(page).descriptor.template.content;
  assert.doesNotMatch(page, /集中连接五家网盘/);
  assert.doesNotMatch(page, /转存仅在用户复制或打开链接时触发/);
  const texts = [];
  (function walk(node) {
    if (node.type === 2) texts.push(node.content.trim());
    for (const child of node.children || []) walk(child);
  })(baseParse(template));
  for (const text of texts) assert.ok(text.length <= 30, `page copy must stay short: ${text}`);
  const card = await readFile(new URL('../components/admin/CloudProviderCard.vue', import.meta.url), 'utf8');
  assert.match(card, /<dl class="provider-facts">/);
  assert.match(card, /\.provider-facts > div \{ display: grid; grid-template-columns: 30px minmax\(0, 1fr\)/);
  assert.match(card, /\.policy-row \{ display: grid; grid-template-columns: 30px minmax\(0, 1fr\) auto/);
  assert.doesNotMatch(card, /<span class="policy-label">转存<\/span>[\s\S]{0,120}?emit\('configure'\)[\s\S]{0,40}?转存<\/Button>/);
  assert.match(card, /emit\('configure'\)">配置<\/Button>/);
});
