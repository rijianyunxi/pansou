const { API_BASE } = require('./config');

const STORAGE_KEY = 'panhub-auth';
let pendingLogin;

function getSession() {
  try {
    const session = wx.getStorageSync(STORAGE_KEY);
    return session && session.token ? session : null;
  } catch (error) {
    return null;
  }
}

function clearSession() {
  try { wx.removeStorageSync(STORAGE_KEY); } catch (error) { /* storage unavailable */ }
}

/** A stored token is usable until shortly before its server-side expiry. */
function hasValidSession() {
  const session = getSession();
  if (!session) return false;
  return !session.expiresAt || session.expiresAt > Date.now() + 60000;
}

function request(path, { method = 'GET', data, authenticated = true } = {}) {
  const session = getSession();
  const header = { 'content-type': 'application/json' };
  // Mini program sessions are Bearer-only: the server isolates them from
  // browser cookie sessions and never relies on wx.request cookies here.
  if (authenticated && session) header.Authorization = `Bearer ${session.token}`;
  return new Promise((resolve, reject) => wx.request({
    url: `${API_BASE}${path}`, method, data, header, timeout: 15000,
    success(response) {
      if (response.statusCode >= 200 && response.statusCode < 300) return resolve(response);
      if (response.statusCode === 401 && authenticated) clearSession();
      const detail = response.data && (response.data.statusMessage || response.data.message);
      const messages = {
        'External identity is not linked': '该微信尚未开通账号，请联系管理员。',
        'Account unavailable': '账号已停用，请联系管理员。',
        'Administrator must use the admin password login': '管理员请从管理后台使用账号密码登录。',
        'Unable to provision account': '账号创建失败，请稍后重试或联系管理员。',
        'WeChat login is not configured': '平台尚未开通微信登录，请联系管理员。',
        '该二维码已被使用，请回到网页刷新后重试': '这个二维码已经用过了，请回到网页刷新后重新扫码。',
        '二维码已失效，请回到网页刷新后重试': '二维码已失效，请回到网页刷新后重新扫码。',
        'Invalid login ticket': '二维码无效，请回到网页重新获取。'
      };
      const fallback = { 400: '提交的信息有误，请检查后重试。', 401: '登录凭证无效，请重新登录。', 403: '当前操作不被允许，请联系管理员。', 409: '操作冲突，请稍后重试。', 410: '二维码已失效，请回到网页刷新后重试。', 429: '操作过于频繁，请稍后重试。', 502: '微信登录服务暂不可用，请稍后重试。', 503: '登录服务暂不可用，请稍后重试。' };
      const error = new Error(messages[detail] || fallback[response.statusCode] || `请求失败 (${response.statusCode})`);
      error.statusCode = response.statusCode;
      reject(error);
    },
    fail() {
      const error = new Error('网络请求失败，请稍后重试');
      error.statusCode = 0;
      reject(error);
    }
  }));
}

function loginCode() {
  return new Promise((resolve, reject) => wx.login({
    timeout: 10000,
    success(result) { result.code ? resolve(result.code) : reject(new Error('未获取到微信登录凭证')); },
    fail() { reject(new Error('微信登录失败，请重试')); }
  }));
}

/**
 * Silent wx.login + code2Session. First login auto-creates the account on the
 * server; the returned Bearer token is the only credential the mini program
 * needs (no cookies involved).
 */
function login() {
  if (pendingLogin) return pendingLogin;
  pendingLogin = (async () => {
    const code = await loginCode();
    const { data } = await request('/api/account/wechat/login', { method: 'POST', data: { code }, authenticated: false });
    const session = { token: data.token, expiresAt: data.expiresAt, user: data.user || null };
    wx.setStorageSync(STORAGE_KEY, session);
    return session.user;
  })().finally(() => { pendingLogin = undefined; });
  return pendingLogin;
}

/** Resolve with a usable session: reuse the stored token or sign in silently. */
function ensureLogin() {
  if (hasValidSession()) return Promise.resolve(getSession().user);
  return login();
}

async function logout() {
  try { await request('/api/account/logout', { method: 'POST' }); }
  finally { clearSession(); }
}

/**
 * Confirm a website sign-in.
 *
 * The mini program is opened by scanning a code that carries the website's
 * ticket as its scene. Posting that scene back together with a fresh login code
 * is what turns the scanned code into an account — the browser polls until this
 * call lands.
 */
async function confirmQrLogin(scene) {
  const code = await loginCode();
  await request('/api/account/wechat/qr/confirm', { method: 'POST', data: { scene, code }, authenticated: false });
}

module.exports = { login, ensureLogin, logout, confirmQrLogin, request, getSession, clearSession, hasValidSession };
