import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from 'jiti';

const directory = mkdtempSync(join(tmpdir(), 'panhub-core-'));
process.env.PANHUB_SQLITE_DB = join(directory, 'core.sqlite');

const jiti = createJiti(import.meta.url);
const { getSqliteDatabase, SqliteDatabase } = await jiti.import('../server/core/storage/sqlite.ts');
const resources = await jiti.import('../server/core/services/managedResourceService.ts');
const healthStore = await jiti.import('../server/core/services/sourceHealthStore.ts');
const redaction = await jiti.import('../server/core/utils/redaction.ts');
const configuredSource = await jiti.import('../server/core/services/configuredSource.ts');
const keywords = await jiti.import('../server/core/utils/searchKeyword.ts');
const merge = await jiti.import('../server/core/utils/resultMerge.ts');
const { MemoryCache } = await jiti.import('../server/core/cache/memoryCache.ts');
const hotSearchStore = await jiti.import('../server/core/services/sqliteHotSearchStore.ts');
const adminHotSearch = await jiti.import('../server/core/services/adminHotSearchService.ts');

const db = getSqliteDatabase();

function seed(count) {
  const timestamp = Date.now();
  for (let index = 0; index < count; index += 1) {
    db.run(
      "INSERT INTO managed_resources(id,name,description,datetime,cloud_types_json,links_json,tags_json,images_json,search_text,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      `res-${String(index).padStart(5, '0')}`,
      `三体 第${index}集 1080p`,
      `刘慈欣 科幻 描述 ${index}`,
      null,
      '["quark"]',
      '[{"type":"quark","url":"https://pan.quark.cn/s/abc","password":null}]',
      '["科幻"]',
      '[]',
      keywords.normalizeSearchKeyword(`三体 第${index}集 1080p 刘慈欣 科幻 描述 ${index} 科幻`),
      timestamp,
      timestamp + index,
    );
  }
}

/** The SQL predicate the search path applies, evaluated in JS over every row. */
function variantsOf(keyword) {
  return keywords.buildSearchKeywordVariants(keyword)
    .map((variant) => keywords.normalizeSearchKeyword(variant))
    .filter((variant, index, all) => variant.length >= 2 && all.indexOf(variant) === index);
}

function matchingIds(keyword) {
  const variants = variantsOf(keyword);
  if (!variants.length) return [];
  return db.allRows('SELECT id, search_text FROM managed_resources WHERE enabled = 1 ORDER BY id')
    .filter((row) => variants.some((variant) => row.search_text.includes(variant)))
    .map((row) => row.id);
}

/** A stand-in for the resource shape, with only the fields the merge rules read. */
function resource(id, links, extra = {}) {
  return {
    id,
    name: id,
    description: null,
    datetime: null,
    cloud_types: [...new Set(links.map((link) => link.type))],
    links,
    ...extra,
  };
}

const quark = (url) => ({ type: 'quark', url, password: null });
const baidu = (url) => ({ type: 'baidu', url, password: 'abcd' });

/**
 * Reproduce what an SSE client ends up with: each delta is filtered to links the
 * client has not seen, then merged into the accumulated state by result id. This
 * is the behaviour `composables/useSearch.ts` plus `createDeltaFilter` implement,
 * written independently of the batch merge under test.
 */
function clientState(deltas) {
  const claimed = new Set();
  const byId = new Map();
  for (const delta of deltas) {
    for (const result of delta) {
      const freshLinks = result.links.filter((link) => {
        const key = merge.linkIdentity(link);
        if (claimed.has(key)) return false;
        claimed.add(key);
        return true;
      });
      if (!freshLinks.length) continue;
      const incoming = { ...result, links: freshLinks, cloud_types: [...new Set(freshLinks.map((link) => link.type))] };
      const current = byId.get(incoming.id);
      byId.set(incoming.id, current ? merge.mergeSameResult(current, incoming) : incoming);
    }
  }
  return [...byId.values()];
}

