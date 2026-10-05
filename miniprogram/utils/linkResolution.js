const auth = require('./auth');
function uuid() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const n = Math.floor(Math.random() * 16); return (c === 'x' ? n : (n & 3) | 8).toString(16); }); }
function usable(value) {
  return value && value.status === 'completed' && /^(https?:\/\/|magnet:\?)/i.test(value.url || '')
    && [value.deliveryExpiresAt, value.shareExpiresAt].every(t => !t || Date.parse(t) > Date.now());
}
async function resolveLink(resultRef, linkRef, key, control, resume, onProgress) {
  const session = auth.getSession();
  const token = session && session.token;
  if (!token) throw new Error('会话已失效，请重新搜索');
  const deadline = Date.now() + 150000;
  let poll = !!resume;
  while (!control.stopped && Date.now() < deadline) {
    let interval = 1500;
    if (!auth.getSession() || auth.getSession().token !== token) throw new Error('会话已变化，请重新搜索');
    try {
      const response = await auth.request(poll ? `/api/links/resolve-operations/${key}` : '/api/links/resolve',
        poll ? {} : { method: 'POST', data: { resultRef, linkRef, requestKey: key } });
      if (control.stopped) return null;
      if (!auth.getSession() || auth.getSession().token !== token) throw Object.assign(new Error('会话已变化，请重新搜索'), { statusCode: 409 });
      const value = response.data.data;
      if (!value || typeof value.status !== 'string') throw Object.assign(new Error('取链接口返回格式异常，请重新搜索'), { statusCode: 502 });
      if (response.statusCode === 200 && ['completed','unavailable'].includes(value.status)) return value;
      if (onProgress) onProgress(value);
      interval = Math.max(500, Math.min(3000, value.pollAfterMs || 1500));
    } catch (error) {
      if (error.statusCode) throw new Error([401,403,409,410].includes(error.statusCode) ? '会话或链接已变化，请重新搜索' : error.message);
      // Lost POST response: only poll the same key, never relogin and POST again.
    }
    poll = true;
    if (control.stopped) return null;
    await new Promise(resolve => { control.timer = setTimeout(resolve, interval); control.wake = resolve; });
  }
  if (control.stopped) return null;
  throw new Error('等待超时，请继续查询本次操作');
}
function stop(control) { control.stopped = true; clearTimeout(control.timer); if (control.wake) control.wake(); }
module.exports = { uuid, usable, resolveLink, stop };
