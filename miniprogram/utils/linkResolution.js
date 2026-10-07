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
  let poll = !!resume, failures = 0, replayed = false;
  while (!control.stopped && Date.now() < deadline) {
    let interval = 1500;
    if (!auth.getSession() || auth.getSession().token !== token) throw new Error('会话已变化，请重新搜索');
    try {
      const response = await auth.request(poll ? `/api/links/resolve-operations/${key}` : '/api/links/resolve',
        poll ? { control } : { method: 'POST', data: { resultRef, linkRef, requestKey: key }, control });
      if (control.stopped) return null;
      if (!auth.getSession() || auth.getSession().token !== token) throw Object.assign(new Error('会话已变化，请重新搜索'), { statusCode: 409 });
      const value = response.data.data;
      if (!value || !['processing','completed','unavailable'].includes(value.status)) throw Object.assign(new Error('暂时没有获取到链接，请稍后再试。'), { terminal: true });
      failures = 0;
      if (response.statusCode === 200 && ['completed','unavailable'].includes(value.status)) return value;
      if (onProgress) onProgress(value);
      interval = Math.max(500, Math.min(5000, Number.isFinite(value.pollAfterMs) ? value.pollAfterMs : 1500));
    } catch (error) {
      if (control.stopped) return null;
      if (error.terminal) throw error;
      if (poll && error.statusCode === 404 && !replayed) { replayed = true; poll = false; continue; }
      if ([401,403,409,410].includes(error.statusCode)) throw new Error('链接信息已变化，请重新搜索后再试。');
      if ([400,404].includes(error.statusCode)) throw new Error('暂时无法获取这个链接，请重新搜索后再试。');
      if (++failures >= 4) throw new Error('网络不太稳定，请稍后再试。');
      interval = Math.min(5000,1000 * 2 ** (failures - 1));
    }
    poll = true;
    if (control.stopped) return null;
    await new Promise(resolve => { control.timer = setTimeout(resolve, interval); control.wake = resolve; });
    control.wake = null;
  }
  if (control.stopped) return null;
  throw new Error('这次等待有些久，点击重试可继续获取。');
}
function stop(control) { control.stopped = true; clearTimeout(control.timer); if (control.request && control.request.abort) control.request.abort(); if (control.wake) control.wake(); }
module.exports = { uuid, usable, resolveLink, stop };
