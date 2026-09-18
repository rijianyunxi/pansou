import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from 'jiti';

const directory = mkdtempSync(join(tmpdir(), 'panhub-source-delete-'));
process.env.PANHUB_SQLITE_DB = join(directory, 'sources.sqlite');
const globals = /** @type {any} */ (globalThis);
globals.useRuntimeConfig = () => ({});

const jiti = createJiti(import.meta.url);
const catalog = await jiti.import('../server/core/services/sourceCatalog.ts');
const searchSettings = await jiti.import('../server/core/services/searchSettingsService.ts');
const { getSqliteDatabase } = await jiti.import('../server/core/storage/sqlite.ts');
const db = getSqliteDatabase();

function definition(id) {
  return {
    id,
    name: id,
    description: '',
    url: `https://example.invalid/${id}?q={{keyword}}`,
    method: 'GET',
    format: 'json',
    priority: 0,
    enabled: true,
    transform: 'return []',
  };
}

test('source deletion cleans persisted source state', async (t) => {
  await t.test('normal sources can be deleted and recreated', () => {
    catalog.saveUnifiedSource(definition('normal-source'));
    searchSettings.saveSearchSettings({ sources: ['normal-source'] });
    db.run(
      'INSERT INTO source_health(source_id,snapshot_json,updated_at) VALUES(?,?,?)',
      'normal-source',
      '{}',
      Date.now(),
    );

    catalog.deleteUnifiedSource('normal-source');

    assert.equal(db.getRow('SELECT id FROM resource_sources WHERE id=?', 'normal-source'), undefined);
    assert.equal(db.getRow('SELECT source_id FROM search_setting_sources WHERE source_id=?', 'normal-source'), undefined);
    assert.equal(db.getRow('SELECT source_id FROM source_health WHERE source_id=?', 'normal-source'), undefined);
    assert.equal(catalog.listUnifiedSources().some((source) => source.id === 'normal-source'), false);

    catalog.saveUnifiedSource(definition('normal-source'));
    assert.equal(catalog.listUnifiedSources().some((source) => source.id === 'normal-source'), true);
  });

  await t.test('all persisted resource-source definitions share the same deletion path', () => {
    searchSettings.saveSearchSettings({ sources: ['chanx'] });
    catalog.saveUnifiedSource(definition('chanx'));
    assert.ok(db.getRow('SELECT id FROM resource_sources WHERE id=?', 'chanx'));

    catalog.deleteUnifiedSource('chanx');

    assert.equal(db.getRow('SELECT id FROM resource_sources WHERE id=?', 'chanx'), undefined);
    assert.equal(searchSettings.getSearchSettings().sources?.includes('chanx'), false);
    assert.equal(catalog.listUnifiedSources().some((source) => source.id === 'chanx'), false);
  });
});
