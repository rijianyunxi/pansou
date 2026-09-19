const auth = require('./auth');
const { API_BASE } = require('./config');

const SEARCH_TIMEOUT = 130000; // server-side hard cap is 120s
const HTTP_MESSAGES = {
  400: '搜索参数有误，请修改后重试。',
  401: '登录会话已失效，请重新进入小程序。',
  403: '当前搜索范围不可用，请调整后重试。',
  429: '搜索太频繁了，请稍后再试。',
};

/**
 * Streaming UTF-8 decoder. Chunk boundaries may split a multi-byte character,
 * and TextDecoder is not guaranteed on older base libraries — both handled
 * here: the native decoder runs in stream mode, the fallback buffers
 * incomplete byte sequences and emits replacement characters for broken ones.
 */
function createTextDecoder() {
  if (typeof TextDecoder === 'function') {
    try {
      const native = new TextDecoder('utf-8');
      return {
        decode(bytes, final) { return native.decode(bytes, { stream: !final }); },
      };
    } catch (error) { /* fall through to the manual decoder */ }
  }

  let pending = [];
  function fromCodePoints(points) {
    let text = '';
    for (let i = 0; i < points.length; i += 4096) {
      text += String.fromCharCode.apply(null, points.slice(i, i + 4096));
    }
    return text;
  }
  return {
    decode(bytes, final) {
      const all = pending.length ? pending.concat(Array.prototype.slice.call(bytes)) : Array.prototype.slice.call(bytes);
      pending = [];
      const points = [];
      let i = 0;
      while (i < all.length) {
        const lead = all[i];
        let length;
        let point;
        if (lead < 0x80) { length = 1; point = lead; }
        else if (lead >= 0xc2 && lead < 0xe0) { length = 2; point = lead & 0x1f; }
        else if (lead >= 0xe0 && lead < 0xf0) { length = 3; point = lead & 0x0f; }
        else if (lead >= 0xf0 && lead < 0xf5) { length = 4; point = lead & 0x07; }
        else { length = 1; point = 0xfffd; }
        if (i + length > all.length) {
          if (!final) { pending = all.slice(i); break; }
          point = 0xfffd;
        } else {
          for (let j = 1; j < length; j += 1) {
            const continuation = all[i + j];
            if ((continuation & 0xc0) !== 0x80) { length = 0; point = 0xfffd; break; }
            point = (point << 6) | (continuation & 0x3f);
          }
          if (length === 4) {
            // Encode as a surrogate pair; BMP points pass through unchanged.
            const offset = point - 0x10000;
            points.push(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff));
            i += length;
            continue;
          }
        }
        points.push(point);
        i += Math.max(length, 1);
      }
      if (final && pending.length) { points.push(0xfffd); pending = []; }
      return fromCodePoints(points);
    },
  };
}

function parseEvent(block) {
  let event = 'message';
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.charAt(0) === ':') continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.charAt(0) === ' ') value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0) return undefined;
  return { event, data: data.join('\n') };
}

/** Incremental SSE parser: feed decoded text, emit complete events. */
function createSseParser(onEvent) {
  let buffer = '';
  return {
    feed(text) {
      buffer = (buffer + text).replace(/^\uFEFF/, '');
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary >= 0) {
        const separator = (buffer.slice(boundary).match(/^\r?\n\r?\n/) || ['\n\n'])[0];
        const event = parseEvent(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + separator.length);
        if (event) onEvent(event);
        boundary = buffer.search(/\r?\n\r?\n/);
      }
    },
    flush() {
      const event = parseEvent(buffer.trim());
      buffer = '';
      if (event) onEvent(event);
    },
  };
}

function readPayload(raw) {
  try { return JSON.parse(raw); } catch (error) { return undefined; }
}

function buildSearchBody(keyword, userChannels) {
  const body = { kw: keyword };
  // `[]` is truthy in JavaScript, but an empty list is invalid for the
  // server's custom-channel mode. Omit it for normal site searches.
  if (Array.isArray(userChannels) && userChannels.length) body.channels = userChannels;
  return body;
}

