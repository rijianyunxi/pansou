import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

async function loadMonitorView() {
  const source = await readFile(new URL('../components/monitor/monitorView.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)({}, module, module.exports);
  return module.exports;
}

test('check task rows map validity to labels, tones and error copy', async () => {
  const view = await loadMonitorView();
  const data = { links: { recentCheckFailures: [
    { provider: 'quark', identity: 'https://pan.quark.cn/s/abc', validity: 0, failureCount: 3, lastErrorCode: 'share_cancelled', lastAttemptAt: '2026-10-01T07:00:00Z', nextCheckAt: null },
    { provider: 'baidu', identity: null, validity: -1, failureCount: 1, lastErrorCode: null, lastAttemptAt: null, nextCheckAt: '2026-10-01T08:00:00Z' },
  ] } };
  const rows = view.checkTaskRows(data);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].provider, '夸克网盘');
  assert.equal(rows[0].identity, 'https://pan.quark.cn/s/abc');
  assert.equal(rows[0].stateLabel, '失效');
  assert.equal(rows[0].tone, 'error');
  assert.equal(rows[0].error, 'share_cancelled');
  assert.equal(rows[0].attempts, 3);
  assert.match(rows[0].time, /最近尝试/);
  assert.equal(rows[1].provider, '百度网盘');
  assert.equal(rows[1].identity, '未知链接');
  assert.equal(rows[1].stateLabel, '待重检');
  assert.equal(rows[1].tone, 'warn');
  assert.equal(rows[1].error, '');
  assert.equal(view.checkTaskRows({ links: {} }).length, 0, 'missing field must degrade to no rows');
});

test('cleanup task rows map status to labels and tones', async () => {
  const view = await loadMonitorView();
  const data = { links: { recentCleanup: [
    { status: 'completed', stage: null, lastErrorCode: null, attempts: 1, provider: 'quark', updatedAt: '2026-10-01T06:00:00Z' },
    { status: 'blocked', stage: 'verify', lastErrorCode: 'ownership_verification_required', attempts: 5, provider: null, updatedAt: '2026-10-01T06:30:00Z' },
  ] } };
  const rows = view.cleanupTaskRows(data);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].provider, '夸克网盘');
  assert.equal(rows[0].stateLabel, '已完成');
  assert.equal(rows[0].tone, 'ok');
  assert.equal(rows[0].error, '');
  assert.equal(rows[1].provider, '—');
  assert.equal(rows[1].identity, 'verify');
  assert.equal(rows[1].stateLabel, '已阻塞');
  assert.equal(rows[1].tone, 'error');
  assert.equal(rows[1].error, 'ownership_verification_required');
  assert.equal(view.cleanupTaskRows({ links: {} }).length, 0);
});

test('stuck check jobs raise an alert and stay quiet when healthy', async () => {
  const view = await loadMonitorView();
  const base = {
    workers: {
      crawl: { state: 'online', count: 1, enabled: true },
      links: { state: 'online', count: 1, enabled: true },
    },
    crawl: { expired: 0 },
    links: { queues: { cleanup: { blocked: 0 } }, cleanupDue: 0 },
  };
  const stuck = { ...base, links: { ...base.links, checkHealth: { due: 0, failing: 0, unknown: 0, stuckJobs: 2 } } };
  assert.ok(view.monitorAlerts(stuck).some((alert) => alert.includes('租约过期')));
  assert.ok(!view.monitorAlerts(base).some((alert) => alert.includes('租约过期')), 'no alert without checkHealth field');
});
