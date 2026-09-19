// View-model (`item`) is prebuilt by the page: { id, name, dateText, description,
// hasLongDesc, cloudTypes: [{type,label}], tags: [], links: [{key,type,label,icon,url,password}] }.
Component({
  properties: {
    item: { type: Object, value: {} },
    activePlatform: { type: String, value: 'all' },
  },

  data: { descExpanded: false, copiedKey: '' },

  observers: {
    // Component instances are recycled across list reorders (sort/filter), so
    // reset per-item UI state when a DIFFERENT resource lands here. The
    // observer fires on every parent re-render (each flush rebuilds the item
    // objects), hence the identity check — resetting unconditionally would
    // collapse the description right after the user expands it.
    'item.id'(id) {
      if (this._lastItemId === undefined) {
        this._lastItemId = id;
        return;
      }
      if (id !== this._lastItemId) {
        this._lastItemId = id;
        this.setData({ descExpanded: false, copiedKey: '' });
      }
    },
  },

  methods: {
    toggleDesc() {
      this.setData({ descExpanded: !this.data.descExpanded });
    },

    onTagTap(event) {
      this.triggerEvent('filterplatform', { type: event.currentTarget.dataset.type });
    },

    onOpen(event) {
      const url = event.currentTarget.dataset.url;
      // Third-party pan domains cannot join the web-view business whitelist, so
      // "open" means: hand the URL to the clipboard and guide to the browser.
      wx.setClipboardData({
        data: url,
        success() {
          wx.showToast({ title: '链接已复制，请在浏览器打开', icon: 'none', duration: 2500 });
        },
      });
      this.triggerEvent('open', { url, id: this.data.item.id });
    },

    onCopy(event) {
      const url = event.currentTarget.dataset.url;
      wx.setClipboardData({
        data: url,
        success() {
          wx.showToast({ title: '已复制', icon: 'success' });
        },
      });
      this.setData({ copiedKey: url });
      this.triggerEvent('copy', { url, id: this.data.item.id });
      // Matches the web's 1.6s "已复制" feedback window.
      setTimeout(() => {
        if (this.data.copiedKey === url) this.setData({ copiedKey: '' });
      }, 1600);
    },
  },
});
