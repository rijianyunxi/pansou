const auth = require('./auth');
const { DEFAULT_HOME_SEARCH_PLACEHOLDER } = require('./config');

/**
 * All mini program calls go through here so an expired Bearer token is
 * recovered transparently: auth.request already clears the stored session on
 * 401, so one silent re-login + retry is enough.
 */
async function requestWithLoginRetry(path, options = {}) {
  try {
    return await auth.request(path, options);
  } catch (error) {
    if (error.statusCode !== 401 || options.authenticated === false) throw error;
    await auth.login();
    return auth.request(path, options);
  }
}

let sessionPromise;

function fetchSession({ fresh = false } = {}) {
  if (fresh) sessionPromise = undefined;
  if (!sessionPromise) {
    sessionPromise = requestWithLoginRetry('/api/account/session')
      .then(({ data }) => ({
        authenticated: !!data.authenticated,
        user: data.user || null,
        showHotSearch: data.showHotSearch !== false,
        anonymousCustomChannels: !!data.anonymousCustomChannels,
        homeSearchPlaceholder: typeof data.homeSearchPlaceholder === 'string' && data.homeSearchPlaceholder.trim()
          ? data.homeSearchPlaceholder.trim()
          : DEFAULT_HOME_SEARCH_PLACEHOLDER,
      }))
      .catch((error) => { sessionPromise = undefined; throw error; });
  }
  return sessionPromise;
}

async function fetchHotSearches(limit = 10) {
  const { data } = await auth.request(`/api/hot-searches?limit=${limit}`, { authenticated: false });
  if (!data || data.code !== 0) throw new Error((data && data.message) || '获取热搜失败');
  return data.data.hotSearches || [];
}

async function fetchChannels() {
  const { data } = await requestWithLoginRetry('/api/account/channels');
  return { channels: data.channels || [], limit: data.limit || 50 };
}

async function validateChannel(input) {
  const { data } = await requestWithLoginRetry('/api/account/channels/validate', { method: 'POST', data: { channel: input } });
  return data;
}

async function saveChannels(channels) {
  const { data } = await requestWithLoginRetry('/api/account/channels', { method: 'POST', data: { channels } });
  return data;
}

async function deleteChannel(name) {
  await requestWithLoginRetry(`/api/account/channels/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

/**
 * Report a copied/opened resource into the admin capture queue. Best effort:
 * failures must never disturb the copy/open interaction itself.
 */
function captureResource(resource) {
  auth.request('/api/search/resources', { method: 'POST', data: { resource } }).catch(() => undefined);
}

module.exports = { requestWithLoginRetry, fetchSession, fetchHotSearches, fetchChannels, validateChannel, saveChannels, deleteChannel, captureResource };