/**
 * POST /api/search as a chunked SSE stream.
 *
 * Callbacks:
 *   onStart(data)     — { intervalMs, searchLogId }
 *   onUpdate(update)  — { results }（对外报文不含 sourceId，来源目录不下发）
 *   onComplete(info)  — { total }
 *   onError(error)    — Error with a user-facing message
 *   onAbort()         — the caller aborted (pause)
 *
 * Returns { abort() }. An expired token is refreshed once automatically.
 */
function searchStream(options) {
  const { keyword, userChannels, onStart, onUpdate, onComplete, onError, onAbort } = options;
  let aborted = false;
  let refreshing = false;
  let task = null;
  let settled = false;
  let abortNotified = false;

  function notifyAbort() {
    if (abortNotified) return;
    abortNotified = true;
    if (onAbort) onAbort();
  }

  function settleError(error) {
    if (settled || aborted) return;
    settled = true;
    if (onError) onError(error instanceof Error ? error : new Error(String(error)));
  }

  function run(attempt) {
    // First attempt waits for the silent login so a search fired right after
    // launch still carries a Bearer token; login failure falls back to
    // anonymous (search works without a session on the server).
    const ready = attempt === 0 ? auth.ensureLogin().catch(() => undefined) : Promise.resolve();
    ready.then(() => {
      if (settled || aborted) return;
      issueRequest(attempt);
    });
  }

  function issueRequest(attempt) {
    const session = auth.getSession();
    const header = { 'content-type': 'application/json', Accept: 'text/event-stream' };
    if (session && session.token) header.Authorization = `Bearer ${session.token}`;

    // The mere presence of `channels` selects custom-channel mode on the server;
    // the authoritative list is always read from the account there.
    const body = buildSearchBody(keyword, userChannels);

    const decoder = createTextDecoder();
    const parser = createSseParser((event) => {
      const payload = readPayload(event.data);
      if (!payload) return;
      if (event.event === 'result') {
        if (payload.results && onUpdate) onUpdate(payload);
      } else if (event.event === 'start') {
        if (onStart) onStart(payload || {});
      } else if (event.event === 'complete') {
        if (settled) return;
        settled = true;
        if (onComplete) onComplete(payload || {});
      } else if (event.event === 'error') {
        settleError(new Error((payload && payload.message) || '搜索失败，请稍后重试'));
      }
    });

    let rawBody = '';

    task = wx.request({
      url: `${API_BASE}/api/search`,
      method: 'POST',
      data: body,
      header,
      timeout: SEARCH_TIMEOUT,
      enableChunked: true,
      success(response) {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          if (settled) return;
          // Stream ended without a complete/error event.
          settleError(new Error('搜索流在完成事件前中断，请重试'));
          return;
        }
        if (response.statusCode === 401 && attempt === 0) {
          refreshing = true;
          auth.clearSession();
          auth.login()
            .then(() => { refreshing = false; run(1); })
            .catch((error) => { refreshing = false; settleError(error); });
          return;
        }
        const detail = response.data && typeof response.data === 'object'
          ? response.data
          : readPayload(rawBody);
        const message = (detail && (detail.statusMessage || detail.message)) || HTTP_MESSAGES[response.statusCode] || `搜索请求失败 (${response.statusCode})`;
        settleError(new Error(message));
      },
      fail(result) {
        if (aborted && !refreshing) {
          notifyAbort();
          return;
        }
        if (refreshing) return;
        settleError(new Error(result && result.errMsg && result.errMsg.indexOf('timeout') >= 0 ? '搜索超时，请稍后重试' : '网络请求失败，请稍后重试'));
      },
    });

    if (typeof task.onChunkReceived !== 'function') {
      settleError(new Error('当前微信版本不支持流式搜索，请升级微信后重试'));
      return;
    }

    task.onChunkReceived((chunk) => {
      const bytes = chunk && (chunk.data || chunk.arrayBuffer);
      if (!bytes) return;
      const text = decoder.decode(new Uint8Array(bytes), false);
      rawBody += text;
      if (!settled) parser.feed(text);
    });
  }

  run(0);

  return {
    abort() {
      if (settled) return;
      aborted = true;
      if (task && task.abort) task.abort();
      if (refreshing) notifyAbort();
      // The request may still be waiting for the pre-search login; surface the
      // pause directly instead of relying on a fail callback that never comes.
      else if (!task) notifyAbort();
    },
  };
}

module.exports = { searchStream, buildSearchBody, createTextDecoder, createSseParser };
