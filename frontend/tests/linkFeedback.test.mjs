import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse, compileScript } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as vue from 'vue';
import { useToast } from '../composables/useToast.ts';
import * as linkActions from '../utils/linkActions.ts';
import { usable } from '../utils/linkResolution.ts';

const available = { status: 'completed', validity: 1, url: 'https://example.test/share', password: '1234' };
const resource = { resultRef: 'result' };
const link = { linkRef: 'link' };

async function setupCard({ resolve = async () => available, copy = async () => {}, crypto = { randomUUID: () => 'test-key' } } = {}) {
  const source = await readFile(new URL('../components/ResultGroup.vue', import.meta.url), 'utf8');
  const { descriptor } = parse(source);
  const script = compileScript(descriptor, { id: 'link-feedback-test' });
  const compiled = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const feedback = useToast();
  const messages = [];
  const showToast = (...args) => { messages.push(args); return feedback.showToast(...args); };
  const hooks = [];
  const popup = { opener: {}, document: { title: '', body: { textContent: '' } }, closed: false,
    location: { replace(url) { popup.url = url; } }, close() { popup.closed = true; } };
  const require = name => {
    if (name === 'vue') return { ...vue, inject: () => showToast, onBeforeUnmount: hook => hooks.push(hook) };
    if (name.includes('linkActions')) return linkActions;
    if (name.includes('linkResolution')) return { resolveLink: resolve, usable };
    return {};
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'window', 'navigator', 'ClipboardItem', 'crypto', compiled)(
    require, module, module.exports, { open: () => popup }, { clipboard: { writeText: copy } }, undefined, crypto,
  );
  const component = module.exports.default.setup({ items: [], expanded: true }, { expose() {}, emit() {} });
  return { component, feedback, messages, popup, unmount() { hooks.forEach(hook => hook()); },
    cleanup() { hooks.forEach(hook => hook()); feedback.hideToast(); } };
}

test('processing feedback remains until the clipboard write succeeds', async () => {
  let finishResolve;
  let finishCopy;
  let markCopyStarted;
  const copyStarted = new Promise(resolve => { markCopyStarted = resolve; });
  const card = await setupCard({
    resolve: () => new Promise(resolve => { finishResolve = resolve; }),
    copy: () => new Promise(resolve => { finishCopy = resolve; markCopyStarted(); }),
  });
  try {
    const action = card.component.act('copy', resource, link);
    assert.equal(card.feedback.toast.value.loading, true);
    assert.match(card.feedback.toast.value.message, /正在获取并复制/);
    finishResolve(available);
    await copyStarted;
    assert.equal(card.feedback.toast.value.type, 'info');
    assert.equal(card.component.copiedKey.value, '');
    finishCopy();
    await action;
    assert.equal(card.feedback.toast.value.type, 'success');
    assert.match(card.feedback.toast.value.message, /链接已复制；提取码可点击单独复制/);
    assert.equal(card.feedback.toast.value.show, true);
    assert.equal(card.component.copiedKey.value, 'link');
    assert.equal(card.component.loading.link, undefined);
  } finally { card.cleanup(); }
});

test('open reports progress immediately and success after requesting navigation', async () => {
  let finish;
  const card = await setupCard({ resolve: () => new Promise(resolve => { finish = resolve; }) });
  try {
    const action = card.component.act('open', resource, link);
    assert.match(card.feedback.toast.value.message, /即将打开/);
    assert.equal(card.popup.url, undefined);
    finish(available);
    await action;
    assert.equal(card.popup.url, available.url);
    assert.equal(card.feedback.toast.value.type, 'success');
    assert.match(card.feedback.toast.value.message, /已请求浏览器打开/);
  } finally { card.cleanup(); }
});

