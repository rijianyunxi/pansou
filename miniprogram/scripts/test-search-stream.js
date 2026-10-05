const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../utils/auth');
const { searchStream } = require('../utils/searchStream');
const flush = () => new Promise(resolve => setImmediate(resolve));

function setup(t, supported = true) {
  const oldWx = global.wx;
  const originalReady = auth.ensureSession;
  auth.ensureSession = async () => {};
  let request, chunk;
  const events = [], errors = [];
  const task = { abort() { task.aborted = true; } };
  if (supported) task.onChunkReceived = handler => { chunk = handler; };
  global.wx = { getStorageSync: () => ({ token: 'session', user: null }), request(options) { request = options; return task; } };
  t.after(() => { global.wx = oldWx; auth.ensureSession = originalReady; });
  const stream = searchStream({ keyword: 'test', onComplete: value => events.push(value), onError: error => errors.push(error.message) });
  return { events, errors, task, stream, request: () => request, feed(text) { chunk({ data: Uint8Array.from(Buffer.from(text)).buffer }); } };
}

test('SSE completion without the trailing blank line finishes on successful response', async t => {
  const fixture = setup(t);
  await flush();
  fixture.feed('event: complete\ndata: {"total":0}');
  fixture.request().success({ statusCode: 200 });
  assert.deepEqual(fixture.events, [{ total: 0 }]);
  assert.deepEqual(fixture.errors, []);
});

test('a successful unchunked response still parses SSE events', async t => {
  const fixture = setup(t);
  await flush();
  fixture.request().success({ statusCode: 200, data: 'event: complete\ndata: {"total":2}\n\n' });
  assert.deepEqual(fixture.events, [{ total: 2 }]);
  assert.deepEqual(fixture.errors, []);
});

test('a completed stream never fires completion again in request success', async t => {
  const fixture = setup(t);
  await flush();
  fixture.feed('event: complete\ndata: {"total":1}\n\n');
  fixture.request().success({ statusCode: 200, data: 'event: complete\ndata: {"total":1}\n\n' });
  assert.deepEqual(fixture.events, [{ total: 1 }]);
});

test('a stream with no completion reports the interruption', async t => {
  const fixture = setup(t);
  await flush();
  fixture.feed('event: start\ndata: {}\n\n');
  fixture.request().success({ statusCode: 200 });
  assert.deepEqual(fixture.events, []);
  assert.deepEqual(fixture.errors, ['搜索流在完成事件前中断，请重试']);
});

test('unsupported streaming aborts the request instead of leaving the search running', async t => {
  const fixture = setup(t, false);
  await flush();
  assert.equal(fixture.task.aborted, true);
  assert.deepEqual(fixture.errors, ['当前微信版本不支持流式搜索，请升级微信后重试']);
});
