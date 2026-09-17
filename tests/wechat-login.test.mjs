import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createJiti } from 'jiti';
import { createApp, eventHandler, toNodeListener } from 'h3';

const directory = mkdtempSync(join(tmpdir(), 'panhub-wechat-'));
process.env.PANHUB_SQLITE_DB = join(directory, 'test.sqlite');
// The initial administrator password is random unless this is set, and the
// throttle test needs a known correct password to sign in with.
const ADMIN_PASSWORD = 'test-admin-password';
process.env.PANHUB_ADMIN_INITIAL_PASSWORD = ADMIN_PASSWORD;
const jiti = createJiti(import.meta.url);
const service = await jiti.import('../server/core/services/wechatMiniService.ts');
const auth = await jiti.import('../server/utils/userAuth.ts');
const { getSqliteDatabase, SqliteDatabase } = await jiti.import('../server/core/storage/sqlite.ts');
const db = getSqliteDatabase();
const config = { appId: 'wx-test-app', secret: 'server-secret' };
const identity = { openid: 'openid-one' };
const rejectsStatus = (code) => (error) => error.statusCode === code;

test('WeChat login integration', async (t) => {
  await t.test('code validation rejects spoofed or oversized bodies', () => {
    for (const code of [null, {}, '', 'x'.repeat(257), 'code?secret=foo']) assert.throws(() => service.validateWechatCode(code), rejectsStatus(400));
    assert.equal(service.validateWechatCode('valid_code-123'), 'valid_code-123');
  });
  await t.test('server exchange uses fixed endpoint; strips session_key', async () => {
    const result = await service.exchangeWechatCode(config, 'test-code', async (url, options) => {
      assert.equal(url.origin, 'https://api.weixin.qq.com');
      assert.equal(url.searchParams.get('secret'), config.secret);
      assert.equal(url.searchParams.get('grant_type'), 'authorization_code');
      assert.equal(options.redirect, 'error');
      return Response.json({ openid: 'verified-openid', session_key: 'secret-session-key', unionid: 'union-one' });
    });
    assert.deepEqual(result, { openid: 'verified-openid', unionId: 'union-one' });
    assert.ok(!JSON.stringify(result).includes('secret-session-key'));
  });
  await t.test('source errors, timeout and incomplete responses fail closed', async () => {
    for (const [errcode, status] of [[40029,401], [40163,401], [40226,403], [45011,429], [-1,503], [40013,502]]) {
      await assert.rejects(service.exchangeWechatCode(config, 'code', async () => Response.json({ errcode, errmsg: 'sensitive' })), rejectsStatus(status));
    }
    await assert.rejects(service.exchangeWechatCode(config, 'code', async () => { throw new Error(config.secret); }), e => e.statusCode === 502 && !e.message.includes(config.secret));
    await assert.rejects(service.exchangeWechatCode(config, 'code', async () => Response.json({ openid: 'one' })), rejectsStatus(502));
    await assert.rejects(service.exchangeWechatCode({ ...config, secret: '' }, 'code'), rejectsStatus(503));
  });
  await t.test('an unlinked identity is rejected unless provisioning is allowed', () => {
    assert.throws(() => service.resolveWechatUser(config, identity, '127.0.0.1'), rejectsStatus(403));
    assert.throws(() => service.resolveWechatUser(config, identity, '127.0.0.1', { autoProvision: false }), rejectsStatus(403));
    const user = service.resolveWechatUser(config, identity, '127.0.0.1', { autoProvision: true });
    assert.equal(user.role, 'user');
    // Once the identity is linked it resolves on its own, with provisioning off.
    assert.equal(service.resolveWechatUser(config, identity, '127.0.0.1').id, user.id);
    assert.equal(service.resolveWechatUser(config, identity, '127.0.0.1', { autoProvision: false }).id, user.id);
    // Links are scoped to one AppID, so another app sees an unknown identity.
    assert.throws(() => service.resolveWechatUser({ ...config, appId: 'other-app' }, identity, '127.0.0.1'), rejectsStatus(403));
  });
  await t.test('first login provisions an account with an unusable password', () => {
    const before = db.getRow('SELECT COUNT(*) AS count FROM users').count;
    const fresh = { openid: 'openid-provisioned' };
    const created = service.resolveWechatUser(config, fresh, '10.0.0.1', { autoProvision: true });
    assert.equal(db.getRow('SELECT COUNT(*) AS count FROM users').count, before + 1);
    assert.equal(created.role, 'user');
    assert.equal(created.status, 'active');
    assert.match(created.username, /^wx_[0-9a-f]{12}$/);
    assert.match(created.nickname, /^微信用户[0-9a-f]{4}$/);
    assert.equal(created.last_login_ip, '10.0.0.1');
    // The password is random and never returned, so no guess may open the account.
    assert.ok(created.password_hash.startsWith('scrypt$'));
    for (const guess of ['', created.username, '123456', 'password']) assert.equal(auth.verifyPassword(guess, created.password_hash), false);
    // A later login reuses the same account instead of provisioning another one.
    const again = service.resolveWechatUser(config, fresh, '10.0.0.2', { autoProvision: true });
    assert.equal(again.id, created.id);
    assert.equal(again.last_login_ip, '10.0.0.2');
    assert.equal(db.getRow('SELECT COUNT(*) AS count FROM users').count, before + 1);
    // Provisioning is scoped to one AppID, so another app gets its own account.
    assert.notEqual(service.resolveWechatUser({ ...config, appId: 'other-app' }, fresh, 'ip', { autoProvision: true }).id, created.id);
  });
  await t.test('disabled and deleted accounts stay blocked, and a deleted account is never re-provisioned', () => {
    const user = service.resolveWechatUser(config, identity, '127.0.0.1');
    db.run("UPDATE users SET status = 'disabled' WHERE id = ?", user.id);
    assert.throws(() => service.resolveWechatUser(config, identity, 'ip'), rejectsStatus(403));
    db.run("UPDATE users SET status = 'active', deleted_at = 1 WHERE id = ?", user.id);
    // The identity is still linked, so provisioning must not resurrect the row.
    const before = db.getRow('SELECT COUNT(*) AS count FROM users').count;
    assert.throws(() => service.resolveWechatUser(config, identity, 'ip', { autoProvision: true }), rejectsStatus(403));
    assert.equal(db.getRow('SELECT COUNT(*) AS count FROM users').count, before);
    db.run('UPDATE users SET deleted_at = NULL WHERE id = ?', user.id);
    // An admin account can never be reached through a provider login.
    const admin = db.getRow("SELECT * FROM users WHERE role = 'admin'");
    db.run('INSERT INTO auth_identities(provider,provider_app_id,subject,user_id,created_at,updated_at) VALUES(?,?,?,?,?,?)', 'wechat-mini', config.appId, 'admin-identity', admin.id, Date.now(), Date.now());
    assert.throws(() => service.resolveWechatUser(config, { openid: 'admin-identity' }, 'ip'), rejectsStatus(403));
  });
  await t.test('native token works across protected routes, expires, revokes and cannot be used as cookie', async () => {
    const user = service.resolveWechatUser(config, identity, '127.0.0.1');
    const app = createApp();
    app.use('/issue', eventHandler(event => {
      const context = auth.createMiniProgramSession(event, user);
      return { token: context.token };
    }));
    app.use('/cookie', eventHandler(event => ({ token: auth.createAnonymousSession(event).token })));
    app.use('/me', eventHandler(event => auth.publicUser(auth.requireUserSession(event).user)));
    app.use('/logout', eventHandler(event => { auth.revokeSession(auth.getUserSession(event), event); return { ok: true }; }));
    const server = createServer(toNodeListener(app));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const issue = await fetch(`${base}/issue`);
      assert.equal(issue.headers.get('set-cookie'), null);
      assert.equal(issue.headers.get('cache-control'), 'no-store');
      const { token } = await issue.json();
      assert.equal(db.getRow('SELECT 1 FROM sessions WHERE token_hash = ?', token), undefined);
      const headers = { Authorization: `Bearer ${token}` };
      assert.equal((await fetch(`${base}/me`, { headers })).status, 200);
      assert.equal((await fetch(`${base}/me`, { headers: { Cookie: `panhub_session=${token}` } })).status, 401);
      const cookie = await (await fetch(`${base}/cookie`)).json();
      assert.equal((await fetch(`${base}/me`, { headers: { Authorization: `Bearer ${cookie.token}` } })).status, 401);
      assert.equal((await fetch(`${base}/me`, { headers: { Authorization: 'Bearer invalid' } })).status, 401);
      await fetch(`${base}/logout`, { method: 'POST', headers });
      assert.equal((await fetch(`${base}/me`, { headers })).status, 401);
      const next = await (await fetch(`${base}/issue`)).json();
      db.run('UPDATE sessions SET expires_at = 0 WHERE user_id = ?', user.id);
      assert.equal((await fetch(`${base}/me`, { headers: { Authorization: `Bearer ${next.token}` } })).status, 401);
      const last = await (await fetch(`${base}/issue`)).json();
      auth.revokeUserSessions(user.id);
      assert.equal((await fetch(`${base}/me`, { headers: { Authorization: `Bearer ${last.token}` } })).status, 401);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
  await t.test('migration can reopen existing databases without losing users', () => {
    const before = db.getRow('SELECT COUNT(*) AS count FROM users').count;
    db.exec('ALTER TABLE sessions DROP COLUMN transport');
    db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
    const second = new SqliteDatabase(process.env.PANHUB_SQLITE_DB);
    assert.equal(second.getRow('SELECT COUNT(*) AS count FROM users').count, before);
    assert.ok(second.allRows('PRAGMA table_info(sessions)').some(column => column.name === 'transport'));
    assert.ok(!second.allRows('PRAGMA table_info(users)').some(column => column.name === 'must_change_password'));
    second.close();
  });
});

test('a fresh database never seeds a shared default administrator password', () => {
  const pinned = process.env.PANHUB_ADMIN_INITIAL_PASSWORD;
  const seededDirectory = mkdtempSync(join(tmpdir(), 'panhub-seed-'));
  let seeded;
  try {
    // Unset, so the seed has to generate a password of its own.
    delete process.env.PANHUB_ADMIN_INITIAL_PASSWORD;
    const fresh = new SqliteDatabase(join(seededDirectory, 'fresh.sqlite'));
    seeded = fresh.getRow('SELECT * FROM users WHERE username_normalized = ?', 'admin');
    fresh.close();
  } finally {
    if (pinned === undefined) delete process.env.PANHUB_ADMIN_INITIAL_PASSWORD;
    else process.env.PANHUB_ADMIN_INITIAL_PASSWORD = pinned;
    rmSync(seededDirectory, { recursive: true, force: true });
  }
  assert.equal(seeded.role, 'admin');
  assert.equal(seeded.status, 'active');
  // Every credential this repository has shipped as a default is refused.
  for (const guess of ['123456', 'admin', 'password', 'admin123', '']) {
    assert.equal(auth.verifyPassword(guess, seeded.password_hash), false);
  }
});

test('console account creation produces an administrator, never an unreachable user', async () => {
  const adminUserService = await jiti.import('../server/core/services/adminUserService.ts');
  const before = db.getRow('SELECT COUNT(*) AS count FROM users').count;
  const created = adminUserService.createAdminUser({ username: 'console_admin_1', password: 'secret123', nickname: '控制台管理员' });
  // Ordinary accounts only ever come from a first mini-program login, so an
  // ordinary account created from the console could never be signed into.
  assert.equal(created.role, 'admin');
  assert.equal(created.status, 'active');
  assert.equal(db.getRow('SELECT COUNT(*) AS count FROM users').count, before + 1);
  const row = db.getRow('SELECT * FROM users WHERE id = ?', created.id);
  assert.equal(row.role, 'admin');
  assert.equal(auth.verifyPassword('secret123', row.password_hash), true);
});

test('credential sign-in throttles failures without spending budget on successes', async () => {
  const loginModule = await jiti.import('../server/api/account/login.post.ts');
  const loginHandler = loginModule.default ?? loginModule;
  const { credentialLoginLimiter } = await jiti.import('../server/core/security/rateLimit.ts');
  const app = createApp();
  app.use('/login', eventHandler((event) => loginHandler(event)));
  const server = createServer(toNodeListener(app));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const attempt = (password) => fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password }),
  });
  try {
    // A correct password never spends budget, so repeated sign-ins stay possible.
    credentialLoginLimiter.reset();
    for (let i = 0; i < 12; i += 1) assert.equal((await attempt(ADMIN_PASSWORD)).status, 200);

    // Wrong passwords spend it, and the endpoint then refuses to keep guessing.
    credentialLoginLimiter.reset();
    for (let i = 0; i < 10; i += 1) assert.equal((await attempt('wrong-password')).status, 401);
    const throttled = await attempt('wrong-password');
    assert.equal(throttled.status, 429);
    assert.ok(Number(throttled.headers.get('retry-after')) >= 1);
    // The gate runs before the password check, so it also refuses the correct
    // password until the window rolls over. That is the deliberate trade-off of
    // pre-checking: guessing is genuinely capped, at the cost of a temporary
    // denial an attacker can trigger.
    assert.equal((await attempt(ADMIN_PASSWORD)).status, 429);

    credentialLoginLimiter.reset();
    assert.equal((await attempt(ADMIN_PASSWORD)).status, 200);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
