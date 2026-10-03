import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLink } from '../utils/linkResolution.ts';

test('slow operations report real stages and poll one request beyond the old client budget', async () => {
  const fetchBefore = globalThis.fetch;
  const nowBefore = Date.now;
  let now = nowBefore();
  Date.now = () => now;
  const requests = [], stages = [];
  globalThis.fetch = async (url, options) => {
    requests.push([url, options.method]);
    if (options.method === 'POST') {
      now += 80000;
      return new Response(JSON.stringify({ data: { status: 'processing', stage: 'sharing', pollAfterMs: 500 } }), { status: 202 });
    }
    return new Response(JSON.stringify({ data: { status: 'completed', url: 'https://example.test/share' } }));
  };
  try {
    const value = await resolveLink('result', 'link', 'stable', new AbortController().signal, false, progress => stages.push(progress.stage));
    assert.equal(value.status, 'completed');
    assert.deepEqual(stages, ['sharing']);
    assert.deepEqual(requests, [['/api/links/resolve', 'POST'], ['/api/links/resolve-operations/stable', 'GET']]);
  } finally { globalThis.fetch = fetchBefore; Date.now = nowBefore; }
});

test('aborting progress polling stops promptly without another write', async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ data: { status: 'processing', stage: 'transferring' } }), { status: 202 });
  };
  try {
    await assert.rejects(resolveLink('r', 'l', 'key', controller.signal, false, () => controller.abort()), /停止查询/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
