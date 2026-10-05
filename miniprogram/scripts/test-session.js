const test = require('node:test');
const assert = require('node:assert/strict');

const flags = { showHotSearch: false, anonymousCustomChannels: false, homeSearchPlaceholder: '搜索资源' };
const loginData = (config = flags) => ({ token: 'user-token', expiresAt: Date.now() + 3600000, user: { id: 7 }, ...config });
const flush = () => new Promise(resolve => setImmediate(resolve));

function setup(t, { session, loginFails = false, respond } = {}) {
  const originals = { wx: global.wx, App: global.App, Page: global.Page };
  const calls = [];
  const storage = new Map(session ? [['panhub-auth', session]] : []);
  global.wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    login: options => {
      calls.push('wx.login');
      if (loginFails) options.fail();
      else options.success({ code: 'code' });
    },
    request: options => {
      const path = new URL(options.url).pathname;
      calls.push(path);
      respond(path, options);
    },
    setNavigationBarColor() {},
    setBackgroundColor() {},
  };
  for (const file of ['../utils/auth', '../utils/api', '../app', '../pages/index/index']) {
    delete require.cache[require.resolve(file)];
  }
  const auth = require('../utils/auth');
  const api = require('../utils/api');
  let app, definition;
  global.App = value => { app = value; };
  global.Page = value => { definition = value; };
  require('../app');
  require('../pages/index/index');
  const page = { ...definition, data: { ...definition.data }, setData(value) { Object.assign(this.data, value); } };
  t.after(() => {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete global[key];
      else global[key] = value;
    }
  });
  return { auth, api, app, page, calls };
}

function succeed(options, data) { options.success({ statusCode: 200, data }); }

test('launch, homepage and search share login and never fetch hot searches when disabled', async t => {
  let loginRequest;
  const { app, page, api, auth, calls } = setup(t, {
    respond(path, options) {
      assert.equal(path, '/api/account/wechat/login');
      assert.equal(options.header.Authorization, undefined);
      loginRequest = options;
    },
  });
  assert.equal(page.data.showHotSearch, false);
  const launch = app.onLaunch();
  const homepage = page.loadSessionFlags();
  const search = auth.ensureSession();
  const hotSearches = api.fetchHotSearches();
  await flush();
  assert.deepEqual(calls, ['wx.login', '/api/account/wechat/login']);
  assert.equal(page.data.showHotSearch, false);
  succeed(loginRequest, loginData());
  await Promise.all([launch, homepage, search]);
  assert.deepEqual(await hotSearches, []);
  assert.equal(app.globalData.sessionReady, true);
  assert.equal(app.globalData.session.authenticated, true);
  assert.equal(page.data.homeSearchPlaceholder, flags.homeSearchPlaceholder);
  assert.deepEqual(calls, ['wx.login', '/api/account/wechat/login']);
});

test('enabled hot searches wait for login configuration and use the requested limit', async t => {
  let loginRequest;
  const { app, page, calls } = setup(t, {
    respond(path, options) {
      if (path === '/api/account/wechat/login') { loginRequest = options; return; }
      assert.equal(path, '/api/hot-searches');
      assert.equal(new URL(options.url).searchParams.get('limit'), '10');
      succeed(options, { code: 0, data: { hotSearches: [{ term: '电影' }] } });
    },
  });
  const launch = app.onLaunch();
  const homepage = page.loadSessionFlags();
  await flush();
  assert.equal(calls.includes('/api/hot-searches'), false);
  succeed(loginRequest, loginData({ ...flags, showHotSearch: true }));
  await Promise.all([launch, homepage]);
  assert.deepEqual(calls, ['wx.login', '/api/account/wechat/login', '/api/hot-searches']);
  assert.deepEqual(page.data.hotSearches, [{ term: '电影', rank: 1 }]);
});

test('cached login reads deployed session flags with Bearer and shares the in-flight request', async t => {
  let configRequest;
  const { app, page, calls } = setup(t, {
    session: loginData(),
    respond(path, options) {
      assert.equal(path, '/api/account/session');
      assert.equal(options.header.Authorization, 'Bearer user-token');
      configRequest = options;
    },
  });
  const launch = app.onLaunch();
  const homepage = page.loadSessionFlags();
  await flush();
  assert.deepEqual(calls, ['/api/account/session']);
  succeed(configRequest, flags);
  await Promise.all([launch, homepage]);
  assert.deepEqual(calls, ['/api/account/session']);
});

