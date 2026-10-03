const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../utils/auth');
const links = require('../utils/linkResolution');
let stored;
test('Guangya links carry codes in one directly usable URL', () => {
  const { guangyaBrowserUrl, clipboardText } = require('../utils/shareLinks');
  const base = 'https://www.guangyapan.com/s/1953404474227400751_aeXCPJwocgzRgD8m';
  for (const url of [base, base + '#/share', base + '?code=old#/share']) {
    const value = { url, password: 'ewcc' };
    assert.equal(guangyaBrowserUrl(value), base + '?code=ewcc#/share');
    assert.equal(clipboardText(value), base + '?code=ewcc#/share');
  }
  assert.equal(clipboardText({ url: base }), base + '#/share');
  assert.equal(clipboardText({ url: base + '?code=ewcc#/share' }), base + '?code=ewcc#/share');
  assert.equal(clipboardText({ url: 'https://pan.quark.cn/s/abc', password: 'own1' }), 'https://pan.quark.cn/s/abc\n提取码：own1');
  assert.equal(guangyaBrowserUrl({ url: 'https://www.guangyapan.com.evil.test/s/abc' }), null);
});
global.wx = {
  getStorageSync: () => stored,
  setStorageSync: (_key, value) => { stored = value; },
  removeStorageSync: () => { stored = null; },
};

test('anonymous session is stored, existing login is never overwritten', () => {
  stored = null;
  auth.storeAnonymousSession({ authenticated: false, sessionId: 'anonymous' });
  assert.equal(auth.getSession().token, 'anonymous');
  stored = { token: 'logged-in', user: { id: 1 } };
  auth.storeAnonymousSession({ authenticated: false, sessionId: 'other' });
  assert.equal(auth.getSession().token, 'logged-in');
});

test('each new click revalidates the owned share despite historical original invalidity', async () => {
  const clipboard = require('../utils/clipboard');
  const originalResolve = links.resolveLink, originalCopy = clipboard.copyLink;
  const resolves = [], copied = [], opened = [];
  links.resolveLink = async (_r, _l, key, _control, resume) => {
    resolves.push({ key, resume });
    return { status: 'completed', validity: 1, delivery: 'reshared', originalValidity: 0, url: 'https://example.test/share', password: 'own1' };
  };
  clipboard.copyLink = async text => { copied.push(text); return true; };
  wx.navigateTo = ({ url, success }) => { opened.push(url); success({ eventChannel: { emit: (_event, value) => opened.push(value.url) } }); };
  let spec; global.Component = value => { spec = value; };
  delete require.cache[require.resolve('../components/resource-card/index')];
  require('../components/resource-card/index');
  const card = { data: { ...spec.data, resolved: {}, loading: {}, item: { id: 'item', resultRef: 'r', links: [{ key: 'l', linkRef: 'ref', invalid: true }] } }, setData(data) { Object.assign(this.data, data); } };
  for (const [key, value] of Object.entries(spec.methods)) card[key] = value.bind(card);
  spec.lifetimes.attached.call(card);
  try {
    const event = { currentTarget: { dataset: { key: 'l' } } };
    await card.onOpen(event); await card.onCopy(event);
    assert.deepEqual(opened, ['/pages/link/index', 'https://example.test/share']);
    assert.deepEqual(copied, ['https://example.test/share\n提取码：own1']);
    assert.equal(resolves.length, 2);
    assert.notEqual(resolves[0].key, resolves[1].key);
    assert.equal(resolves[0].resume, false); assert.equal(resolves[1].resume, false);
    assert.equal(card.data.copiedKey, 'l');
  } finally {
    spec.lifetimes.detached.call(card);
    links.resolveLink = originalResolve; clipboard.copyLink = originalCopy;
    delete global.Component; delete wx.navigateTo;
  }
});

test('a failed link shows a modal and prevents both actions from being executed', async () => {
  const feedback = require('../utils/feedback');
  const originalResolve = links.resolveLink, originalModal = feedback.showModal;
  let calls = 0; const notices = [];
  links.resolveLink = async () => { calls++; return { status: 'unavailable', validity: 0 }; };
  feedback.showModal = options => notices.push(options.content);
  let spec; global.Component = value => { spec = value; };
  delete require.cache[require.resolve('../components/resource-card/index')];
  require('../components/resource-card/index');
  const card = { data: { ...spec.data, resolved: {}, loading: {}, item: { id: 'item', resultRef: 'r', links: [{ key: 'l', linkRef: 'ref' }] } }, setData(data) { Object.assign(this.data, data); } };
  for (const [key, value] of Object.entries(spec.methods)) card[key] = value.bind(card);
  spec.lifetimes.attached.call(card);
  try {
    const event = { currentTarget: { dataset: { key: 'l' } } };
    await card.onCopy(event); await card.onOpen(event);
    assert.equal(calls, 2, 'a later click can retry; historical invalidity must not block an owned share');
    assert.ok(notices.every(value => value === '原分享链接已失效'));
    assert.equal(card.data.resolved.l.status, 'unavailable');
  } finally {
    spec.lifetimes.detached.call(card);
    links.resolveLink = originalResolve; feedback.showModal = originalModal;
    delete global.Component;
  }
});

