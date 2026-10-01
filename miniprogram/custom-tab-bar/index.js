const feedback = require('../utils/feedback');
const { getTheme } = require('../utils/theme');
Component({
  data: {
    theme: 'geometric', selected: 0,
    tabs: [
      { path: '/pages/index/index', label: '搜索', icon: 'search' },
      { path: '/pages/profile/profile', label: '我的', icon: 'user' },
    ],
  },
  lifetimes: { attached() { this.refresh(); } },
  pageLifetimes: { show() { this.refresh(); } },
  methods: {
    refresh() {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      this.setData({ theme: getTheme(), selected: page && page.route === 'pages/profile/profile' ? 1 : 0 });
    },
    switchTab(event) {
      const index = Number(event.currentTarget.dataset.index);
      if (index === this.data.selected || this.switching || !this.data.tabs[index]) return;
      this.switching = true;
      wx.switchTab({ url: this.data.tabs[index].path,
        fail: () => feedback.showToast({ title: '切换失败，请重试', icon: 'none' }),
        complete: () => { this.switching = false; },
      });
    },
  },
});
