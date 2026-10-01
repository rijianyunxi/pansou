const auth = require('./utils/auth');
const api = require('./utils/api');
const { DEFAULT_HOME_SEARCH_PLACEHOLDER } = require('./utils/config');

App({
  globalData: {
    // Session flags loaded once after launch; pages re-read via api.fetchSession.
    session: { authenticated: false, user: null, showHotSearch: true, anonymousCustomChannels: false, homeSearchPlaceholder: DEFAULT_HOME_SEARCH_PLACEHOLDER },
    sessionReady: false,
  },

  onLaunch() {
    // Silent code2Session login: first launch auto-creates the account and the
    // Bearer token from then on is the only credential (no cookies involved).
    auth.ensureLogin()
      .catch(() => undefined) // stay anonymous; search still works without a token
      .then(() => api.fetchSession({ fresh: true }))
      .then((session) => {
        this.globalData.session = session;
        this.globalData.sessionReady = true;
      })
      .catch(() => undefined);
  },
});
