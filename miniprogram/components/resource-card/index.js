// View-model (`item`) is prebuilt by the page: { id, name, dateText,
// description, hasLongDesc, tags: [], links: [{key,type,label,icon,url,password}] }.
const { copyLink } = require('../../utils/clipboard');
Component({
  properties: {
    theme: { type: String, value: 'classic' },
    item: { type: Object, value: {} },
  },

  data: { descExpanded: false, copiedKey: '' },
  lifetimes: {
    attached() { this._gone = false; },
    detached() { this._gone = true; clearTimeout(this._copyTimer); },
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
        this._lastItemId = id;
        this.setData({ descExpanded: false, copiedKey: '' });
      }
    },
  },

  methods: {
    toggleDesc() {
      this.setData({ descExpanded: !this.data.descExpanded });
    },

    async onCopy(event) {
      const { url, key } = event.currentTarget.dataset;
      const item = this.data.item;
      if (!await copyLink(url) || this._gone || this.data.item.id !== item.id) return;
      clearTimeout(this._copyTimer);
      this.setData({ copiedKey: key });
      this._copyTimer = setTimeout(() => {
        if (!this._gone) this.setData({ copiedKey: '' });
      }, 2400);
    },
  },
});
