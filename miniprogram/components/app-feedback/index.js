Component({
  properties: {
    top: { type: Number, value: 0 },
    theme: { type: String, value: 'geometric' },
    toast: { type: Object, value: null },
    modal: { type: Object, value: null },
    loading: { type: Boolean, value: false },
    loadingText: { type: String, value: '正在加载…' },
  },
  methods: {
    confirm() { this.triggerEvent('confirm'); },
    cancel() { this.triggerEvent('cancel'); },
    swallow() {},
  },
});
