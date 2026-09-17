import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from 'jiti';

/**
 * Priority is a queue position, not a rank: the smaller the value, the earlier
 * the source enters the search queue. 0 runs first.
 */
const directory = mkdtempSync(join(tmpdir(), 'panhub-priority-'));
process.env.PANHUB_SQLITE_DB = join(directory, 'priority.sqlite');
// Nuxt injects useRuntimeConfig as a global auto-import; the catalog reads it
// for the system-settings bootstrap, which falls back to SQLite anyway.
// The cast is load-bearing: with allowJs, TypeScript turns a direct
// `globalThis.useRuntimeConfig = …` (or an Object.defineProperty on globalThis)
// into a global declaration, which narrows the Nuxt auto-import to `() => {}`
// for every file in the project and makes vue-tsc report 12 bogus errors.
const globals = /** @type {any} */ (globalThis);
globals.useRuntimeConfig = () => ({});

const jiti = createJiti(import.meta.url);
const catalog = await jiti.import('../server/core/services/sourceCatalog.ts');
const { SearchService } = await jiti.import('../server/core/services/searchService.ts');

/** Only the fields the catalog validates; the transform is a no-op stub. */
function definition(id, priority, overrides = {}) {
  return {
    id,
    name: overrides.name ?? id,
    description: '',
    url: `https://example.invalid/${id}?q={{keyword}}`,
    method: 'GET',
    format: 'json',
    priority,
    enabled: true,
    transform: 'return []',
    ...overrides,
  };
}

function ids(sources) {
  return sources.map((source) => source.id);
}

test('source priority', async (t) => {
  await t.test('a smaller priority value is queued before a larger one', () => {
    // Inserted in ascending order so the assertion cannot pass by accident.
    catalog.saveUnifiedSource(definition('low', 1));
    catalog.saveUnifiedSource(definition('mid', 50));
    catalog.saveUnifiedSource(definition('high', 999));

    assert.deepEqual(ids(catalog.listUnifiedSources()), ['low', 'mid', 'high']);
  });

  await t.test('equal priorities fall back to catalog order (name, then id)', () => {
    catalog.saveUnifiedSource(definition('zulu', 7, { name: '同名' }));
    catalog.saveUnifiedSource(definition('alpha', 7, { name: '同名' }));
    catalog.saveUnifiedSource(definition('bravo', 7, { name: 'A 名' }));

    const same = catalog.listUnifiedSources().filter((source) => source.priority === 7);
    assert.deepEqual(ids(same), ['bravo', 'alpha', 'zulu']);
  });

  await t.test('priority is normalized to a 0-999 integer', () => {
    assert.equal(catalog.saveUnifiedSource(definition('overflow', 5000)).priority, 999);
    assert.equal(catalog.saveUnifiedSource(definition('negative', -20)).priority, 0);
    assert.equal(catalog.saveUnifiedSource(definition('fraction', 3.9)).priority, 3);
    assert.equal(catalog.saveUnifiedSource(definition('garbage', Number.NaN)).priority, 0);
  });

  await t.test('the execution queue follows priority, not the request order', () => {
    const service = new SearchService({ defaultConcurrency: 4, cacheTtlMinutes: 5 });
    // resolveSources is the queue builder: it sorts, dedupes and drops disabled
    // sources. Reached directly because the scheduling itself is covered by
    // p-limit and would need live HTTP to observe.
    const resolve = (sources, ephemeral = []) => service.resolveSources(sources, ephemeral);

    const queued = resolve([
      definition('third', 10),
      definition('first', 900),
      definition('second', 100),
    ]);
    assert.deepEqual(ids(queued), ['third', 'second', 'first']);

    const filtered = resolve([
      definition('enabled', 5),
      definition('disabled', 900, { enabled: false }),
    ]);
    assert.deepEqual(ids(filtered), ['enabled']);

    const deduped = resolve([definition('dup', 5), definition('dup', 5)]);
    assert.deepEqual(ids(deduped), ['dup']);
  });

  await t.test('catalog order survives the queue builder for equal priorities', () => {
    const service = new SearchService({ defaultConcurrency: 4, cacheTtlMinutes: 5 });
    const configured = catalog.listUnifiedSources();

    assert.deepEqual(ids(service.resolveSources(configured)), ids(configured));
  });

  await t.test('channel sources keep the caller order and obey the same rule', () => {
    const service = new SearchService({ defaultConcurrency: 4, cacheTtlMinutes: 5 });
    const channels = [definition('channel-a', 0), definition('channel-b', 0)];

    assert.deepEqual(ids(service.resolveSources([], channels)), ['channel-a', 'channel-b']);
    // Channel mode is exclusive in production, but a channel still outranks a
    // configured source that carries a larger priority value.
    assert.deepEqual(
      ids(service.resolveSources([definition('configured', 5)], channels)),
      ['channel-a', 'channel-b', 'configured'],
    );
  });
});
