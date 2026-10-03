import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MONITOR_WORKERS, workerSchedulingEnabled, workerLabel, sourceLabel, sourceTone, sourceSuccessRate, monitorAlerts, lastSourceRequest, monitorQueueRows, deliveryTotal } from '../components/monitor/monitorView.ts';

test('worker cards target the appropriate scheduler and management page', () => {
  assert.equal(MONITOR_WORKERS.crawl.endpoint, 'crawl');
  assert.equal(MONITOR_WORKERS.crawl.path, '/admin/crawl');
  assert.equal(MONITOR_WORKERS.links.endpoint, 'link-schedule');
  assert.equal(MONITOR_WORKERS.links.path, '/admin/tasks');
  const worker = { state: 'online', count: 1, enabled: false, scheduleEnabled: true };
  assert.equal(workerSchedulingEnabled('crawl', worker), false);
  assert.equal(workerSchedulingEnabled('links', worker), true, 'cleanup pause must not become global scheduling pause');
  assert.equal(workerSchedulingEnabled('links', { ...worker, enabled: true, scheduleEnabled: false }), false);
  assert.equal(workerSchedulingEnabled('links', { ...worker, scheduleEnabled: undefined }), undefined);
  assert.equal(workerSchedulingEnabled('crawl'), undefined);
});

test('worker presence and scheduling switch are distinct states', () => {
  assert.equal(workerLabel({ state: 'online', count: 1, enabled: false }), '已暂停调度');
  assert.equal(workerLabel({ state: 'offline', count: 0, enabled: true }), '未检测到在线 Worker');
  assert.equal(workerLabel({ state: 'unknown', count: null, enabled: true }), '状态不可用');
});
test('zero-result success stays successful and disabled source stays disabled', () => {
  const source = { enabled: true, health: { requestCount: 1, healthy: true, zeroResultCount: 1 } };
  assert.equal(sourceLabel(source), '最近请求成功');
  assert.equal(sourceLabel({ ...source, enabled: false }), '已停用');
  assert.equal(sourceLabel({ enabled: true, health: null }), '暂无请求记录');
  assert.equal(sourceLabel({ ...source, health: { ...source.health, circuitState: 'open' } }), '已熔断');
});
test('paused cleanup warns about overdue work without calling an idle worker offline', () => {
  const data = {
    workers: { crawl: { state: 'online', enabled: true }, links: { state: 'online', enabled: false } },
    crawl: { expired: 0 }, links: { cleanupDue: 3, queues: { cleanup: { blocked: 2 } } },
  };
  const alerts = monitorAlerts(data);
  assert.equal(alerts.length, 2);
  assert.ok(alerts.some(v => v.includes('3 个到期清理')));
  assert.ok(alerts.some(v => v.includes('2 个清理任务被阻塞')));
  assert.ok(!alerts.some(v => v.includes('没有在线')));
});
test('source timestamps accept historical millisecond and ISO formats', () => {
  assert.equal(lastSourceRequest({ health: null }), '暂无记录');
  assert.equal(lastSourceRequest({ health: { lastSuccessAt: 'bad' } }), '暂无记录');
  assert.equal(lastSourceRequest({ health: { lastSuccessAt: '2026-09-30T01:00:00Z', lastFailureAt: 1790737200000 } }), lastSourceRequest({ health: { lastSuccessAt: '2026-09-30T03:00:00Z' } }));
});
test('source health distinguishes failed, unknown, disabled and zero-result success', () => {
  const source = { enabled: true, health: { requestCount: 10, successCount: 9, healthy: true, zeroResultCount: 7 } };
  assert.equal(sourceTone(source), 'ok');
  assert.equal(sourceSuccessRate(source), '90.0');
  assert.equal(sourceTone({ ...source, enabled: false }), 'muted');
  assert.equal(sourceTone({ ...source, health: { ...source.health, healthy: false } }), 'error');
  assert.equal(sourceTone({ ...source, health: { ...source.health, circuitState: 'open' } }), 'error');
  assert.equal(sourceTone({ enabled: true, health: null }), 'muted');
  assert.equal(sourceSuccessRate({ enabled: true, health: null }), '—');
  assert.equal(sourceSuccessRate({ enabled: true, health: { requestCount: 0, successCount: 0 } }), '—');
  assert.equal(sourceSuccessRate({ enabled: true, health: { requestCount: 2 } }), '—');
  assert.equal(sourceSuccessRate({ enabled: true, health: { requestCount: 2, successCount: 3 } }), '100.0');
});
test('local link sync never borrows click-delivery queue statistics', () => {
  const data = {
    crawl: { queued: 0, running: 0, failed: 0 },
    links: {
      syncPending: 7,
      queues: {
        checks: { queued: 0, running: 0, failed: 0, completed: 12 },
        cleanup: { queued: 2, running: 1, failed: 3, completed: 4, blocked: 5 },
        resolve: { queued: 8, running: 9, failed: 10, completed: 11 },
      },
    },
  };
  const rows = monitorQueueRows(data);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.find(row => row.key === 'sync'), { key: 'sync', label: '资源链接同步', queued: 7, running: null, failed: null, blocked: 0 });
  assert.equal(rows.find(row => row.key === 'resolve').running, 9);
  assert.equal(rows.find(row => row.key === 'cleanup').blocked, 5);
});
test('24-hour delivery total includes all completed outcomes, excludes in-flight and preserves missing data', () => {
  assert.equal(deliveryTotal({ links: {} }), null);
  assert.equal(deliveryTotal({ links: { deliveryStats: { processing: 99, transferred: 10, reused: 5, fallback: 3, direct: 2, unavailable: 1 } } }), 21);
  assert.equal(deliveryTotal({ links: { deliveryStats: { processing: 0, transferred: 0, reused: 0, fallback: 0, direct: 0, unavailable: 0 } } }), 0);
});
test('monitor puts queues and attention before secondary source health', async () => {
  const page = await readFile(new URL('../components/monitor/MonitorPanel.vue', import.meta.url), 'utf8');
  const sections = ['aria-label="服务运行状态"', 'aria-label="采集与处理成果"', 'aria-label="任务队列与需要关注"', 'aria-label="实时来源健康"'];
  const positions = sections.map(section => page.indexOf(section));
  assert.ok(positions.every(position => position >= 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.match(page, /\.service-grid\s*\{[^}]*repeat\(5,/);
  assert.match(page, /class="service-card[^"]*" role="article"/);
  assert.ok(page.includes('data.links.queues.checks.completed'));
  assert.ok(page.includes('data.crawl.resources'));
});