test('copy without a password reports only the copied link', async () => {
  const card = await setupCard({ resolve: async () => ({ ...available, password: null }) });
  try {
    await card.component.act('copy', resource, link);
    assert.equal(card.feedback.toast.value.message, '链接已复制，可粘贴打开');
  } finally { card.cleanup(); }
});
test('a blocked share explicitly reports that the original link was copied or opened', async () => {
  for (const action of ['copy', 'open']) {
    const card = await setupCard({ resolve: async () => ({ ...available, delivery: 'original', reasonCode: 'share_verification_required' }) });
    try {
      await card.component.act(action, resource, link);
      assert.equal(card.feedback.toast.value.type, 'info');
      assert.match(card.feedback.toast.value.message, /安全验证/);
      assert.match(card.feedback.toast.value.message, action === 'copy' ? /已复制原链接/ : /已打开原链接/);
      assert.ok(!card.messages.some(([, type]) => type === 'success'));
    } finally { card.cleanup(); }
  }
});
test('password copying preserves the code without another resolution, and rejects expired or invalid deliveries', async () => {
  const copied = []; let resolves = 0;
  const card = await setupCard({ resolve: async () => { resolves++; return available; }, copy: async text => { copied.push(text); } });
  try {
    await card.component.act('copy', resource, link);
    await card.component.copyPassword('link');
    assert.deepEqual(copied, [available.url, available.password]);
    assert.equal(resolves, 1);
    assert.equal(card.feedback.toast.value.message, '提取码已复制');
    for (const value of [{ ...available, deliveryExpiresAt: '2000-01-01' }, { ...available, validity: 0 }]) {
      card.component.resolved.link = value;
      await card.component.copyPassword('link');
      assert.equal(copied.length, 2);
      assert.equal(card.feedback.toast.value.type, 'error');
    }
  } finally { card.cleanup(); }
});
test('password copy failures are reported without success', async () => {
  const card = await setupCard({ copy: async () => { throw new DOMException('Denied', 'NotAllowedError'); } });
  try {
    card.component.resolved.link = available;
    await card.component.copyPassword('link');
    assert.equal(card.feedback.toast.value.type, 'error');
    assert.equal(card.component.copyingPassword.value, '');
    assert.ok(!card.messages.some(([, type]) => type === 'success'));
  } finally { card.cleanup(); }
});

test('inline progress follows backend stages and is removed on completion', async () => {
  let finish, notify;
  const card = await setupCard({ resolve: (_r, _l, _k, _signal, _resume, onProgress) => {
    notify = onProgress;
    return new Promise(resolve => { finish = resolve; });
  } });
  try {
    const pending = card.component.act('open', resource, link);
    assert.equal(card.component.progress.link.stage, 'queued');
    notify({ stage: 'transferring' });
    assert.equal(card.component.progress.link.stage, 'transferring');
    notify({ stage: 'sharing' });
    assert.equal(card.component.stageLabel(card.component.progress.link.stage), '生成分享');
    assert.match(card.popup.document.body.innerHTML, /spinner/);
    finish(available);
    await pending;
    assert.equal(card.component.progress.link, undefined);
  } finally { card.cleanup(); }
});

test('clipboard denial, invalid links and setup failures show errors without success', async () => {
  for (const options of [
    { copy: async () => { throw new DOMException('Write permission denied', 'NotAllowedError'); } },
    { resolve: async () => ({ status: 'unavailable', validity: 0, reasonCode: 'resource_missing' }) },
    { crypto: { randomUUID: () => { throw new Error('当前浏览器不支持此操作'); } } },
  ]) {
    const card = await setupCard(options);
    try {
      await card.component.act('copy', resource, link);
      assert.equal(card.feedback.toast.value.type, 'error');
      assert.equal(card.feedback.toast.value.show, true);
      assert.ok(!card.messages.some(([, type]) => type === 'success'));
      assert.equal(card.component.copiedKey.value, '');
      assert.equal(card.component.loading.link, undefined);
      assert.ok(!card.feedback.toast.value.message.includes('Write permission denied'));
    } finally { card.cleanup(); }
  }
});

test('unmount cancels pending feedback and duplicate clicks do not start another request', async () => {
  let calls = 0;
  const card = await setupCard({ resolve: (_result, _link, _key, signal) => {
    calls++;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('已取消')), { once: true }));
  } });
  try {
    const action = card.component.act('copy', resource, link);
    await card.component.act('copy', resource, link);
    assert.equal(calls, 1);
    assert.equal(card.messages.length, 1);
    card.unmount();
    await action;
    assert.equal(card.feedback.toast.value.show, false);
    assert.equal(card.messages.length, 1);
  } finally { card.cleanup(); }
});

test('progress persists, completed notices expire, and older cleanup cannot hide newer feedback', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const feedback = useToast();
  try {
    const dismissProgress = feedback.showToast('正在复制', 'info', { duration: 0, loading: true });
    t.mock.timers.tick(20000);
    assert.equal(feedback.toast.value.show, true);
    feedback.showToast('复制完成', 'success');
    dismissProgress();
    assert.equal(feedback.toast.value.show, true);
    t.mock.timers.tick(3499);
    assert.equal(feedback.toast.value.show, true);
    t.mock.timers.tick(1);
    assert.equal(feedback.toast.value.show, false);
    feedback.showToast('请重试', 'error');
    t.mock.timers.tick(6000);
    assert.equal(feedback.toast.value.show, false);
  } finally { feedback.hideToast(); }
});
