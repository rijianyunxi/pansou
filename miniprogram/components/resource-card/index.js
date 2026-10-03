// View-model (`item`) is prebuilt by the page: { id, name, dateText,
// description, hasLongDesc, resultRef, links: [{key,type,label,icon,linkRef,validity}] }.
const { copyLink } = require('../../utils/clipboard');
const { uuid, usable, resolveLink, stop } = require('../../utils/linkResolution');
const feedback = require('../../utils/feedback');
Component({
  properties: {
    theme: { type: String, value: 'classic' },
    item: { type: Object, value: {} },
  },

  data: { descExpanded: false, copiedKey: '', resolved: {}, loading: {}, progress: {} },
  lifetimes: {
    attached() { this._gone = false; this._controls = {}; this._keys = {}; },
    detached() { this._gone = true; this.stopQueries(); clearTimeout(this._copyTimer); clearInterval(this._expiryTimer); },
  },
  pageLifetimes: {
    hide() { this.stopQueries(); clearInterval(this._expiryTimer); this._expiryTimer = null; },
    show() { this.expireLinks(); if (Object.keys(this.data.resolved).length) this.startExpiryTimer(); },
  },

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
        this.stopQueries(); this._keys = {};
        this._lastItemId = id;
        this.setData({ descExpanded: false, copiedKey: '', resolved: {}, loading: {} });
      }
    },
  },

  methods: {
    startExpiryTimer() { if (!this._expiryTimer) this._expiryTimer = setInterval(() => this.expireLinks(), 1000); },
    stopQueries() { Object.values(this._controls || {}).forEach(control => { stop(control); clearInterval(control.progressTimer); }); this._controls = {}; this.setData({ loading: {}, progress: {} }); },
    expireLinks() {
      const resolved = { ...this.data.resolved };
      for (const key of Object.keys(resolved)) {
        if ([resolved[key].deliveryExpiresAt, resolved[key].shareExpiresAt].some(t => t && Date.parse(t) <= Date.now())) { delete resolved[key]; delete this._keys[key]; }
      }
      this.setData({ resolved });
    },
    async runAction(event, action) {
      const key = event.currentTarget.dataset.key;
      if (this.data.loading[key]) return;
      const item = this.data.item;
      const link = item.links.find(l => l.key === key);
      if (!link) return;
      const resume = !!this._keys[key]; this._keys[key] ||= uuid();
      const control = {}; this._controls[key] = control;
      this.setData({ loading: { ...this.data.loading, [key]: action } });
      const startedAt = Date.now();
      let stage = 'queued';
      const updateProgress = () => {
        if (control.stopped || this._gone || this._controls[key] !== control || this.data.item.id !== item.id) return;
        const labels = { queued: '排队中', checking: '读取分享', transferring: '正在转存', sharing: '生成分享', reusing: '验证已有分享' };
        this.setData({ progress: { ...this.data.progress, [key]: { label: labels[stage] || '正在获取链接', elapsed: Math.floor((Date.now() - startedAt) / 1000) } } });
      };
      updateProgress();
      control.progressTimer = setInterval(updateProgress, 1000);
      try {
        const value = await resolveLink(item.resultRef, link.linkRef, this._keys[key], control, resume, value => { stage = value.stage || 'checking'; updateProgress(); });
        if (value && !control.stopped && !this._gone && this.data.item.id === item.id) {
          this.setData({ resolved: { ...this.data.resolved, [key]: value } });
          delete this._keys[key];
          this.startExpiryTimer();
          if (value.status === 'unavailable' || value.validity === 0) {
            feedback.showModal({ title: '提示', content: value.reasonCode === 'resource_missing' ? '分享中的资源已不存在' : '原分享链接已失效', showCancel: false });
          } else if (!usable(value)) {
            feedback.showToast({ title: '未获取到可用链接，请稍后重试', icon: 'error' });
          } else if (action === 'open') {
            this.openResolvedLink(value);
          } else {
            const text = value.url + (value.password ? '\n提取码：' + value.password : '');
            if (await copyLink(text) && !control.stopped && !this._gone && this.data.item.id === item.id) {
              clearTimeout(this._copyTimer);
              this.setData({ copiedKey: key });
              this._copyTimer = setTimeout(() => { if (!this._gone) this.setData({ copiedKey: '' }); }, 2400);
            }
          }
        }
      } catch (e) { if (!this._gone && !control.stopped && this.data.item.id === item.id) feedback.showToast({ title: e.message || '获取失败，请稍后重试', icon: 'error' }); }
      finally {
        clearInterval(control.progressTimer);
        if (this._controls[key] === control) {
          if (!this._gone && this.data.item.id === item.id) {
            const progress = { ...this.data.progress }; delete progress[key];
            this.setData({ loading: { ...this.data.loading, [key]: false }, progress });
          }
          delete this._controls[key];
        }
      }
    },
    toggleDesc() {
      this.setData({ descExpanded: !this.data.descExpanded });
    },

    onCopy(event) { return this.runAction(event, 'copy'); },
    onOpen(event) { return this.runAction(event, 'open'); },
    openResolvedLink(value) {
      if (!/^https:\/\//i.test(value.url)) {
        feedback.showModal({ title: '无法直接打开', content: '微信暂不支持直接打开此类型链接，请使用「复制链接」后到浏览器或网盘 App 打开。', showCancel: false });
        return;
      }
      wx.navigateTo({
        url: '/pages/link/index',
        success: result => result.eventChannel.emit('open-link', { url: value.url }),
        fail: () => feedback.showToast({ title: '打开失败，请稍后重试或使用复制链接', icon: 'error' }),
      });
    },
  },
});
