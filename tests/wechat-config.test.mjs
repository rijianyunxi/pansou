import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createJiti } from 'jiti';
import { createApp, eventHandler, toNodeListener } from 'h3';

const directory = mkdtempSync(join(tmpdir(), 'panhub-wechat-config-'));
process.env.PANHUB_SQLITE_DB = join(directory, 'config.sqlite');
process.env.PANHUB_ADMIN_INITIAL_PASSWORD = 'test-admin-password';

const jiti = createJiti(import.meta.url);
const config = await jiti.import('../server/core/services/wechatConfigService.ts');
const auth = await jiti.import('../server/utils/userAuth.ts');
const { getSqliteDatabase } = await jiti.import('../server/core/storage/sqlite.ts');
const db = getSqliteDatabase();

const APP_ID = 'wx9f2a4c6e8b0d1357';
const SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const rejectsStatus = (code) => (error) => error.statusCode === code;

/** Intercepts the fixed WeChat host only; anything else uses the real fetch. */
function stubWechat() {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname !== 'api.weixin.qq.com') return original(input, init);
    calls.push({ url, init });
    if (url.pathname === '/cgi-bin/token') return Response.json({ access_token: 'token-1', expires_in: 7200 });
    if (url.pathname === '/wxa/getwxacodeunlimit') return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    throw new Error(`unexpected WeChat call: ${url.pathname}`);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

