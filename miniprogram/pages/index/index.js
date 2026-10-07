const { createHistory } = require('../../utils/searchHistory');
const historyStore = createHistory({ getItem: key => wx.getStorageSync(key), setItem: (key, value) => wx.setStorageSync(key, value), removeItem: key => wx.removeStorageSync(key) });
const feedback = require('../../utils/feedback');
const api = require('../../utils/api');
const { searchStream } = require('../../utils/searchStream');
const { mergeResultsByLink, flattenResultsForDisplay } = require('../../utils/resultMerge');
const { platformLabel, platformIcon, sortCloudTypes } = require('../../utils/cloudTypes');
const { sortResults } = require('../../utils/format');

const PAGE_SIZE = 30;
const FLUSH_INTERVAL = 300;
const BATCH_INTERVAL_MS = 500;
const MAX_BATCHES = 4;
const DESC_TOGGLE_LENGTH = 66;

const SORT_OPTIONS = ['默认顺序', '最新发布', '最早发布'];
const SORT_TYPES = { 0: 'default', 1: 'date-desc', 2: 'date-asc' };

function getNavigationMetrics() {
  let windowInfo = {};
  let capsule = {};
  try {
    windowInfo = typeof wx.getWindowInfo === 'function'
      ? wx.getWindowInfo()
      : wx.getSystemInfoSync();
  } catch (error) { /* use the safe fallback below */ }
  try {
    capsule = wx.getMenuButtonBoundingClientRect() || {};
  } catch (error) { /* older clients may not expose the capsule API */ }

  const statusBarHeight = Number(windowInfo.statusBarHeight) || 0;
  const windowWidth = Number(windowInfo.windowWidth) || 375;
  const capsuleHeight = Number(capsule.height) || 32;
  const capsuleTop = Number(capsule.top) || statusBarHeight + 6;
  const topGap = Math.max(capsuleTop - statusBarHeight, 6);
  const navContentHeight = Math.max(capsuleHeight + topGap * 2, 44);
  const capsuleReserve = Number(capsule.left)
    ? Math.max(windowWidth - Number(capsule.left) + 8, 0)
    : 96;

  return {
    statusBarHeight,
    navContentHeight,
    navBarHeight: statusBarHeight + navContentHeight,
    capsuleReserve,
  };
}

function initialState() {
  return {
    statusBarHeight: 0,
    navContentHeight: 44,
    navBarHeight: 44,
    capsuleReserve: 0,
    theme: 'orange',
    searchHistory: [],
    keyword: '',
    scope: 'site',
    channelsCount: 0,
    showHotSearch: false,
    homeSearchPlaceholder: '',
    hotSearches: [],
    searched: false,
    loading: false,
    paused: false,
    elapsedText: '0ms',
    total: 0,
    pills: [],
    sortOptions: SORT_OPTIONS,
    sortIndex: 0,
    results: [],
    hasMore: false,
    isEmpty: false,
    error: '',
    showBackTop: false,
  };
}

function toVM(result) {
  const description = result.description || '';
  return {
    id: result.id,
    resultRef: result.resultRef,
    name: result.name,
    dateText: result.datetime || '',
    description,
    hasLongDesc: description.length > DESC_TOGGLE_LENGTH,
    links: (result.links || []).map((link) => ({
      key: link.linkRef,
      linkRef: link.linkRef,
      type: link.type,
      label: platformLabel(link.type),
      icon: platformIcon(link.type),

    })),
  };
}

function platformCountsOf(results) {
  const counts = {};
  for (const result of results) {
    for (const type of result.cloud_types || []) {
      counts[type] = (counts[type] || 0) + 1;
    }
  }
  return counts;
}

