// View-model (`item`) is prebuilt by the page: { id, name, dateText,
// description, hasLongDesc, resultRef, links: [{key,type,label,icon,linkRef,validity}] }.
const { copyLink } = require('../../utils/clipboard');
const { uuid, usable, resolveLink, stop } = require('../../utils/linkResolution');
const feedback = require('../../utils/feedback');
const { clipboardText } = require('../../utils/shareLinks');
Component({
  properties: {
    theme: { type: String, value: 'classic' },
    item: { type: Object, value: {} },
  },

  data: { descExpanded: false, copiedKey: '', copyingPassword: false, resolved: {}, loading: {}, progress: {}, dialog: null },
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
    stopQueries() { Object.values(this._controls || {}).forEach(control => { stop(control); clearInterval(control.progressTimer); }); this._controls = {}; this._dialogOperation = null; this.setData({ loading: {}, progress: {}, dialog: null }); },
    expireLinks() {
      const resolved = { ...this.data.resolved };
      for (const key of Object.keys(resolved)) {
        if ([resolved[key].deliveryExpiresAt, resolved[key].shareExpiresAt].some(t => t && Date.parse(t) <= Date.now())) { delete resolved[key]; delete this._keys[key]; }
      }
      this.setData({ resolved });
    },
    noop() {},
    closeDialog() {
      const operation = this._dialogOperation;
      if (operation) { stop(operation.control); clearInterval(operation.control.progressTimer); }
      this._dialogOperation = null;
      this.setData({ dialog: null });
    },
    setDialogStatus(status, message, retryable = true) {
      if (this.data.dialog) this.setData({ dialog: { ...this.data.dialog, status, message, retryable } });
    },
    async runAction(event, action) {
      const key = event.currentTarget.dataset.key;
      if (this.data.loading[key] || this.data.dialog && this.data.dialog.status === 'loading') return;
      const item = this.data.item;
      const link = item.links.find(l => l.key === key);
      if (!link) return;
      const resume = !!this._keys[key]; this._keys[key] ||= uuid();
      const control = {}; this._controls[key] = control;
      const operation = { key, item, link, action, control };
      this._dialogOperation = operation;
      const startedAt = Date.now();
      this.setData({ loading: { ...this.data.loading, [key]: action }, dialog: { status: 'loading', action, name: item.name, provider: link.label, slow: false } });
      control.progressTimer = setInterval(() => {
        if (!control.stopped && !this._gone && this._dialogOperation === operation && this.data.dialog) this.setData({ dialog: { ...this.data.dialog, slow: Date.now()-startedAt >= 15000 } });
      }, 1000);
      try {
        const value = await resolveLink(item.resultRef, link.linkRef, this._keys[key], control, resume);
        if (!value || control.stopped || this._gone || this._dialogOperation !== operation) return;
        operation.value = value;
        this.setData({ resolved: { ...this.data.resolved, [key]: value } });
        delete this._keys[key];
        this.startExpiryTimer();
        if (value.status === 'unavailable' || value.validity === 0) {
          this.setDialogStatus('error', value.reasonCode === 'resource_missing' ? '资源已不存在，试试其他搜索结果。' : '这个链接已失效，试试其他搜索结果。', false);
        } else if (!usable(value)) {
          this.setDialogStatus('error', '暂时没有获取到可用链接，请再试一次。');
        } else if (action === 'open') {
          this.setDialogStatus('ready', '点击打开资源，继续查看。');
        } else {
          await this.copyReady(true);
        }
      } catch (error) {
        if (!this._gone && !control.stopped && this._dialogOperation === operation) this.setDialogStatus('error', error.message || '获取失败，请稍后再试。');
      } finally {
        clearInterval(control.progressTimer);
        if (this._controls[key] === control) {
          if (!this._gone && this.data.item.id === item.id) this.setData({ loading: { ...this.data.loading, [key]: false } });
          delete this._controls[key];
        }
      }
    },
    async copyReady(initial = false) {
      const operation = this._dialogOperation;
      if (!operation || !this.data.dialog || initial !== true && this.data.dialog.status === 'loading') return;
      if (!usable(operation.value) || operation.value.validity === 0) { operation.value = null; this.setDialogStatus('error','链接需要重新获取，请再试一次。'); return; }
      this.setDialogStatus('loading', '正在复制到剪贴板。');
      const success = await copyLink(clipboardText(operation.value), { silent: true });
      if (this._gone || operation.control.stopped || this._dialogOperation !== operation) return;
      if (!success) { this.setDialogStatus('error','复制未完成，请允许剪贴板操作后再试一次。'); return; }
      this.setDialogStatus('success', operation.value.password ? '去浏览器或网盘 App 粘贴打开，提取码也已为你保留。' : '去浏览器或网盘 App 粘贴打开。');
      clearTimeout(this._copyTimer);
      this.setData({ copiedKey: operation.key });
      this._copyTimer = setTimeout(() => { if (!this._gone) this.setData({ copiedKey: '' }); },2400);
    },
    retryDialog() {
      const operation = this._dialogOperation;
      if (!operation) return;
      if (usable(operation.value) && operation.value.validity !== 0) return this.copyReady();
      return this.runAction({ currentTarget: { dataset: { key: operation.key } } }, operation.action);
    },
    openReady() {
      const operation = this._dialogOperation;
      if (!operation) return;
      if (!usable(operation.value) || operation.value.validity === 0) { operation.value = null; this.setDialogStatus('error','链接需要重新获取，请再试一次。'); return; }
      this.openResolvedLink(operation.value);
    },
    toggleDesc() {
      this.setData({ descExpanded: !this.data.descExpanded });
    },

    onCopy(event) { return this.runAction(event, 'copy'); },
    async onCopyPassword(event) {
      const key = event.currentTarget.dataset.key;
      if (this._gone || this.data.loading[key] || this.data.copyingPassword) return;
      this.expireLinks();
      const value = this.data.resolved[key];
      if (!value || !value.password || !usable(value) || value.status === 'unavailable' || value.validity === 0) {
        feedback.showToast({ title: '请先重新获取可用链接', icon: 'error' });
        return;
      }
      this.setData({ copyingPassword: true });
      try { await copyLink(value.password, { successMessage: '提取码已复制' }); }
      finally { if (!this._gone) this.setData({ copyingPassword: false }); }
    },
    onOpen(event) { return this.runAction(event, 'open'); },
    openResolvedLink(value) {
      if (!/^https:\/\//i.test(value.url)) {
        feedback.showModal({ title: '无法直接打开', content: '微信暂不支持直接打开此类型链接，请使用「复制链接」后到浏览器或网盘 App 打开。', showCancel: false });
        return;
      }
      wx.navigateTo({
        url: '/pages/link/index',
        success: result => result.eventChannel.emit('open-link', { url: clipboardText(value) }),
        fail: () => feedback.showToast({ title: '打开失败，请稍后重试或使用复制链接', icon: 'error' }),
      });
    },
  },
});