test('server/core optimizations', async (t) => {
  seed(1200);

  await t.test('managed resource search returns exactly the matching rows', () => {
    for (const keyword of ['三体', '三体 第9集', '不存在的关键词', '科幻', '刘慈欣', '第1集 1080p']) {
      const expected = matchingIds(keyword);
      const actual = resources.searchManagedResources(keyword).map((item) => item.id);
      assert.equal(actual.length, Math.min(expected.length, 100), `count mismatch for ${keyword}`);
      assert.equal(new Set(actual).size, actual.length, `duplicate rows for ${keyword}`);
      assert.ok(actual.every((id) => expected.includes(id)), `non-matching row for ${keyword}`);
    }
  });

  await t.test('the result cap keeps the most relevant matches', () => {
    // "三体" alone matches every row, but only res-00001 carries the cleaned
    // keyword verbatim. That row is also the second oldest, so a plain
    // `updated_at DESC` ordering would have pushed it far outside the cap.
    const results = resources.searchManagedResources('三体 第1集');
    assert.equal(results.length, 100);
    assert.equal(results[0].id, 'res-00001');
    assert.ok(matchingIds('三体 第1集').length > 100, 'the keyword must overflow the cap');
  });

  await t.test('search caps results and stays reusable after an early break', () => {
    const first = resources.searchManagedResources('三体');
    assert.equal(first.length, 100);
    // Reusing the same cached statement after breaking out of the iterator must
    // not leave it busy.
    const second = resources.searchManagedResources('三体');
    assert.deepEqual(second.map((item) => item.id), first.map((item) => item.id));
  });

  await t.test('cached results are not shared with callers', () => {
    const first = resources.searchManagedResources('三体');
    first[0].links[0].url = 'https://pan.quark.cn/s/mutated';
    first[0].cloud_types.push('baidu');
    const second = resources.searchManagedResources('三体');
    assert.equal(second[0].links[0].url, 'https://pan.quark.cn/s/abc');
    assert.deepEqual(second[0].cloud_types, ['quark']);
  });

  await t.test('iterate streams without materializing every row', () => {
    const seen = [];
    for (const row of db.iterate('SELECT id FROM managed_resources ORDER BY id')) {
      seen.push(row.id);
      if (seen.length === 3) break;
    }
    assert.deepEqual(seen, ['res-00000', 'res-00001', 'res-00002']);
  });

  await t.test('prepared statement cache stays bounded', () => {
    for (let size = 1; size <= 400; size += 1) {
      const placeholders = Array.from({ length: size }, () => '?').join(',');
      db.allRows(`SELECT id FROM managed_resources WHERE id IN (${placeholders})`, ...Array.from({ length: size }, (_, index) => `res-${index}`));
    }
    assert.ok(db.statements.size <= 256, `cache grew to ${db.statements.size}`);
    assert.equal(resources.searchManagedResources('三体').length, 100);
  });

  await t.test('a source result keeps the links local resources do not already own', () => {
    const local = [resource('local-1', [quark('https://pan.quark.cn/s/a')])];
    const source = [resource('src-9', [quark('https://pan.quark.cn/s/a'), baidu('https://pan.baidu.com/s/1b')])];
    const merged = merge.mergeLocalResources(local, source);
    // Dropping the whole result here used to lose the baidu link from the JSON
    // body while the streamed view still delivered it.
    assert.deepEqual(merged.map((item) => item.id), ['local-1', 'src-9']);
    assert.deepEqual(merged[1].links.map((link) => link.url), ['https://pan.baidu.com/s/1b']);
    assert.deepEqual(merged[1].cloud_types, ['baidu']);
  });

  await t.test('one share link is claimed once across sources', () => {
    const merged = merge.mergeResultsByIdentity([
      resource('a', [quark('https://pan.quark.cn/s/dup')]),
      resource('b', [quark('https://pan.quark.cn/s/dup')]),
    ]);
    assert.deepEqual(merged.map((item) => item.id), ['a']);
  });

  await t.test('results sharing an id merge their links instead of dropping the later source', () => {
    const merged = merge.mergeResultsByIdentity([
      resource('same', [quark('https://pan.quark.cn/s/a')]),
      resource('same', [baidu('https://pan.baidu.com/s/1b')], { description: '补充描述' }),
    ]);
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0].cloud_types, ['quark', 'baidu']);
    assert.equal(merged[0].links.length, 2);
    assert.equal(merged[0].description, '补充描述');
  });

  await t.test('a result whose links are all claimed disappears', () => {
    const merged = merge.mergeLocalResources(
      [resource('local-1', [quark('https://pan.quark.cn/s/a')])],
      [resource('src-9', [quark('https://pan.quark.cn/s/a')])],
    );
    assert.deepEqual(merged.map((item) => item.id), ['local-1']);
  });

  await t.test('the streamed view and the merged view describe the same search', () => {
    const local = [resource('local-1', [quark('https://pan.quark.cn/s/a')])];
    const source = [
      resource('src-9', [quark('https://pan.quark.cn/s/a'), baidu('https://pan.baidu.com/s/1b')]),
      resource('src-10', [quark('https://pan.quark.cn/s/dup')]),
      resource('src-11', [quark('https://pan.quark.cn/s/dup')]),
    ];
    const shape = (list) => list.map((item) => [item.id, item.links.map((link) => link.url)]);
    assert.deepEqual(shape(merge.mergeLocalResources(local, source)), shape(clientState([local, source])));
  });

  await t.test('the console list and the search path match the same keywords', () => {
    const timestamp = Date.now();
    const insert = (id, name) => db.run(
      "INSERT INTO managed_resources(id,name,description,datetime,cloud_types_json,links_json,tags_json,images_json,search_text,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,1,?,?)",
      id, name, null, null, '["quark"]',
      `[{"type":"quark","url":"https://pan.quark.cn/s/${id}","password":null}]`,
      '[]', '[]', keywords.normalizeSearchKeyword(name), timestamp, timestamp,
    );
    insert('probe-1', '流浪地球 2 1080p');
    insert('probe-2', '流浪地球 2 4K');

    const listed = (keyword) => resources.listManagedResources({ q: keyword, page: 1, pageSize: 500 }).items.map((item) => item.id).sort();
    const searched = (keyword) => resources.searchManagedResources(keyword).map((item) => item.id).sort();
    for (const keyword of ['流浪地球', '流浪地球 2 1080p', '流浪地球 2 4K', '流浪地球 4K', '不存在的关键词']) {
      assert.deepEqual(listed(keyword), searched(keyword), `mismatch for ${keyword}`);
    }
    // The regression this guards: the console matched the raw query against the
    // raw columns, so the noise suffix made an otherwise findable resource
    // invisible to the operator.
    assert.deepEqual(listed('流浪地球 2 1080p'), ['probe-1', 'probe-2']);
  });

  await t.test('disabling a resource hides it from search without deleting it', () => {
    assert.equal(resources.searchManagedResources('流浪地球').length, 2);
    assert.equal(resources.setManagedResourcesEnabled(['probe-1'], false), 1);
    assert.equal(resources.setManagedResourcesEnabled(['probe-1'], false), 0, 'a repeated flip changes nothing');
    assert.deepEqual(resources.searchManagedResources('流浪地球').map((item) => item.id), ['probe-2']);

    const page = resources.listManagedResources({ q: '流浪地球', page: 1, pageSize: 20 });
    assert.deepEqual(page.items.map((item) => item.id), ['probe-1', 'probe-2'], 'the console still lists disabled rows');
    assert.equal(page.items.find((item) => item.id === 'probe-1').enabled, false);
    assert.equal(page.items.find((item) => item.id === 'probe-2').enabled, true);

    assert.equal(resources.setManagedResourcesEnabled(['probe-1'], true), 1);
    assert.equal(resources.searchManagedResources('流浪地球').length, 2);
  });

  await t.test('writes invalidate cached keyword results', () => {
    assert.equal(resources.searchManagedResources('流浪地球').length, 2);
    const created = resources.createManagedResource({ name: '流浪地球 3', links: [quark('https://pan.quark.cn/s/new')] });
    assert.equal(resources.searchManagedResources('流浪地球').length, 3);
    resources.updateManagedResource(created.id, { name: '球状闪电', links: [quark('https://pan.quark.cn/s/new')] });
    assert.equal(resources.searchManagedResources('流浪地球').length, 2);
    assert.equal(resources.deleteManagedResources([created.id]), 1);
    assert.equal(resources.searchManagedResources('流浪地球').length, 2);
  });

  await t.test('health snapshots are batched into one flush', () => {
    const status = (name) => ({ name, isHealthy: true, circuitState: 'closed', failureCount: 0, totalFailureCount: 0, successCount: 1, requestCount: 1, zeroResultCount: 0, resultCount: 1, parsingSuccessRate: 1, slowRequestCount: 0, errorCounts: {} });
    for (const id of ['alpha', 'beta', 'gamma']) healthStore.queueSourceHealthStatus(id, status(id));
    assert.equal(db.getRow('SELECT COUNT(*) AS count FROM source_health').count, 0, 'queued writes must not touch the database');
    assert.equal(healthStore.flushSourceHealthStatuses(), 3);
    assert.equal(db.getRow('SELECT COUNT(*) AS count FROM source_health').count, 3);
    assert.equal(JSON.parse(db.getRow('SELECT snapshot_json FROM source_health WHERE source_id = ?', 'beta').snapshot_json).name, 'beta');
    assert.equal(healthStore.flushSourceHealthStatuses(), 0, 'a second flush has nothing to write');
  });

  await t.test('single writes and deletes still work', () => {
    healthStore.saveSourceHealthStatus('delta', { name: 'delta', isHealthy: true, circuitState: 'closed' });
    assert.ok(db.getRow('SELECT 1 FROM source_health WHERE source_id = ?', 'delta'));
    healthStore.deleteSourceHealthStatus('delta');
    assert.equal(db.getRow('SELECT 1 FROM source_health WHERE source_id = ?', 'delta'), undefined);
  });

  await t.test('pruning drops pending writes for removed sources', () => {
    healthStore.queueSourceHealthStatus('alpha', { name: 'alpha', isHealthy: true, circuitState: 'closed' });
    healthStore.queueSourceHealthStatus('ghost', { name: 'ghost', isHealthy: true, circuitState: 'closed' });
    healthStore.pruneSourceHealthStatuses(['alpha', 'beta', 'gamma']);
    healthStore.flushSourceHealthStatuses();
    assert.ok(db.getRow('SELECT 1 FROM source_health WHERE source_id = ?', 'alpha'));
    assert.equal(db.getRow('SELECT 1 FROM source_health WHERE source_id = ?', 'ghost'), undefined);
  });

  await t.test('clearing drops every pending write', () => {
    healthStore.queueSourceHealthStatus('pending-only', { name: 'pending-only', isHealthy: true, circuitState: 'closed' });
    healthStore.clearSourceHealthStatuses();
    healthStore.flushSourceHealthStatuses();
    assert.equal(db.getRow('SELECT COUNT(*) AS count FROM source_health').count, 0);
  });

  await t.test('redaction masks credentials without over-matching', () => {
    assert.equal(redaction.isSensitiveKey('authorization'), true);
    assert.equal(redaction.isSensitiveKey('access_key'), true);
    assert.equal(redaction.isSensitiveKey('key'), true);
    assert.equal(redaction.isSensitiveKey('keywords'), false);
    assert.equal(redaction.isSensitiveKey('monkey'), false);
    assert.equal(redaction.redactSensitiveUrl('https://example.com/s?token=abc&q=三体&key=xyz'), 'https://example.com/s?token=%5BREDACTED%5D&q=%E4%B8%89%E4%BD%93&key=%5BREDACTED%5D');
    assert.deepEqual(redaction.redactSensitiveHeaders({ 'x-api-key': 'secret', accept: 'application/json' }), { 'x-api-key': '[REDACTED]', accept: 'application/json' });
    assert.deepEqual(redaction.redactSensitiveValue({ a: { password: 'p', keep: 1 }, list: [{ token: 't' }] }), { a: { password: '[REDACTED]', keep: 1 }, list: [{ token: '[REDACTED]' }] });
    assert.equal(redaction.redactSensitiveUrl('not a url'), 'not a url');
  });

  await t.test('catalog rows still convert to a runtime definition', () => {
    const definition = configuredSource.toSourceDefinition({
      id: 'demo', name: '演示', description: '', url: 'https://example.com/api?q={{keyword}}',
      method: 'GET', format: 'json', priority: 3, transform: 'return []',
    });
    assert.equal(definition.schemaVersion, 1);
    assert.equal(definition.manifest.kind, 'source');
    assert.equal(definition.manifest.id, 'demo');
    assert.deepEqual(definition.request.allowedDomains, ['example.com']);
    assert.equal(definition.request.allowInsecureHttp, false);
    assert.equal(definition.response.format, 'json');
    assert.match(definition.manifest.version, /^cfg-[0-9a-f]+$/);
  });

  await t.test('sqlite wrapper still reports its path', () => {
    assert.ok(new SqliteDatabase(':memory:') instanceof SqliteDatabase);
    assert.ok(db.path.endsWith('core.sqlite'));
  });

  await t.test('cache memory capacity can shrink live and evict the oldest entries', () => {
    const cache = new MemoryCache({ maxMemoryBytes: 300 });
    cache.set('a', { value: 'a' }, 60_000);
    cache.set('b', { value: 'b' }, 60_000);
    cache.set('c', { value: 'c' }, 60_000);
    assert.equal(cache.size, 3);
    assert.equal(cache.get('a').hit, true);
    cache.setMaxMemoryBytes(100);
    assert.equal(cache.size, 1);
    assert.equal(cache.get('b').hit, false);
    assert.equal(cache.get('a').hit, true);
    assert.equal(cache.get('c').hit, false);
  });

  await t.test('hot searches are not auto-moderated but can still be blocked manually', async () => {
    const store = new hotSearchStore.SqliteHotSearchStore();
    await store.recordSearch('色情', Date.now());
    assert.ok((await store.getHotSearches(30)).some((item) => item.term === '色情'));
    assert.equal(adminHotSearch.setAdminHotSearchStatus(['色情'], 'blocked'), 1);
    assert.equal((await store.getHotSearches(30)).some((item) => item.term === '色情'), false);
    assert.equal(adminHotSearch.setAdminHotSearchStatus(['色情'], 'approved'), 1);
    assert.ok((await store.getHotSearches(30)).some((item) => item.term === '色情'));
  });
});
