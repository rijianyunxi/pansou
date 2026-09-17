import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createJiti } from 'jiti';
import { createApp, eventHandler, toNodeListener } from 'h3';

const directory = mkdtempSync(join(tmpdir(), 'panhub-qr-'));
process.env.PANHUB_SQLITE_DB = join(directory, 'qr.sqlite');

const jiti = createJiti(import.meta.url);
const qr = await jiti.import('../server/core/services/wechatQrLoginService.ts');
const { getSqliteDatabase } = await jiti.import('../server/core/storage/sqlite.ts');
const db = getSqliteDatabase();

const config = { appId: 'wx-qr-app', secret: 'qr-server-secret' };
const options = { qrPage: 'pages/login/index', envVersion: 'release' };
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const rejectsStatus = (code) => (error) => error.statusCode === code;
const countUsers = () => db.getRow('SELECT COUNT(*) AS count FROM users').count;

/**
 * Answers the three fixed WeChat hosts this flow may call, and records every
 * request so a test can assert what was sent (and how often).
 */
function stubWechat({ onCode, openid = 'qr-openid' } = {}) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    // The endpoint tests talk to a local HTTP server through the same global,
    // so anything that is not WeChat is passed straight through.
    if (url.hostname !== 'api.weixin.qq.com') return original(input, init);
    calls.push({ url, init });
    if (url.pathname === '/cgi-bin/token') {
      return Response.json({ access_token: `token-${calls.length}`, expires_in: 7200 });
    }
    if (url.pathname === '/wxa/getwxacodeunlimit') {
      return onCode ? onCode(calls.length) : new Response(PNG, { headers: { 'content-type': 'image/png' } });
    }
    if (url.pathname === '/sns/jscode2session') {
      return Response.json({ openid, session_key: 'never-persisted' });
    }
    throw new Error(`unexpected WeChat call: ${url.pathname}`);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('WeChat QR sign-in', async (t) => {
  await t.test('a ticket is only accepted in the shape the server issues', () => {
    const ticket = 'a1b2c3d4e5f60718293a4b5c';
    assert.equal(qr.normalizeLoginTicket(ticket), ticket);
    assert.equal(qr.normalizeLoginTicket(`  ${ticket.toUpperCase()}  `), ticket);
    for (const value of [null, undefined, 42, {}, '', 'short', 'z'.repeat(24), `${ticket}x`, `<script>`]) {
      assert.throws(() => qr.normalizeLoginTicket(value), rejectsStatus(400));
    }
  });

  await t.test('start refuses to run without credentials, then issues a pending ticket', async () => {
    await assert.rejects(qr.startWechatQrLogin({ appId: '', secret: '' }, options, '127.0.0.1'), rejectsStatus(503));
    await assert.rejects(qr.startWechatQrLogin({ appId: config.appId, secret: '' }, options, '127.0.0.1'), rejectsStatus(503));
    assert.equal(db.getRow('SELECT COUNT(*) AS count FROM login_tickets').count, 0);

    const stub = stubWechat();
    try {
      const login = await qr.startWechatQrLogin(config, options, '203.0.113.7');
      assert.match(login.ticket, /^[0-9a-f]{24}$/);
      assert.equal(login.qrImage, `data:image/png;base64,${PNG.toString('base64')}`);
      assert.ok(login.expiresAt > Date.now());
      assert.ok(!JSON.stringify(login).includes(config.secret));

      const row = qr.getLoginTicket(login.ticket);
      assert.equal(row.status, 'pending');
      assert.equal(row.user_id, null);
      assert.equal(row.ip, '203.0.113.7');
      assert.equal(row.confirmed_at, null);
      assert.equal(qr.getWechatQrLoginStatus(login.ticket), 'pending');

      // The code carries the ticket as its scene, and an unpublished page must
      // not make WeChat reject the request.
      const code = stub.calls.find((call) => call.url.pathname === '/wxa/getwxacodeunlimit');
      const body = JSON.parse(code.init.body);
      assert.deepEqual(body, { scene: login.ticket, page: options.qrPage, check_path: false, env_version: 'release', width: 280 });
      assert.equal(code.url.searchParams.get('access_token'), 'token-1');
      assert.equal(code.init.redirect, 'error');
    } finally { stub.restore(); }
  });

  await t.test('the access token is cached, and refreshed exactly once when WeChat rejects it', async () => {
    qr.resetWechatAccessTokenCache();
    const cached = stubWechat();
    try {
      await qr.startWechatQrLogin(config, options, '127.0.0.1');
      await qr.startWechatQrLogin(config, options, '127.0.0.1');
      assert.equal(cached.calls.filter((call) => call.url.pathname === '/cgi-bin/token').length, 1);
    } finally { cached.restore(); }

    qr.resetWechatAccessTokenCache();
    let codeAttempts = 0;
    const stale = stubWechat({
      onCode: () => (++codeAttempts === 1
        ? Response.json({ errcode: 40001, errmsg: 'invalid credential' })
        : new Response(PNG, { headers: { 'content-type': 'image/png' } })),
    });
    try {
      const login = await qr.startWechatQrLogin(config, options, '127.0.0.1');
      assert.equal(codeAttempts, 2);
      assert.equal(stale.calls.filter((call) => call.url.pathname === '/cgi-bin/token').length, 2);
      assert.ok(login.qrImage.startsWith('data:image/png;base64,'));
    } finally { stale.restore(); }

    // A code that cannot be generated must leave no ticket behind.
    qr.resetWechatAccessTokenCache();
    const broken = stubWechat({ onCode: () => Response.json({ errcode: 41030, errmsg: 'page not found' }) });
    const before = db.getRow('SELECT COUNT(*) AS count FROM login_tickets').count;
    try {
      await assert.rejects(qr.startWechatQrLogin(config, options, '127.0.0.1'), rejectsStatus(502));
      assert.equal(db.getRow('SELECT COUNT(*) AS count FROM login_tickets').count, before);
    } finally { broken.restore(); }
  });

  await t.test('confirmation provisions an account, and neither it nor the ticket can be replayed', async () => {
    const stub = stubWechat();
    try {
      const login = await qr.startWechatQrLogin(config, options, '198.51.100.9');
      const before = countUsers();
      const { user } = await qr.confirmWechatQrLogin(config, login.ticket, 'valid-code', '198.51.100.9');
      assert.equal(countUsers(), before + 1);
      assert.equal(user.role, 'user');
      assert.match(user.username, /^wx_[0-9a-f]{12}$/);
      assert.equal(user.last_login_ip, '198.51.100.9');

      const confirmed = qr.getLoginTicket(login.ticket);
      assert.equal(confirmed.status, 'confirmed');
      assert.equal(confirmed.user_id, user.id);
      assert.ok(confirmed.confirmed_at > 0);
      assert.equal(qr.getWechatQrLoginStatus(login.ticket), 'confirmed');

      // Scanning the same code twice must not sign in twice or provision twice.
      await assert.rejects(qr.confirmWechatQrLogin(config, login.ticket, 'valid-code', 'ip'), rejectsStatus(409));
      assert.equal(countUsers(), before + 1);

      // A confirmed ticket belongs to exactly one browser.
      assert.equal(qr.consumeWechatQrLogin(login.ticket), user.id);
      assert.equal(qr.consumeWechatQrLogin(login.ticket), undefined);
      assert.equal(qr.getLoginTicket(login.ticket).status, 'consumed');

      // A pending ticket is not a confirmation, and an unknown one is not either.
      const pending = await qr.startWechatQrLogin(config, options, 'ip');
      assert.equal(qr.consumeWechatQrLogin(pending.ticket), undefined);
      assert.equal(qr.consumeWechatQrLogin('0'.repeat(24)), undefined);
    } finally { stub.restore(); }
  });

  await t.test('expired and invalid tickets are refused without touching accounts', async () => {
    const stub = stubWechat();
    try {
      const login = await qr.startWechatQrLogin(config, options, 'ip');
      db.run('UPDATE login_tickets SET expires_at = 0 WHERE ticket = ?', login.ticket);
      assert.equal(qr.getWechatQrLoginStatus(login.ticket), 'expired');
      const before = countUsers();
      await assert.rejects(qr.confirmWechatQrLogin(config, login.ticket, 'valid-code', 'ip'), rejectsStatus(410));
      await assert.rejects(qr.confirmWechatQrLogin(config, 'f'.repeat(24), 'valid-code', 'ip'), rejectsStatus(410));
      assert.equal(countUsers(), before);
      // A ticket that lapses between confirmation and pickup is still dead.
      assert.equal(qr.consumeWechatQrLogin(login.ticket), undefined);
    } finally { stub.restore(); }
  });

  await t.test('a disabled account is refused and the code stays usable for nobody', async () => {
    const stub = stubWechat({ openid: 'qr-openid-disabled' });
    try {
      const login = await qr.startWechatQrLogin(config, options, 'ip');
      const first = await qr.confirmWechatQrLogin(config, login.ticket, 'valid-code', 'ip');
      db.run("UPDATE users SET status = 'disabled' WHERE id = ?", first.user.id);
      const disabled = await qr.startWechatQrLogin(config, options, 'ip');
      const before = countUsers();
      await assert.rejects(qr.confirmWechatQrLogin(config, disabled.ticket, 'valid-code', 'ip'), rejectsStatus(403));
      assert.equal(countUsers(), before);
      // The refusal happens before the write, so the ticket was never claimed.
      assert.equal(qr.getLoginTicket(disabled.ticket).status, 'pending');
    } finally { stub.restore(); }
  });

  await t.test('starting a new code prunes the ones that already lapsed', async () => {
    const stub = stubWechat();
    try {
      const old = await qr.startWechatQrLogin(config, options, 'ip', Date.now() - 10 * 60 * 1000);
      assert.ok(qr.getLoginTicket(old.ticket));
      const fresh = await qr.startWechatQrLogin(config, options, 'ip');
      assert.equal(qr.getLoginTicket(old.ticket), undefined);
      assert.ok(qr.getLoginTicket(fresh.ticket));
    } finally { stub.restore(); }
  });

  await t.test('poll hands a confirmation to one browser and sets a cookie session', async () => {
    const pollModule = await jiti.import('../server/api/account/wechat/qr/poll.get.ts');
    const pollHandler = pollModule.default ?? pollModule;
    const stub = stubWechat({ openid: 'qr-openid-poll' });
    const app = createApp();
    app.use('/poll', eventHandler((event) => pollHandler(event)));
    const server = createServer(toNodeListener(app));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const poll = (ticket) => fetch(`${base}/poll?ticket=${ticket}`);
    try {
      const login = await qr.startWechatQrLogin(config, options, '203.0.113.9');
      // Watching a code that nobody scanned answers `pending`, not an error.
      const pending = await poll(login.ticket);
      assert.equal(pending.status, 200);
      assert.equal((await pending.json()).status, 'pending');
      // An unknown ticket is deliberately indistinguishable from a lapsed one.
      assert.equal((await (await poll('a'.repeat(24))).json()).status, 'expired');
      assert.equal((await (await poll('not-a-ticket')).status), 400);

      const { user } = await qr.confirmWechatQrLogin(config, login.ticket, 'valid-code', '203.0.113.9');
      const first = await poll(login.ticket);
      assert.equal(first.status, 200);
      assert.equal(first.headers.get('cache-control'), 'private, no-store');
      const cookie = first.headers.get('set-cookie');
      assert.match(cookie, /^panhub_session=[A-Za-z0-9_-]{43};/);
      assert.ok(cookie.includes('HttpOnly'));
      const body = await first.json();
      assert.equal(body.status, 'confirmed');
      assert.equal(body.user.id, user.id);
      assert.ok(!JSON.stringify(body).includes('password'));

      const session = db.getRow('SELECT * FROM sessions WHERE user_id = ? ORDER BY id DESC LIMIT 1', user.id);
      assert.equal(session.kind, 'user');
      assert.equal(session.transport, 'cookie');

      // The code is spent: a second browser polling it gets no account and no
      // session at all, so a leaked ticket is worth nothing after one use.
      const second = await poll(login.ticket);
      const replay = await second.json();
      assert.equal(replay.user, null);
      assert.equal(second.headers.get('set-cookie'), null);
      assert.equal(db.getRow('SELECT COUNT(*) AS count FROM sessions WHERE kind = ?', 'user').count, 1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      stub.restore();
    }
  });
});

test.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
