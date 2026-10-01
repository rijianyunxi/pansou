Page({
  data: { url: '', failed: false },
  onLoad() {
    this.getOpenerEventChannel().on('open-link', ({ url }) => {
      if (typeof url === 'string' && /^https:\/\//i.test(url)) this.setData({ url });
      else this.onLinkError();
    });
  },
  onLinkError() {
    if (this.data.failed) return;
    this.setData({ failed: true, url: '' });
    wx.showModal({
      title: '无法在微信内打开',
      content: '该链接可能不在小程序业务域名内。请返回搜索页，使用「复制链接」后到浏览器或网盘 App 打开。',
      showCancel: false,
      success: () => wx.navigateBack(),
    });
  },
});
