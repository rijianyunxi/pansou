import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { executeLinkAction, invalidReason } from '../utils/linkActions.ts';

const available = { status: 'completed', validity: 1, url: 'https://example.test/own-share', password: 'own1' };
function effects() {
  const log = [];
  return { log, api: {
    prepareOpen: () => { log.push('reserve'); return { navigate: url => log.push(['navigate', url]), close: () => log.push('close') }; },
    copy: async text => { log.push(['copy', await text]); },
    invalid: () => log.push('invalid'),
    failed: message => log.push(['error', message]),
  }};
}
test('open reserves a tab but only navigates after resolving the link', async () => {
  const e = effects(); let finish;
  const action = executeLinkAction('open', () => new Promise(resolve => { finish = resolve; }), e.api);
  assert.deepEqual(e.log, ['reserve']);
  finish(available); await action;
  assert.deepEqual(e.log, ['reserve', ['navigate', available.url]]);
});
test('copy uses the same resolution flow and copies only the returned URL', async () => {
  const e = effects(); let calls = 0;
  await executeLinkAction('copy', async () => { calls++; return available; }, e.api);
  assert.equal(calls, 1);
  assert.deepEqual(e.log, [['copy', available.url]]);
});
test('a link that already carries its own extraction code copies without the extra line', async () => {
  const e = effects();
  await executeLinkAction('copy', async () => ({ ...available, url: 'https://pan.baidu.com/s/1abc?pwd=own1' }), e.api);
  assert.deepEqual(e.log, [['copy', 'https://pan.baidu.com/s/1abc?pwd=own1']]);
});
test('generic URLs do not gain prose when their query code differs', async () => {
  const e = effects();
  await executeLinkAction('copy', async () => ({ ...available, url: 'https://example.test/share?pwd=other' }), e.api);
  assert.deepEqual(e.log, [['copy', 'https://example.test/share?pwd=other']]);
});
test('Baidu copies a single navigable URL with the resolved extraction code', async () => {
  const base = 'https://pan.baidu.com/s/1jzgJOGnGzpl0CoitZm_aKQ';
  for (const [url, password, expected] of [
    [base, 'z2m1', base + '?pwd=z2m1'],
    [base + '?pwd=old', 'z2m1', base + '?pwd=z2m1'],
    [base + '?from=search&pwd=old&pwd=other#files', 'z2m1', base + '?from=search&pwd=z2m1#files'],
    [base + '?pwd=z2m1', null, base + '?pwd=z2m1'],
    [base, null, base],
    [base, 'a+b&', base + '?pwd=a%2Bb%26'],
  ]) {
    const e = effects();
    await executeLinkAction('copy', async () => ({ ...available, url, password }), e.api);
    assert.deepEqual(e.log, [['copy', expected]]);
    assert.equal(new URL(e.log[0][1]).href, expected);
  }
});
test('other drive links keep query strings and mobile hash routes without appending password prose', async () => {
  for (const url of [
    'https://www.alipan.com/s/abc',
    'https://www.123pan.com/s/abc.html', 'https://cloud.189.cn/t/abc',
    'https://yun.139.com/shareweb/#/w/i/abc', 'https://drive.uc.cn/s/abc',
    'https://115cdn.com/s/abc?password=own1',
  ]) {
    const e = effects();
    await executeLinkAction('copy', async () => ({ ...available, url }), e.api);
    assert.deepEqual(e.log, [['copy', url]]);
    assert.equal(new URL(e.log[0][1]).href, new URL(url).href);
  }
});
test('Quark copies its extraction code in pwd before the hash route', async () => {
  const base = 'https://pan.quark.cn/s/abc';
  for (const url of [base, base + '?pwd=old#/list/share', base + '?from=search&pwd=old&pwd=other#/list/share']) {
    const e = effects();
    await executeLinkAction('copy', async () => ({ ...available, url }), e.api);
    const copied = new URL(e.log[0][1]);
    assert.equal(copied.searchParams.get('pwd'), 'own1');
    assert.equal(copied.searchParams.getAll('pwd').length, 1);
    assert.equal(copied.hash, new URL(url).hash);
    assert.ok(!e.log[0][1].includes('提取码'));
  }
});
test('Guangya copying and opening use one URL with its extraction code before the hash', async () => {
  const base = 'https://www.guangyapan.com/s/1953404474227400751_aeXCPJwocgzRgD8m';
  for (const url of [base, base + '#/share', base + '?code=old#/share']) {
    const value = { ...available, type: 'guangya', url, password: 'ewcc' };
    const expected = base + '?code=ewcc#/share';
    for (const action of ['copy', 'open']) {
      const e = effects();
      await executeLinkAction(action, async () => value, e.api);
      assert.deepEqual(e.log, action === 'copy' ? [['copy', expected]] : ['reserve', ['navigate', expected]]);
    }
  }
  for (const password of ['', null]) {
    const e = effects();
    await executeLinkAction('copy', async () => ({ ...available, url: base, password }), e.api);
    assert.deepEqual(e.log, [['copy', base + '#/share']]);
  }
  const e = effects();
  await executeLinkAction('copy', async () => ({ ...available, url: base + '?code=ewcc#/share', password: null }), e.api);
  assert.deepEqual(e.log, [['copy', base + '?code=ewcc#/share']]);
});
test('invalid links never navigate or copy, and show the invalid-link notice', async () => {
  for (const action of ['open', 'copy']) {
    const e = effects();
    const value = await executeLinkAction(action, async () => ({ status: 'unavailable', validity: 0 }), e.api);
    assert.equal(value.status, 'unavailable');
    assert.deepEqual(e.log, action === 'open' ? ['reserve', 'close', 'invalid'] : ['invalid']);
  }
});
test('a failed resolution closes the reserved tab, without navigation', async () => {
  const e = effects();
  await executeLinkAction('open', async () => { throw new Error('请重新搜索'); }, e.api);
  assert.deepEqual(e.log, ['reserve', 'close', ['error', '请重新搜索']]);
});
test('a denied clipboard operation is never reported as successful copying', async () => {
  const e = effects(); e.api.copy = async () => { throw new Error('请允许剪贴板权限'); };
  assert.equal(await executeLinkAction('copy', async () => available, e.api), undefined);
  assert.deepEqual(e.log, [['error', '请允许剪贴板权限']]);
});
test('expired deliveries cannot navigate or copy', async () => {
  for (const action of ['open', 'copy']) {
    const e = effects();
    await executeLinkAction(action, async () => ({ ...available, deliveryExpiresAt: '2000-01-01' }), e.api);
    assert.ok(e.log.some(value => Array.isArray(value) && value[0] === 'error'));
    assert.ok(!e.log.some(value => Array.isArray(value) && ['navigate', 'copy'].includes(value[0])));
  }
});
test('the card always displays both actions without tags or validity prose', async () => {
  const source = await readFile(new URL('../components/ResultGroup.vue', import.meta.url), 'utf8');
  const template = source.split('<script')[0];
  assert.ok(!template.includes('resource.tags'));
  assert.ok(!template.includes('statusLabel'));
  assert.ok(!template.includes('未检测'));
  assert.ok(!template.includes('获取链接</button>'));
  assert.match(template, /act\('open', resource, link\)/);
  assert.match(template, /act\('copy', resource, link\)/);
  assert.equal((template.match(/:disabled="!!loading\[link.linkRef\]"/g) || []).length, 2);
  assert.ok(!template.includes('|| isInvalid(link)'));
});
test('unknown checks allow original fallback, while absence gets a specific explanation', async () => {
  const e = effects();
  await executeLinkAction('copy', async () => ({ ...available, validity: -1, delivery: 'original' }), e.api);
  assert.deepEqual(e.log, [['copy', available.url]]);
  assert.equal(invalidReason({ reasonCode: 'resource_missing' }), '分享中的资源已不存在');
  assert.equal(invalidReason({ reasonCode: 'original_invalid' }), '原分享链接已失效');
});
