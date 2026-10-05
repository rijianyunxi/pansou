const auth = require('./auth');

/**
 * All mini program calls go through here so an expired Bearer token is
 * recovered transparently: auth.request already clears the stored session on
 * 401, so one shared session recovery + retry is enough, including anonymous
 * searches when WeChat login is temporarily unavailable.
 */
async function requestWithLoginRetry(path, options = {}) {
  if (options.authenticated !== false) await auth.ensureSession();
  try {
    return await auth.request(path, options);
  } catch (error) {
    if (error.statusCode !== 401 || options.authenticated === false) throw error;
    await auth.ensureSession();
    return auth.request(path, options);
  }
}

async function fetchSession() {
  await auth.ensureSession();
  const config = await auth.ensureConfiguration();
  const session = auth.getSession();
  return {
    authenticated: !!(session && session.user),
    user: session && session.user || null,
    showHotSearch: config.showHotSearch === true,
    anonymousCustomChannels: config.anonymousCustomChannels,
    homeSearchPlaceholder: config.homeSearchPlaceholder,
  };
}

async function fetchHotSearches(limit = 10) {
  const session = await fetchSession();
  if (!session.showHotSearch) return [];
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

module.exports = { requestWithLoginRetry, fetchSession, fetchHotSearches, fetchChannels, validateChannel, saveChannels, deleteChannel };