test('lost response polls exactly the original key without another POST', async () => {
  stored = { token: 'session' };
  const original = auth.request;
  const paths = [];
  auth.request = async (path, options) => {
    paths.push([path, options?.method || 'GET']);
    if (options?.method === 'POST') throw Object.assign(new Error('lost'), { statusCode: 0 });
    return { statusCode: 200, data: { data: { status: 'unavailable', validity: 0 } } };
  };
  try {
    const result = await links.resolveLink('result', 'link', 'stable-key', {}, false);
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(paths, [['/api/links/resolve', 'POST'], ['/api/links/resolve-operations/stable-key', 'GET']]);
    assert.equal(result.url, undefined);
  } finally { auth.request = original; }
});

test('hiding a page stops polling, never repeats the write', async () => {
  stored = { token: 'session' };
  const original = auth.request;
  const control = {};
  let calls = 0;
  auth.request = async () => {
    calls++;
    setImmediate(() => links.stop(control));
    return { statusCode: 202, data: { data: { status: 'processing' } } };
  };
  try {
    assert.equal(await links.resolveLink('r', 'l', 'key', control, false), null);
    assert.equal(calls, 1);
  } finally { auth.request = original; }
});

test('slow operations keep stage feedback and poll the same key beyond 75 seconds', async () => {
  stored = { token: 'session' };
  const original = auth.request, nowBefore = Date.now;
  let now = nowBefore();
  Date.now = () => now;
  const stages = [], requests = [];
  auth.request = async (path, options) => {
    requests.push([path, options?.method || 'GET']);
    if (options?.method === 'POST') {
      now += 80000;
      return { statusCode: 202, data: { data: { status: 'processing', stage: 'sharing', pollAfterMs: 500 } } };
    }
    return { statusCode: 200, data: { data: { status: 'completed', url: 'https://example.test/share' } } };
  };
  try {
    const value = await links.resolveLink('r', 'l', 'stable', {}, false, progress => stages.push(progress.stage));
    assert.equal(value.status, 'completed');
    assert.deepEqual(stages, ['sharing']);
    assert.deepEqual(requests, [['/api/links/resolve', 'POST'], ['/api/links/resolve-operations/stable', 'GET']]);
  } finally { auth.request = original; Date.now = nowBefore; }
});

test('a changed session cannot resume a pending operation', async () => {
  stored = { token: 'old-session' };
  const original = auth.request;
  let calls = 0;
  auth.request = async () => {
    calls++; stored = { token: 'new-session' };
    throw Object.assign(new Error('lost'), { statusCode: 0 });
  };
  try {
    await assert.rejects(links.resolveLink('r', 'l', 'key', {}, false), /会话已变化/);
    assert.equal(calls, 1);
  } finally { auth.request = original; }
});

test('recycled cards discard late results and expired URLs', async () => {
  const original = links.resolveLink;
  let finish;
  links.resolveLink = () => new Promise(resolve => { finish = resolve; });
  let spec;
  global.Component = value => { spec = value; };
  delete require.cache[require.resolve('../components/resource-card/index')];
  require('../components/resource-card/index');
  const card = {
    data: { ...spec.data, item: { id: 'old', resultRef: 'r', links: [{ key: 'l', linkRef: 'ref' }] } },
    setData(data) { Object.assign(this.data, data); },
  };
  for (const [key, value] of Object.entries(spec.methods)) card[key] = value.bind(card);
  spec.lifetimes.attached.call(card);
  try {
    const pending = card.onCopy({ currentTarget: { dataset: { key: 'l' } } });
    card.stopQueries();
    card.data.item = { id: 'new', resultRef: 'new', links: [] };
    finish({ status: 'completed', url: 'https://example.test/share' });
    await pending;
    assert.deepEqual(card.data.resolved, {});
    assert.equal(card._expiryTimer, undefined);
    card.data.resolved = { expired: { url: 'https://example.test/share', deliveryExpiresAt: '2000-01-01' } };
    card._keys.expired = 'key';
    card.expireLinks();
    assert.deepEqual(card.data.resolved, {});
    assert.equal(card._keys.expired, undefined);
  } finally {
    spec.lifetimes.detached.call(card);
    links.resolveLink = original;
    delete global.Component;
  }
});

