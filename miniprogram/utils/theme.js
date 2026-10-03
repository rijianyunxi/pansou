const feedback = require('./feedback');
function getTheme() { return 'orange'; }
function sync(page) {
  const theme = getTheme();
  page.setData({ theme });
  const backgroundColor = '#fffdf7';
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

  }));
}
module.exports = { getTheme, themedPage };
