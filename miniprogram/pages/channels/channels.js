const api = require('../../utils/api');

Page({
  data: {
    loading: true,
    needLogin: false,
    channels: [],
    limit: 50,
    inputValue: '',
    busy: false,
    error: '',
  },

  onShow() {
    this.load();
  },

  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const session = await api.fetchSession();
      if (!session.authenticated && !session.anonymousCustomChannels) {
        this.setData({ needLogin: true, channels: [] });
        return;
      }
      const { channels, limit } = await api.fetchChannels();
      this.setData({ needLogin: false, channels, limit });
    } catch (error) {
      this.setData({ error: error.message });
    } finally {
      this.setData({ loading: false });
    }
  },

  onGoLogin() {
    wx.navigateTo({ url: '/pages/login/index' });
  },

  onInput(event) {
    this.setData({ inputValue: event.detail.value });
  },

  async onAdd() {
    if (this.data.busy) return;
    const input = (this.data.inputValue || '').trim();
    if (!input) {
      wx.showToast({ title: '请输入频道用户名或链接', icon: 'none' });
      return;
    }
    this.setData({ busy: true, error: '' });
    try {
      const result = await api.validateChannel(input);
      if (!result.ok) {
        this.setData({ error: result.message || '该频道不可用' });
        return;
      }
      if (this.data.channels.indexOf(result.channel) >= 0) {
        wx.showToast({ title: '该频道已在列表中', icon: 'none' });
        return;
      }
      if (this.data.channels.length >= this.data.limit) {
        this.setData({ error: `频道数量已达上限（${this.data.limit} 个）` });
        return;
      }
      await api.saveChannels(this.data.channels.concat(result.channel));
      const { channels, limit } = await api.fetchChannels();
      this.setData({ channels, limit, inputValue: '' });
      wx.showToast({ title: '添加成功', icon: 'success' });
    } catch (error) {
      this.setData({ error: error.message });
    } finally {
      this.setData({ busy: false });
    }
  },

  onRemove(event) {
    const name = event.currentTarget.dataset.name;
    wx.showModal({
      title: '删除频道',
      content: `确定删除 @${name} 吗？`,
      confirmText: '删除',
      success: async (result) => {
        if (!result.confirm) return;
        try {
          await api.deleteChannel(name);
          const { channels, limit } = await api.fetchChannels();
          this.setData({ channels, limit });
        } catch (error) {
          this.setData({ error: error.message });
        }
      },
    });
  },
});