require('../../utils/theme').themedPage({
  data: initialState(),

  // Page-private state kept out of setData during streaming.
  _merged: [],
  _filterPlatform: 'all',
  _stream: null,
  _searchSeq: 0,
  _snapshot: null,
  _userChannels: [],
  _timer: null,
  _startedAt: 0,
  _accumulated: 0,
  _flushTimer: null,
  _flagsPromise: null,

  onLoad(options) {
    this.setData(Object.assign(getNavigationMetrics(), { searchHistory: historyStore.read() }));
    this.loadSessionFlags();
    if (options && options.q) {
      let keyword;
      try { keyword = decodeURIComponent(options.q); } catch (_) { keyword = options.q; }
      this.setData({ keyword });
      this.startSearch(keyword);
    }
  },

  onShow() {
    // Re-read in case the device rotates or the page returns from another page.
    this.setData(Object.assign(getNavigationMetrics(), { searchHistory: historyStore.read() }));
    this.loadSessionFlags();
    // Returning from the channels page may have changed the channel list.
    this.refreshChannelsCount();
  },

  onHide() {
    if (this.data.loading) this.onPause();
  },

  onUnload() {
    this._searchSeq += 1;
    this.stopTimer();
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this.cancelActiveSearch();
  },

  onShareAppMessage() {
    const keyword = (this.data.keyword || '').trim();
    return {
      title: keyword ? `「${keyword}」的网盘资源` : '盘搜 · 网盘资源聚合搜索',
      path: keyword ? `/pages/index/index?q=${encodeURIComponent(keyword)}` : '/pages/index/index',
    };
  },

  onPageScroll(event) {
    const show = event.scrollTop > 360;
    if (show !== this.data.showBackTop) this.setData({ showBackTop: show });
  },

  loadSessionFlags() {
    if (this._flagsPromise) return this._flagsPromise;
    this._flagsPromise = api.fetchSession()
      .then(async session => {
        this.setData({ showHotSearch: session.showHotSearch, homeSearchPlaceholder: session.homeSearchPlaceholder });
        if (session.showHotSearch && !this.data.searched) await this.loadHotSearches();
        else if (!session.showHotSearch) this.setData({ hotSearches: [] });
      })
      .catch(() => { this.setData({ showHotSearch: false, hotSearches: [] }); })
      .finally(() => { this._flagsPromise = null; });
    return this._flagsPromise;
  },

  async loadHotSearches() {
    if (!this.data.showHotSearch) return;
    try {
      const hotSearches = await api.fetchHotSearches(10);
      this.setData({
        hotSearches: hotSearches.map((item, index) => ({ term: item.term, rank: index + 1 })),
      });
    } catch (error) { /* hot searches are decorative; stay quiet */ }
  },

  refreshChannelsCount() {
    api.fetchSession()
      .then((session) => {
        if (!session.authenticated && !session.anonymousCustomChannels) {
          this._userChannels = [];
          this.setData({ channelsCount: 0, scope: 'site' });
          return;
        }
        return api.fetchChannels().then(({ channels }) => {
          this._userChannels = channels;
          this.setData({ channelsCount: channels.length });
        });
      })
      .catch(() => undefined);
  },

  changeHistory(action, term) {
    try { this.setData({ searchHistory: action === 'clear' ? historyStore.clear() : historyStore[action](term) }); }
    catch (_) { feedback.showToast({ title: '搜索历史保存失败，请检查存储空间', icon: 'none' }); }
  },
  onRemoveHistory(event) { this.changeHistory('remove', event.currentTarget.dataset.term); },
  onClearHistory() { this.changeHistory('clear'); },

  onInput(event) {
    this.setData({ keyword: event.detail.value });
  },

  onClearInput() {
    this.setData({ keyword: '' });
  },

  onHotTap(event) {
    const term = event.currentTarget.dataset.term;
    this.setData({ keyword: term });
    this.startSearch(term);
  },

  onScopeSite() {
    if (this.data.scope !== 'site') this.setData({ scope: 'site' });
  },

  async onScopeChannels() {
    if (this.data.scope === 'channels') return;
    try {
      const session = await api.fetchSession();
      if (!session.authenticated && !session.anonymousCustomChannels) {
        feedback.showModal({
          title: '需要登录',
          content: '自定义频道需要登录后使用，是否前往登录？',
          confirmText: '去登录',
          success: (result) => {
            if (result.confirm) wx.navigateTo({ url: '/pages/login/index' });
          },
        });
        return;
      }
      const { channels } = await api.fetchChannels();
      this._userChannels = channels;
      this.setData({ scope: 'channels', channelsCount: channels.length });
    } catch (error) {
      feedback.showToast({ title: error.message, icon: 'none' });
    }
  },

  onOpenChannels() {
    wx.navigateTo({ url: '/pages/channels/channels' });
  },

  onSearchTap() {
    if (this.data.loading) return;
    const keyword = (this.data.keyword || '').trim();
    if (!keyword) {
      feedback.showToast({ title: '请输入搜索关键词', icon: 'none' });
      return;
    }
    if (this.data.scope === 'channels' && !this._userChannels.length) {
      feedback.showToast({ title: '请先添加至少一个公开频道，再搜索自定义频道', icon: 'none', duration: 2500 });
      return;
    }
    this.startSearch(keyword);
  },

  startSearch(keyword) {
    keyword = typeof keyword === 'string' ? keyword.trim().slice(0, 100) : '';
    if (!keyword) return;
    const userChannels = this.data.scope === 'channels' ? this._userChannels.slice() : undefined;
    if (this.data.scope === 'channels' && !userChannels.length) {
      feedback.showToast({ title: '请先添加至少一个公开频道，再搜索自定义频道', icon: 'none', duration: 2500 });
      return;
    }
    this.changeHistory('add', keyword);
    this.cancelActiveSearch();
    this._searchSeq += 1;
    this._merged = [];
    this._nextCursor = null;
    this._searchContext = null;
    this._batchCount = 0;
    this._catalogMerged = [];
    this._serverPagination = false;
    this._filterPlatform = 'all';
    this._accumulated = 0;
    this._snapshot = {
      keyword,
      userChannels,
    };
    this.setData({
      searched: true,
      loading: true,
      paused: false,
      error: '',
      isEmpty: false,
      total: 0,
      results: [],
      pills: [],
      sortIndex: 0,
      visibleCount: PAGE_SIZE,
      hasMore: false,
      elapsedText: '0ms',
    });
    this.runSearch();
  },

  continueSearch() {
    if (!this._snapshot || !this.data.paused) return;
    if (this._serverPagination && this._merged.length && !this._activeCursor) { this.setData({ paused: false }); this.flush(); return; }
    this.cancelActiveSearch();
    this._searchSeq += 1;
    this.setData({ loading: true, paused: false, error: '' });
    this.runSearch(this._activeCursor);
  },

  runSearch(cursor) {
    this._activeCursor = cursor;
    const seq = this._searchSeq;
    const snapshot = this._snapshot;
    this.startTimer();
    this._stream = searchStream({
      cursor,
      searchContext: this._serverPagination ? this._searchContext : undefined,
      keyword: snapshot.keyword,
      userChannels: snapshot.userChannels,
      onStart: (info) => {
        if (seq !== this._searchSeq) return;
        if (info && info.searchContext) { this._searchContext = info.searchContext; this._serverPagination = true; }
      },
      onUpdate: (update) => {
        if (seq !== this._searchSeq || !update) return;
        if (Object.prototype.hasOwnProperty.call(update,'nextCursor')) {
          this._nextCursor = update.nextCursor || null;
          this._activeCursor = this._nextCursor;
        }
        this._merged = mergeResultsByLink(this._merged.concat(update.results || []));
        this._catalogMerged = mergeResultsByLink((this._catalogMerged || []).concat(update.results || []));
        this.scheduleFlush();
      },
      onComplete: (info) => {
        if (seq !== this._searchSeq) return;
        this._nextCursor = info && info.hasMore ? info.nextCursor : null;
        if (info && info.searchContext) { this._searchContext = info.searchContext; this._serverPagination = true; }
        this._batchCount = (this._batchCount || 0) + 1;
        if (this._batchCount >= MAX_BATCHES) this._nextCursor = null;
        const more = Boolean(this._nextCursor);
        if (!more) this.stopTimer();
        this._stream = null;
        this.setData({ loading: more });
        if (more) {
          this._activeCursor = this._nextCursor;
          this._batchTimer = setTimeout(() => {
            this._batchTimer = null;
            if (seq === this._searchSeq && this._snapshot) this.runSearch(this._nextCursor);
          }, BATCH_INTERVAL_MS);
        }
        this.flush();
        if (!this._merged.length) this.setData({ isEmpty: true });
      },
      onError: (error) => {
        if (seq !== this._searchSeq) return;
        this.stopTimer();
        this.setData({ loading: false, error: error.message });
        this.flush();
      },
      onAbort: () => {
        if (seq !== this._searchSeq) return;
        this.stopTimer();
        this.setData({ loading: false, paused: true });
        this.flush();
      },
    });
  },

  onPause() {
    if (!this.data.loading) return;
    this._searchSeq += 1;
    this.cancelActiveSearch();
    this.stopTimer();
    this.setData({ loading: false, paused: true });
    this.flush();
  },

  onContinue() {
    this.continueSearch();
  },

  onReset() {
    this._nextCursor = null;
    this._searchContext = null; this._serverPagination = false; this._batchCount = 0; this._catalogMerged = [];
    this.cancelActiveSearch();
    this._searchSeq += 1;
    this._snapshot = null;
    this._merged = [];
    this.stopTimer();
    // Reset the search session but keep the selected scope; the input itself should clear.
    const keep = {
      statusBarHeight: this.data.statusBarHeight,
      navContentHeight: this.data.navContentHeight,
      navBarHeight: this.data.navBarHeight,
      capsuleReserve: this.data.capsuleReserve,
      theme: this.data.theme,
      searchHistory: historyStore.read(),
      keyword: '',
      scope: this.data.scope,
      channelsCount: this.data.channelsCount,
    };
    this.setData(Object.assign(initialState(), keep));
    this.loadSessionFlags();
  },

  cancelActiveSearch() {
    if (this._batchTimer) { clearTimeout(this._batchTimer); this._batchTimer = null; }
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    if (this._stream) { this._stream.abort(); this._stream = null; }
  },

  startTimer() {
    this.stopTimer();
    this._startedAt = Date.now();
    this._timer = setInterval(() => {
      const elapsed = this._accumulated + (Date.now() - this._startedAt);
      this.setData({ elapsedText: `${Math.round(elapsed)}ms` });
    }, 100);
  },

  stopTimer() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
      this._accumulated += Date.now() - this._startedAt;
    }
  },

  scheduleFlush() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flush();
    }, FLUSH_INTERVAL);
  },

  flush() {
    const completed = !this.data.loading && !this.data.paused;
    const sortType = completed ? SORT_TYPES[this.data.sortIndex] : 'default';
    const displayResults = flattenResultsForDisplay(this._merged);
    const catalog = flattenResultsForDisplay(this._catalogMerged || this._merged);
    const counts = platformCountsOf(catalog);
    const pills = sortCloudTypes(Object.keys(counts))
      .map((type) => ({
        type,
        label: platformLabel(type),
        count: counts[type],
        active: this._filterPlatform === type,
      }))
    const total = displayResults.length;
    pills.unshift({ type: 'all', label: '全部', count: total, active: this._filterPlatform === 'all' });

    let filtered = this._filterPlatform === 'all'
      ? displayResults
      : displayResults.filter((result) => (result.cloud_types || []).indexOf(this._filterPlatform) >= 0);
    if (sortType !== 'default') filtered = sortResults(filtered, sortType);

    const visibleCount = this._serverPagination ? filtered.length : this.data.visibleCount || PAGE_SIZE;
    const visible = filtered.slice(0, visibleCount).map(toVM);
    this.setData({
      total,
      pills,
      results: visible,
      hasMore: filtered.length > visible.length || Boolean(this._nextCursor && this.data.error),
      loadMoreText: this.data.error && this._nextCursor ? '重试加载剩余结果' : '显示更多结果',
      isEmpty: completed && !filtered.length && !this.data.error,
    });
  },

  onPillTap(event) {
    this._filterPlatform = event.currentTarget.dataset.type;
    this.setData({ visibleCount: PAGE_SIZE });
    this.flush();
  },

  onSortTap(event) {
    if (this.data.loading || this.data.paused) return;
    const index = Number(event.currentTarget.dataset.index);
    if (!Number.isInteger(index) || !SORT_TYPES[index] || index === this.data.sortIndex) return;
    this.setData({ sortIndex: index });
    this.flush();
  },

  onLoadMore() {
    if (this.data.loading || this.data.paused) return;
    const visibleCount = (this.data.visibleCount || PAGE_SIZE) + PAGE_SIZE;
    this.setData({ visibleCount });
    this.flush();
    if (this._nextCursor && this.data.error) {
      this._searchSeq += 1;
      this.setData({ loading: true, error: '' });
      this.runSearch(this._nextCursor);
    }
  },

  onBackTop() {
    wx.pageScrollTo({ scrollTop: 0, duration: 200 });
  },

  onOpenCopyright() {
    wx.navigateTo({ url: '/pages/copyright/copyright' });
  },
});
