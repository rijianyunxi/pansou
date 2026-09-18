import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtInKeywords, stats } from './load-search.mjs';

function execute(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/load-search.mjs', ...args]);
    let output = '';
    child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
    child.on('error', reject); child.on('exit', code => resolve({ code, output }));
  });
}

test('default keyword pool is sufficient and percentiles ignore missing samples', () => {
  const words = builtInKeywords();
  assert.ok(words.length >= 1000); assert.equal(new Set(words).size, words.length);
  assert.deepEqual(stats([null, undefined, 10, 20]), { n: 2, avg: 15, p50: 10, p95: 20, p99: 20, max: 20 });
});

test('local end-to-end load: independent cookies, unique POST queries, complete/error/truncated/timeout/429/session failure', async () => {
  let sessions = 0; const searches = [], cookies = new Set();
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/account/session') {
      const id = ++sessions;
      if (id === 7) { res.writeHead(503).end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `panhub_session=test${id}; Path=/; HttpOnly` });
      res.end(JSON.stringify({ sessionId: id })); return;
    }
    if (req.url !== '/api/search') { res.writeHead(404).end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    searches.push({ method: req.method, kw: JSON.parse(body).kw }); cookies.add(req.headers.cookie);
    const id = Number(req.headers.cookie.match(/test(\d+)/)[1]);
    if (id === 2) { res.writeHead(429, { 'Retry-After': '60' }).end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: start\ndata: {"code":0}\n\n');
    if (id === 3) { res.end('event: error\ndata: {"code":-1,"message":"mock failure"}\n\n'); return; }
    if (id === 4) { res.end(); return; }
    if (id === 5) return; // Client must abort after its configured deadline.
    if (id === 6) { res.end('event: complete\ndata: {"code":0,"data":{"total":0}}\n\n'); return; }
    const wire = Buffer.from('event: result\r\ndata: {"code":0,"data":{"update":{"results":[{"title":"中文"}]}}}\r\n\r\nevent: complete\r\ndata: {"code":0,"data":{"total":1}}\r\n\r\n');
    // Each write deliberately splits the UTF-8 and CRLF framing.
    for (let i = 0; i < wire.length; i++) res.write(wire.subarray(i, i + 1));
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const output = join(mkdtempSync(join(tmpdir(), 'panhub-load-test-')), 'report');
  try {
    const result = await execute(['--url', `http://127.0.0.1:${server.address().port}`, '--duration-seconds', '1', '--users-per-minute', '420', '--timeout-seconds', '0.6', '--output', output]);
    assert.equal(result.code, 2, result.output);
    const report = JSON.parse(readFileSync(join(output, 'summary.json'), 'utf8'));
    assert.equal(sessions, 7); assert.equal(searches.length, 6); assert.equal(cookies.size, 6);
    assert.ok(searches.every(r => r.method === 'POST'));
    assert.equal(new Set(searches.map(r => r.kw)).size, 6);
    assert.equal(report.summary.success, 2); assert.equal(report.summary.empty, 1);
    assert.equal(report.summary.failed, 4); assert.equal(report.summary.timeout, 1);
    assert.equal(report.summary.firstResultMs.n, 1); assert.equal(report.summary.searches, 6);
    assert.equal(report.statuses['search HTTP 429'], 1); assert.equal(report.statuses['session HTTP 503'], 1);
    assert.equal(report.unlaunched, 0); assert.equal(report.summary.skipped, 0);
    const lines = readFileSync(join(output, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(lines.length, 7); assert.ok(lines.every(r => !JSON.stringify(r).includes('panhub_session')));
    assert.match(readFileSync(join(output, 'report.md'), 'utf8'), /搜索压测报告/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('dry-run generates exactly 1000 unique queries without sending requests', async () => {
  const output = join(mkdtempSync(join(tmpdir(), 'panhub-plan-test-')), 'plan');
  const result = await execute(['--url', 'http://127.0.0.1:1', '--dry-run', '--output', output]);
  assert.equal(result.code, 0, result.output);
  const keywords = readFileSync(join(output, 'keywords.txt'), 'utf8').trim().split('\n');
  assert.equal(keywords.length, 1000); assert.equal(new Set(keywords).size, 1000);
});
