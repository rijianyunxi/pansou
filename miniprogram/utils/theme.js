const feedback = require('./feedback');
let current;
function getTheme() {
  if (!current) {
    try { current = wx.getStorageSync('panhub.theme'); } catch (_) {}
    current = current === 'classic' ? 'classic' : 'geometric';
  }
  return current;
}
function sync(page) {
  const theme = getTheme();
  page.setData({ theme });
  const backgroundColor = theme === 'geometric' ? '#fffbed' : '#f6f7f9';
  wx.setNavigationBarColor({ frontColor: '#000000', backgroundColor });
  wx.setBackgroundColor({ backgroundColor });
  const bar = typeof page.getTabBar === 'function' && page.getTabBar();
  if (bar) bar.setData({ theme, selected: page.route === 'pages/profile/profile' ? 1 : 0 });
}
function themedPage(definition) {
  const onLoad = definition.onLoad;
  const onShow = definition.onShow;
  const onUnload = definition.onUnload;
  Page(Object.assign({}, definition, {
    data: Object.assign({}, definition.data, { theme: getTheme(), feedbackToast: null, feedbackModal: null }),
    onFeedbackConfirm() { feedback.closeModal(this, true); },
    onFeedbackCancel() { feedback.closeModal(this, false); },
    onUnload(...args) { feedback.dispose(this); if (onUnload) return onUnload.apply(this, args); },
    onLoad(...args) { sync(this); if (onLoad) return onLoad.apply(this, args); },
    onShow(...args) { sync(this); if (onShow) return onShow.apply(this, args); },
    onThemeToggle() {
      current = getTheme() === 'classic' ? 'geometric' : 'classic';
      try { wx.setStorageSync('panhub.theme', current); } catch (_) {}
      sync(this);
    },
  }));
}
module.exports = { getTheme, themedPage };
