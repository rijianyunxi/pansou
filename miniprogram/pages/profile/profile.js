const auth = require('../../utils/auth');
const api = require('../../utils/api');

Page({
  data: {
    loading: false,
    authenticated: false,
    user: null,
  },

  onShow() {
    this.refreshSession();
  },

  async refreshSession() {
    this.setData({ loading: true });
    try {
      const session = await api.fetchSession({ fresh: true });
      this.setData({ authenticated: session.authenticated, user: session.user });
    } catch (error) {
      this.setData({ authenticated: false, user: null });
    } finally {
      this.setData({ loading: false });
    }
  },

  onGoChannels() {
    wx.navigateTo({ url: '/pages/channels/channels' });
  },

  async onLogin() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      await auth.ensureLogin();
      await this.refreshSession();
      wx.showToast({ title: '已登录', icon: 'success' });
    } catch (error) {
      wx.showModal({ title: '登录失败', content: error.message, showCancel: false });
    } finally {
      this.setData({ loading: false });
    }
  },

  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '退出后将无法使用自定义频道，确定退出吗？',
      confirmText: '退出',
      success: async (result) => {
        if (!result.confirm) return;
        try {
          await auth.logout();
          await this.refreshSession();
        } catch (error) {
          wx.showToast({ title: error.message, icon: 'none' });
        }
      },
    });
  },

  onAbout() {
    wx.showModal({
      title: '关于盘搜',
      content: '盘搜 · 网盘资源聚合搜索\n聚合各网盘分享与 Telegram 频道资源，支持关键词搜索与自定义频道订阅。',
      showCancel: false,
      confirmText: '知道了',
    });
  },

  onCopyright() {
    wx.navigateTo({ url: '/pages/copyright/copyright' });
  },
});
