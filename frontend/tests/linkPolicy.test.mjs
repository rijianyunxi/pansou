import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse, compileTemplate } from '@vue/compiler-sfc';
import { baseParse } from '@vue/compiler-dom';
import { providerForm, providerPayload, providerError, folderKey, selectableDirectory } from '../lib/linkPolicy.ts';

test('loading existing policies preserves disabled flags and custom advanced values', () => {
  const original = { enabled: false, targetDir: '/项目', deliveryTtlSeconds: 5400, deliveryMinRemainingSeconds: 120, platformShareDays: 30 };
  const form = providerForm(original);
  assert.equal(form.hours, 1.5);
  assert.deepEqual(providerPayload(form), original);
  assert.equal(providerForm().enabled, false);
  assert.equal(providerPayload(providerForm()).deliveryTtlSeconds, null);
});
test('enabled transfer requires a non-root project directory', () => {
  for (const targetDir of ['', '/', '0', '///']) assert.match(providerError('quark', { ...providerForm(), enabled: true, targetDir, hours: 24 }), /专用目录/);
  const base = { ...providerForm(), enabled: true, hours: 24 };
  assert.equal(providerError('quark', { ...base, targetDir: 'folder_123-abc' }), '');
  assert.equal(providerError('baidu', { ...base, targetDir: '/项目/pansou' }), '');
  for (const targetDir of ['relative', '/a/../b', '/a/./b', '/a\\b', '/a\nb']) assert.match(providerError('baidu', { ...base, targetDir }), /完整路径/);
  assert.equal(providerError('quark', providerForm()), '');
});
test('retention conversion and advanced expiry window match server constraints', () => {
  const form = { ...providerForm(), enabled: true, targetDir: '123', hours: '24' };
  assert.equal(providerPayload(form).deliveryTtlSeconds, 86400);
  assert.equal(providerError('quark', { ...form, hours: '', }), '保留时间应在 1 分钟至 30 天之间。');
  for (const hours of ['invalid', 0, 721]) assert.match(providerError('quark', { ...form, hours }), /保留时间/);
  assert.match(providerError('quark', { ...form, deliveryMinRemainingSeconds: 86400 }), /必须小于/);
  assert.match(providerError('quark', { ...form, deliveryMinRemainingSeconds: 1.5 }), /必须小于/);
  assert.equal(providerError('quark', { ...form, hours: 1 / 60, deliveryMinRemainingSeconds: 0 }), '');
});
test('folder selection uses Quark fid but Baidu path and excludes roots', () => {
  const folder = { id: '123', name: '专用目录', path: '/项目', isDir: true };
  assert.equal(folderKey('quark', folder), '123');
  assert.equal(folderKey('baidu', folder), '/项目');
  for (const value of ['', '0', '/', '///']) assert.equal(selectableDirectory(value), false);
});
test('cloud account grid contains only account cards, policies span their own section', async () => {
  const page = await readFile(new URL('../components/admin/AdminFeaturePage.vue', import.meta.url), 'utf8');
  const { descriptor } = parse(page);
  const root = compileTemplate({ source: descriptor.template.content, filename: 'AdminFeaturePage.vue', id: 'accounts' });
  assert.deepEqual(root.errors, []);
  function find(node, predicate) {
    if (predicate(node)) return node;
    for (const child of node.children || []) { const result = find(child, predicate); if (result) return result; }
  }
  const grid = find(baseParse(descriptor.template.content), node => node.type === 1 && node.props.some(prop => prop.name === 'class' && prop.value?.content === 'cloud-account-grid'));
  assert.ok(grid);
  assert.equal(find(grid, node => node.tag === 'LinkDeliverySettings'), undefined);
  assert.equal(grid.children.filter(node => node.tag === 'section').length, 2);
});
