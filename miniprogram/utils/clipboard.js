const feedback = require('./feedback');
let pending = false;
function hideNativeClipboardToast() {
  if (typeof wx.hideToast !== 'function') return;
  wx.hideToast();
  // WeChat may enqueue the clipboard toast after the success callback.
  [0, 80, 220].forEach((delay) => setTimeout(() => wx.hideToast(), delay));
}
function copyLink(url) {
  const page = feedback.owner();
  if (pending) { feedback.showToast({ title: '正在复制，请稍候' }, page); return Promise.resolve(false); }
  if (typeof url !== 'string' || !url.trim()) {
    feedback.showToast({ title: '链接为空，无法复制', icon: 'error' }, page);
    return Promise.resolve(false);
  }
  pending = true;
  feedback.showToast({ title: '正在复制…', duration: 15000 }, page);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true; pending = false; clearTimeout(timer);
      feedback.showToast({
        title: ok ? '链接已复制，请到浏览器或网盘 App 粘贴打开' : '复制未完成，请重试并允许剪贴板操作',
        icon: ok ? 'success' : 'error', duration: 4000,
      }, page);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 15000);
    try { wx.setClipboardData({ data: url, success: () => {
      finish(true);
      // Dismiss the native clipboard toast after the callback and its queued paint.
      hideNativeClipboardToast();
    }, fail: () => finish(false) }); }
    catch (_) { finish(false); }
  });
}
module.exports = { copyLink };