for (const failure of ['network', 'missing flag']) {
  test(`configuration ${failure} keeps hot searches hidden and permits a later retry`, async t => {
    let attempts = 0;
    const { page, api, calls } = setup(t, {
      session: loginData(),
      respond(path, options) {
        assert.equal(path, '/api/account/session');
        attempts++;
        if (attempts > 1) succeed(options, flags);
        else if (failure === 'network') options.fail();
        else succeed(options, {});
      },
    });
    page.data.hotSearches = [{ term: '旧热搜' }];
    await page.loadSessionFlags();
    assert.equal(page.data.showHotSearch, false);
    assert.deepEqual(page.data.hotSearches, []);
    assert.equal(calls.includes('/api/hot-searches'), false);
    await api.fetchSession();
    assert.deepEqual(calls, ['/api/account/session', '/api/account/session']);
  });
}

test('login failure shares one anonymous fallback and respects its configuration', async t => {
  let sessionRequest;
  const { app, page, calls } = setup(t, {
    loginFails: true,
    respond(path, options) {
      assert.equal(path, '/api/account/session');
      sessionRequest = options;
    },
  });
  const launch = app.onLaunch();
  const homepage = page.loadSessionFlags();
  await flush();
  assert.deepEqual(calls, ['wx.login', '/api/account/session']);
  succeed(sessionRequest, { authenticated: false, sessionId: 'anonymous', ...flags });
  await Promise.all([launch, homepage]);
  assert.equal(app.globalData.session.authenticated, false);
  assert.deepEqual(calls, ['wx.login', '/api/account/session']);
});

test('logout remains anonymous; manual login updates user without a stale session cache', async t => {
  const { auth, api, calls } = setup(t, {
    respond(path, options) {
      if (path === '/api/account/wechat/login') return succeed(options, loginData());
      if (path === '/api/account/logout') return succeed(options, { ok: true });
      assert.equal(path, '/api/account/session');
      succeed(options, { authenticated: false, sessionId: 'anonymous', ...flags });
    },
  });
  assert.equal((await api.fetchSession()).authenticated, true);
  await auth.logout();
  assert.equal((await api.fetchSession()).authenticated, false);
  assert.equal(calls.filter(path => path === 'wx.login').length, 1);
  await auth.login();
  assert.equal((await api.fetchSession()).authenticated, true);
  assert.deepEqual((await api.fetchSession()).user, { id: 7 });
  assert.equal(calls.filter(path => path === '/api/account/session').length, 1);
});

test('a cached anonymous token retries login once on launch and reuses the token if login fails', async t => {
  const { api, calls } = setup(t, {
    session: { token: 'old-anonymous', user: null },
    loginFails: true,
    respond(path, options) {
      assert.equal(path, '/api/account/session');
      succeed(options, flags);
    },
  });
  const sessions = await Promise.all([api.fetchSession(), api.fetchSession()]);
  assert.ok(sessions.every(session => !session.authenticated));
  await api.fetchSession();
  assert.deepEqual(calls, ['wx.login', '/api/account/session']);
});

test('expired config is refreshed before hot searches; cached true cannot bypass a failed refresh', async t => {
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; });
  let configAttempts = 0;
  const { api, calls } = setup(t, {
    respond(path, options) {
      if (path === '/api/account/wechat/login') return succeed(options, loginData({ ...flags, showHotSearch: true }));
      assert.equal(path, '/api/account/session');
      if (++configAttempts === 1) options.fail();
      else succeed(options, flags);
    },
  });
  await api.fetchSession();
  now += 60001;
  await assert.rejects(api.fetchHotSearches(), /网络请求失败/);
  assert.deepEqual(await api.fetchHotSearches(), []);
  assert.equal(calls.includes('/api/hot-searches'), false);
});

test('deployed login response without flags reads session once before deciding about hot searches', async t => {
  let sessionRequest;
  const { app, page, api, calls } = setup(t, {
    respond(path, options) {
      if (path === '/api/account/wechat/login') return succeed(options, loginData({}));
      assert.equal(path, '/api/account/session');
      assert.equal(options.header.Authorization, 'Bearer user-token');
      sessionRequest = options;
    },
  });
  const launch = app.onLaunch();
  const homepage = page.loadSessionFlags();
  const hot = api.fetchHotSearches();
  await flush();
  assert.deepEqual(calls, ['wx.login', '/api/account/wechat/login', '/api/account/session']);
  assert.equal(page.data.showHotSearch, false);
  succeed(sessionRequest, { ...flags, authenticated: true, sessionId: 'user-token', user: { id: 7 } });
  await Promise.all([launch, homepage]);
  assert.deepEqual(await hot, []);
  assert.equal(app.globalData.session.authenticated, true);
  assert.deepEqual(calls, ['wx.login', '/api/account/wechat/login', '/api/account/session']);
});

