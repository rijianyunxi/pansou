const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../utils/auth');
const links = require('../utils/linkResolution');
let stored;
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
