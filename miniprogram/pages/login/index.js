const auth = require('../../utils/auth');

// A code scene is the website's login ticket: 12 random bytes as 24 hex chars.
const SCENE_PATTERN = /^[0-9a-f]{24}$/;

function readScene(value) {
  if (typeof value !== 'string') return '';
  let text = value.trim();
  try { text = decodeURIComponent(text); } catch (error) { /* keep the raw value */ }
  return SCENE_PATTERN.test(text) ? text : '';
}

require('../../utils/theme').themedPage({
  data: { busy: false, user: null, error: '', scene: '', confirmed: false },

  onLoad(options) {
    const scene = readScene(options && options.scene);
    if (scene) this.setData({ scene });
  },

  onShow() {
    // Scanning the website code while this page is already open re-enters the
    // mini program without firing onLoad again, so read the enter options too.
    if (this.data.scene) return;
    const enter = typeof wx.getEnterOptionsSync === 'function' ? wx.getEnterOptionsSync() : null;
    const scene = readScene(enter && enter.query && enter.query.scene);
    if (scene) this.setData({ scene });
  },

  async onConfirmQr() {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try {
      await auth.confirmQrLogin(this.data.scene);
      this.setData({ confirmed: true });
    } catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ busy: false }); }
  },

  async onLogin() {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try {
      const user = await auth.login();
      this.setData({ user });
    } catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ busy: false }); }
  },

  async onLogout() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try { await auth.logout(); }
    catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ user: null, busy: false }); }
  }
});