async function withServer(routes, run) {
  const app = createApp();
  for (const [path, handler] of Object.entries(routes)) app.use(path, eventHandler((event) => handler(event)));
  const server = createServer(toNodeListener(app));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('WeChat settings are stored in the database, not in runtime config', async (t) => {
  await t.test('an empty database reports an unconfigured default', () => {
    assert.deepEqual(config.getWechatMiniSettings(), {
      appId: '', secret: '', qrPage: 'pages/login/index', envVersion: 'release',
    });
    const view = config.wechatMiniSettingsView(config.getWechatMiniSettings());
    assert.equal(view.configured, false);
    assert.equal(view.secretConfigured, false);
    assert.equal(view.secretLength, 0);
  });

  await t.test('saving persists every field, and the view never carries the secret', () => {
    const saved = config.saveWechatMiniSettings({ appId: APP_ID, secret: SECRET, qrPage: '/pages/login/index', envVersion: 'trial' });
    assert.deepEqual(saved, { appId: APP_ID, secret: SECRET, qrPage: 'pages/login/index', envVersion: 'trial' });
    assert.deepEqual(config.getWechatMiniSettings(), saved);

    const view = config.wechatMiniSettingsView(config.getWechatMiniSettings());
    assert.deepEqual(
      Object.keys(view).sort(),
      ['appId', 'configured', 'envVersion', 'qrPage', 'secretConfigured', 'secretLength'],
    );
    assert.equal(view.secretConfigured, true);
    assert.equal(view.secretLength, SECRET.length);
    assert.equal(view.configured, true);
    // Not the value, and not a prefix or suffix of it either — a masked fragment
    // still narrows a guess, and the console has no use for one.
    const payload = JSON.stringify(view);
    assert.ok(!payload.includes(SECRET));
    assert.ok(!payload.includes(SECRET.slice(0, 4)));
    assert.ok(!payload.includes(SECRET.slice(-4)));
  });

  await t.test('a blank secret keeps the stored one; null clears it', () => {
    config.saveWechatMiniSettings({ appId: APP_ID, secret: SECRET, envVersion: 'release' });
    assert.equal(config.saveWechatMiniSettings({ appId: APP_ID }).secret, SECRET);
    assert.equal(config.saveWechatMiniSettings({ secret: '' }).secret, SECRET);
    assert.equal(config.saveWechatMiniSettings({ secret: '   ' }).secret, SECRET);
    assert.equal(config.getWechatMiniSettings().secret, SECRET);

    assert.equal(config.saveWechatMiniSettings({ secret: null }).secret, '');
    assert.equal(config.getWechatMiniSettings().secret, '');
    // A cleared secret is reported as unconfigured rather than silently working.
    assert.equal(config.wechatMiniSettingsView(config.getWechatMiniSettings()).configured, false);
  });

  await t.test('clearing the AppID switches sign-in off but keeps the secret', () => {
    config.saveWechatMiniSettings({ appId: APP_ID, secret: SECRET, qrPage: 'pages/login/index', envVersion: 'release' });
    const cleared = config.saveWechatMiniSettings({ appId: '' });
    assert.equal(cleared.appId, '');
    assert.equal(cleared.secret, SECRET);
    assert.equal(config.wechatMiniSettingsView(cleared).configured, false);
  });

  await t.test('invalid values are refused instead of silently kept', () => {
    const baseline = config.saveWechatMiniSettings({ appId: APP_ID, secret: SECRET, qrPage: 'pages/login/index', envVersion: 'release' });
    for (const appId of ['wx', 'has space', '中文appid', 'x'.repeat(65), 42, {}]) {
      assert.throws(() => config.saveWechatMiniSettings({ appId }), rejectsStatus(400));
    }
    for (const secret of ['short', 'has space', 'x'.repeat(129), 42]) {
      assert.throws(() => config.saveWechatMiniSettings({ secret }), rejectsStatus(400));
    }
    assert.throws(() => config.saveWechatMiniSettings({ qrPage: 'bad page!' }), rejectsStatus(400));
    assert.throws(() => config.saveWechatMiniSettings({ envVersion: 'prod' }), rejectsStatus(400));
    // A refused write must leave the stored row exactly as it was.
    assert.deepEqual(config.getWechatMiniSettings(), baseline);
  });

  await t.test('qrPage and envVersion are normalized on both paths', () => {
    assert.equal(config.normalizeQrPage('//pages/login/index'), 'pages/login/index');
    assert.equal(config.normalizeQrPage('  pages/login/index  '), 'pages/login/index');
    assert.equal(config.normalizeQrPage(''), 'pages/login/index');
    assert.equal(config.normalizeQrPage('has space'), 'pages/login/index');
    assert.equal(config.validateQrPage(''), 'pages/login/index');
    assert.equal(config.normalizeEnvVersion('trial'), 'trial');
    assert.equal(config.normalizeEnvVersion('production'), 'release');
    assert.equal(config.normalizeEnvVersion(undefined), 'release');
    assert.equal(config.saveWechatMiniSettings({ qrPage: '/pages/login/index' }).qrPage, 'pages/login/index');
  });

  await t.test('a value an older build wrote degrades instead of breaking the read path', () => {
    db.run(
      'UPDATE wechat_mini_settings SET app_id=?,secret=?,qr_page=?,env_version=? WHERE id=1',
      'not an appid', 'x', 'no space here', 'production',
    );
    assert.deepEqual(config.getWechatMiniSettings(), {
      appId: '', secret: '', qrPage: 'pages/login/index', envVersion: 'release',
    });
  });
});

test('the sign-in endpoint reads the settings row', async () => {
  const startModule = await jiti.import('../server/api/account/wechat/qr/start.post.ts');
  const startHandler = startModule.default ?? startModule;
  const stub = stubWechat();
  try {
    await withServer({ '/start': startHandler }, async (base) => {
      const start = () => fetch(`${base}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

      config.saveWechatMiniSettings({ appId: '', secret: null, qrPage: 'pages/login/index', envVersion: 'release' });
      assert.equal((await start()).status, 503);

      // Configured through the service alone: no restart, no environment variable.
      config.saveWechatMiniSettings({ appId: APP_ID, secret: SECRET, qrPage: '/pages/login/index', envVersion: 'trial' });
      const response = await start();
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.match(body.ticket, /^[0-9a-f]{24}$/);
      assert.ok(body.qrImage.startsWith('data:image/png;base64,'));
      assert.ok(!JSON.stringify(body).includes(SECRET));

      // The WeChat calls must use the stored row — that is the proof this path
      // reads SQLite rather than any process-level configuration.
      const token = stub.calls.find((call) => call.url.pathname === '/cgi-bin/token');
      assert.equal(token.url.searchParams.get('appid'), APP_ID);
      assert.equal(token.url.searchParams.get('secret'), SECRET);
      const code = stub.calls.find((call) => call.url.pathname === '/wxa/getwxacodeunlimit');
      const payload = JSON.parse(code.init.body);
      assert.equal(payload.page, 'pages/login/index');
      assert.equal(payload.env_version, 'trial');
      assert.equal(payload.scene, body.ticket);
    });
  } finally { stub.restore(); }
});

test('the console endpoints expose the settings without the secret', async () => {
  const getModule = await jiti.import('../server/api/settings/wechat.get.ts');
  const putModule = await jiti.import('../server/api/settings/wechat.put.ts');
  const getHandler = getModule.default ?? getModule;
  const putHandler = putModule.default ?? putModule;
  const admin = db.getRow("SELECT * FROM users WHERE role = 'admin'");
  const issueToken = (event) => ({ token: auth.createMiniProgramSession(event, admin).token });

  await withServer({ '/get-wechat': getHandler, '/put-wechat': putHandler, '/token': issueToken }, async (base) => {
    assert.equal((await fetch(`${base}/get-wechat`)).status, 401);
    const token = (await (await fetch(`${base}/token`)).json()).token;
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const put = (body) => fetch(`${base}/put-wechat`, { method: 'PUT', headers, body: JSON.stringify(body) });

    config.saveWechatMiniSettings({ appId: APP_ID, secret: SECRET, qrPage: 'pages/login/index', envVersion: 'release' });
    const read = await fetch(`${base}/get-wechat`, { headers });
    assert.equal(read.status, 200);
    const readBody = await read.json();
    assert.equal(readBody.code, 0);
    assert.equal(readBody.data.appId, APP_ID);
    assert.equal(readBody.data.secretConfigured, true);
    assert.ok(!JSON.stringify(readBody).includes(SECRET));

    // A blank field from the console keeps the stored secret.
    const kept = await (await put({ appId: APP_ID, secret: '', qrPage: 'pages/login/index', envVersion: 'develop' })).json();
    assert.equal(kept.data.envVersion, 'develop');
    assert.equal(kept.data.secretConfigured, true);
    assert.equal(config.getWechatMiniSettings().secret, SECRET);

    // A rejected field reports 400 and changes nothing.
    const bad = await put({ appId: 'has space' });
    assert.equal(bad.status, 400);
    assert.ok((await bad.json()).statusMessage.includes('AppID'));
    assert.equal(config.getWechatMiniSettings().envVersion, 'develop');
  });
});

test('a database older than the code degrades instead of returning 500', async (t) => {
  // The table is created by SCHEMA on every start, but a process can outlive the
  // code that added it — and in this project the dev server holds the production
  // database open. Read must answer "not configured"; write must say why.
  const DDL = "CREATE TABLE wechat_mini_settings(id INTEGER PRIMARY KEY CHECK(id=1),app_id TEXT NOT NULL DEFAULT '',secret TEXT NOT NULL DEFAULT '',qr_page TEXT NOT NULL DEFAULT 'pages/login/index',env_version TEXT NOT NULL DEFAULT 'release',updated_at INTEGER NOT NULL)";
  db.run('DROP TABLE wechat_mini_settings');
  try {
    assert.deepEqual(config.getWechatMiniSettings(), {
      appId: '', secret: '', qrPage: 'pages/login/index', envVersion: 'release',
    });
    const view = config.wechatMiniSettingsView(config.getWechatMiniSettings());
    assert.equal(view.configured, false);
    assert.equal(view.secretConfigured, false);

    // A raw SqliteError would read like a bug in the form; the message must point
    // at the actual remedy.
    assert.throws(
      () => config.saveWechatMiniSettings({ appId: APP_ID, secret: SECRET }),
      (error) => error.statusCode === 503 && /重启服务/.test(error.statusMessage),
    );
  } finally {
    db.run(DDL);
  }

  // With the table back, everything works again — no sticky failure.
  const restored = config.saveWechatMiniSettings({ appId: APP_ID, secret: SECRET });
  assert.equal(config.wechatMiniSettingsView(restored).configured, true);
});

test.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