test('card progress follows actual stages and hiding clears timers and late updates', async () => {
  const original = links.resolveLink;
  let finish, notify;
  links.resolveLink = (_r, _l, _key, _control, _resume, onProgress) => {
    notify = onProgress;
    return new Promise(resolve => { finish = resolve; });
  };
  let spec; global.Component = value => { spec = value; };
  delete require.cache[require.resolve('../components/resource-card/index')];
  require('../components/resource-card/index');
  const card = { data: { ...spec.data, progress: {}, loading: {}, item: { id: 'item', resultRef: 'r', links: [{ key: 'l', linkRef: 'ref' }] } }, setData(data) { Object.assign(this.data, data); } };
  for (const [key, value] of Object.entries(spec.methods)) card[key] = value.bind(card);
  spec.lifetimes.attached.call(card);
  try {
    const pending = card.onOpen({ currentTarget: { dataset: { key: 'l' } } });
    assert.equal(card.data.progress.l.label, '排队中');
    notify({ stage: 'transferring' });
    assert.equal(card.data.progress.l.label, '正在转存');
    notify({ stage: 'sharing' });
    assert.equal(card.data.progress.l.label, '生成分享');
    spec.pageLifetimes.hide.call(card);
    assert.deepEqual(card.data.progress, {});
    assert.deepEqual(card.data.loading, {});
    notify({ stage: 'sharing' });
    assert.deepEqual(card.data.progress, {});
    finish(null);
    await pending;
  } finally {
    spec.lifetimes.detached.call(card);
    links.resolveLink = original;
    delete global.Component;
  }
});

test('anonymous search token does not bypass WeChat login', async () => {
  stored = { token: 'anonymous', user: null };
  const calls = [];
  wx.login = ({ success }) => { calls.push('wx.login'); success({ code: 'fresh-code' }); };
  wx.request = ({ url, method, data, header, success }) => {
    calls.push(new URL(url).pathname);
    assert.equal(method, 'POST');
    assert.equal(data.code, 'fresh-code');
    assert.equal(header.Authorization, undefined);
    success({ statusCode: 200, data: { token: 'user-token', user: { id: 7 } } });
  };
  try {
    assert.deepEqual(await auth.ensureLogin(), { id: 7 });
    assert.deepEqual(calls, ['wx.login', '/api/account/wechat/login']);
    assert.equal(auth.getSession().token, 'user-token');
    await auth.ensureLogin();
    assert.equal(calls.length, 2, 'authenticated sessions can be reused');
  } finally { delete wx.login; delete wx.request; stored = null; }
});

test('incomplete WeChat login cannot replace the anonymous token', async () => {
  stored = { token: 'anonymous', user: null };
  wx.login = ({ success }) => success({ code: 'code' });
  wx.request = ({ success }) => success({ statusCode: 200, data: { token: 'bad-token' } });
  try {
    await assert.rejects(auth.login(), /微信登录未完成/);
    assert.equal(auth.getSession().token, 'anonymous');
  } finally { delete wx.login; delete wx.request; stored = null; }
});

test('pause immediately notifies without request fail and ignores late stream events', async () => {
  const originalReady = auth.ensureSession;
  const originalRequest = wx.request;
  let chunk, success, aborted = 0, pauses = 0, updates = 0, completes = 0;
  auth.ensureSession = async () => {};
  wx.request = options => {
    success = options.success;
    return { abort() { aborted++; }, onChunkReceived(fn) { chunk = fn; } };
  };
  try {
    const { searchStream } = require('../utils/searchStream');
    const stream = searchStream({ keyword: 'test', onAbort() { pauses++; }, onUpdate() { updates++; }, onComplete() { completes++; } });
    await Promise.resolve();
    stream.abort();
    assert.equal(pauses, 1);
    assert.equal(aborted, 1);
    chunk({ data: new TextEncoder().encode('event: result\ndata: {"results":[{}]}\n\nevent: complete\ndata: {}\n\n').buffer });
    success({ statusCode: 200 });
    stream.abort();
    assert.equal(pauses, 1);
    assert.equal(updates, 0);
    assert.equal(completes, 0);
  } finally { auth.ensureSession = originalReady; wx.request = originalRequest; }
});
