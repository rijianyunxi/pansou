const api = require('./utils/api');

App({
  globalData: {
    // Session flags loaded once after launch; pages re-read via api.fetchSession.
    session: { authenticated: false, user: null, showHotSearch: false, anonymousCustomChannels: false, homeSearchPlaceholder: '' },
    sessionReady: false,
  },

  onLaunch() {
    // Silent code2Session login: first launch auto-creates the account and the
    // Bearer token from then on is the only credential (no cookies involved).
    return api.fetchSession()
      .then((session) => {
        this.globalData.session = session;
        this.globalData.sessionReady = true;
      })
      .catch(() => undefined);
  },
});
