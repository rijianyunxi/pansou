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

function fastWaits(t) {
  const delays=[];
  t.mock.method(globalThis,'setTimeout',(fn,ms)=>{delays.push(ms);queueMicrotask(fn);return 1;});
  t.mock.method(globalThis,'clearTimeout',()=>{});
  return delays;
}
test('a lost POST followed by missing operation replays the same key at most once',async t=>{
  fastWaits(t);const calls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    calls.push({url,method:options.method,body:options.body&&JSON.parse(options.body)});
    if(calls.length===1)throw new TypeError('network');
    if(calls.length===2)return Response.json({message:'missing'},{status:404});
    return Response.json({data:{status:'completed',url:'https://example.test/share'}});
  });
  await resolveLink('r','l','same-key',new AbortController().signal);
  assert.deepEqual(calls.map(c=>c.method),['POST','GET','POST']);
  assert.deepEqual(calls[0].body,calls[2].body);
});
test('transient read errors back off and keep polling the original operation',async t=>{
  const delays=fastWaits(t);const calls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push(options.method);return calls.length<=2?Response.json({}, {status:503}):Response.json({data:{status:'completed',url:'https://example.test/share'}});});
  await resolveLink('r','l','key',new AbortController().signal,true);
  assert.deepEqual(calls,['GET','GET','GET']);assert.deepEqual(delays,[1000,2000]);
});
test('repeated transient errors stop with a retryable message instead of an endless request loop',async t=>{
  const delays=fastWaits(t);let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw new TypeError('offline');});
  await assert.rejects(resolveLink('r','l','key',new AbortController().signal),/网络不太稳定/);
  assert.equal(calls,4);assert.deepEqual(delays,[1000,2000,4000]);
});
test('malformed responses stop promptly and do not schedule another poll',async t=>{
  const delays=fastWaits(t);t.mock.method(globalThis,'fetch',async()=>Response.json({data:null}));
  await assert.rejects(resolveLink('r','l','key',new AbortController().signal),/没有获取到链接/);assert.deepEqual(delays,[]);
});
