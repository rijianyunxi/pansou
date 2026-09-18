import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from 'jiti';

const directory = mkdtempSync(join(tmpdir(), 'panhub-search-sources-'));
process.env.PANHUB_SQLITE_DB = join(directory, 'settings.sqlite');

const jiti = createJiti(import.meta.url);
const { getSqliteDatabase } = await jiti.import('../server/core/storage/sqlite.ts');
const settings = await jiti.import('../server/core/services/searchSettingsService.ts');
const db = getSqliteDatabase();

test('search settings persist one unified resource-source list', () => {
  settings.saveSearchSettings({ sources: ['nyaa', 'leoziyuan', 'gotopan'] });

  assert.deepEqual(settings.getSearchSettings(), {
    sources: ['gotopan', 'leoziyuan', 'nyaa'],
    trashedSources: [],
  });
  assert.equal(db.getRow('SELECT COUNT(*) AS count FROM search_setting_sources').count, 3);
  assert.equal(db.getRow('SELECT name FROM sqlite_master WHERE type=\'table\' AND name=\'search_setting_channels\''), undefined);
});