test('server-side revoked sessions replace a locally unexpired token and clear account state', async t => {
  const { api, auth } = setup(t, {
    session: loginData(),
    respond(path, options) {
      assert.equal(path, '/api/account/session');
      succeed(options, { ...flags, authenticated: false, user: null, sessionId: 'new-anonymous' });
    },
  });
  const session = await api.fetchSession();
  assert.equal(session.authenticated, false);
  assert.equal(session.user, null);
  assert.equal(auth.getSession().token, 'new-anonymous');
});

test('late session responses cannot overwrite a manual login', async t => {
  let sessionRequest;
  const { api, auth } = setup(t, {
    session: loginData(),
    respond(path, options) {
      if (path === '/api/account/session') { sessionRequest = options; return; }
      assert.equal(path, '/api/account/wechat/login');
      succeed(options, { ...loginData(), token: 'fresh-user-token' });
    },
  });
  const pending = api.fetchSession();
  await flush();
  await auth.login();
  succeed(sessionRequest, { ...flags, authenticated: false, sessionId: 'old-anonymous' });
  assert.equal((await pending).authenticated, true);
  assert.equal(auth.getSession().token, 'fresh-user-token');
});

test('concurrent 401 recovery logs in once; a late old-token 401 preserves the fresh token', async t => {
  const oldRequests = [];
  const { api, auth, calls } = setup(t, {
    session: loginData(),
    respond(path, options) {
      if (path === '/api/account/wechat/login') return succeed(options, { ...loginData(), token: 'fresh-token' });
      assert.equal(path, '/api/account/channels');
      if (options.header.Authorization === 'Bearer user-token') oldRequests.push(options);
      else {
        assert.equal(options.header.Authorization, 'Bearer fresh-token');
        succeed(options, { channels: ['movies'], limit: 50 });
      }
    },
  });
  const first = api.fetchChannels();
  const second = api.fetchChannels();
  await flush();
  assert.equal(oldRequests.length, 2);
  oldRequests[0].success({ statusCode: 401, data: {} });
  await first;
  oldRequests[1].success({ statusCode: 401, data: {} });
  assert.deepEqual((await second).channels, ['movies']);
  assert.equal(auth.getSession().token, 'fresh-token');
  assert.equal(calls.filter(path => path === 'wx.login').length, 1);
});

test('channel requests recover an expired anonymous token even when wx.login is unavailable', async t => {
  const { api } = setup(t, {
    session: { token: 'old-anonymous', user: null },
    loginFails: true,
    respond(path, options) {
      if (path === '/api/account/session') return succeed(options, { ...flags, authenticated: false, sessionId: 'fresh-anonymous' });
      assert.equal(path, '/api/account/channels');
      if (options.header.Authorization === 'Bearer old-anonymous') options.success({ statusCode: 401, data: {} });
      else {
        assert.equal(options.header.Authorization, 'Bearer fresh-anonymous');
        succeed(options, { channels: [], limit: 50 });
      }
    },
  });
  assert.deepEqual((await api.fetchChannels()).channels, []);
});

test('homepage lifecycle merges flag loading and clears channels after logout', async t => {
  let loginRequest;
  const { page, calls } = setup(t, {
    loginFails: true,
    respond(path, options) {
      assert.equal(path, '/api/account/session');
      loginRequest = options;
    },
  });
  page._userChannels = ['old-account-channel'];
  page.data.channelsCount = 1;
  page.data.scope = 'channels';
  page.onLoad({});
  const pending = page._flagsPromise;
  page.onShow();
  assert.equal(page._flagsPromise, pending);
  await flush();
  succeed(loginRequest, { ...flags, authenticated: false, sessionId: 'anonymous' });
  await pending;
  await flush();
  assert.deepEqual(page._userChannels, []);
  assert.equal(page.data.channelsCount, 0);
  assert.equal(page.data.scope, 'site');
  assert.deepEqual(calls, ['wx.login', '/api/account/session']);
});

test('re-scanning a new website QR ticket resets the previous confirmation', t => {
  setup(t, { respond() {} });
  let definition;
  global.Page = value => { definition = value; };
  delete require.cache[require.resolve('../pages/login/index')];
  require('../pages/login/index');
  const page = { ...definition, data: { ...definition.data }, setData(value) { Object.assign(this.data, value); } };
  page.data.scene = 'a'.repeat(24);
  page.data.confirmed = true;
  page.data.error = '旧二维码已过期';
  wx.getEnterOptionsSync = () => ({ query: { scene: 'b'.repeat(24) } });
  page.onShow();
  assert.equal(page.data.scene, 'b'.repeat(24));
  assert.equal(page.data.confirmed, false);
  assert.equal(page.data.error, '');
});
