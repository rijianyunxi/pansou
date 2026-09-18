import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from 'jiti';

/**
 * `system_channels` holds the administrator's default channel list. It is written
 * straight from the settings form, so it needs the same filter against
 * `deleted_sources` that the source catalogue already applies — otherwise a
 * retired channel stays in the console forever and is echoed by /api/health.
 */
const directory = mkdtempSync(join(tmpdir(), 'panhub-channels-'));
process.env.PANHUB_SQLITE_DB = join(directory, 'channels.sqlite');
// Nuxt injects useRuntimeConfig as a global auto-import; the settings service
// reads it for its bootstrap branch, which falls back to SQLite anyway.
// The cast is load-bearing: with allowJs, TypeScript turns a direct
// `globalThis.useRuntimeConfig = …` into a global declaration, which narrows the
// Nuxt auto-import to `() => {}` for every file in the project.
const globals = /** @type {any} */ (globalThis);
globals.useRuntimeConfig = () => ({});

const jiti = createJiti(import.meta.url);
const { getSqliteDatabase, SqliteDatabase } = await jiti.import('../server/core/storage/sqlite.ts');
const settings = await jiti.import('../server/core/services/systemSettingsService.ts');

const db = getSqliteDatabase();
const markDeleted = (id) =>
  db.run(
    'INSERT INTO deleted_sources(id,deleted_at) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET deleted_at=excluded.deleted_at',
    id,
    Date.now(),
  );

test('default channels never include a deleted source', async (t) => {
  await t.test('a deleted source is filtered out on read', () => {
    settings.saveSystemSettings({ defaultChannels: ['alpha', 'beta'], priorityChannels: ['gamma'] });
    assert.deepEqual(settings.getSystemSettings().defaultChannels, ['alpha', 'beta']);

    // Reproduce the state an older build could leave behind: the row is present
    // in the table while the id is already in the delete list.
    db.run("INSERT OR REPLACE INTO system_channels(kind,name,position) VALUES('default','beta',1)");
    markDeleted('beta');

    assert.deepEqual(settings.getSystemSettings().defaultChannels, ['alpha']);
    assert.deepEqual(settings.getSystemSettings().priorityChannels, ['gamma']);
  });

  await t.test('saving cannot re-introduce a deleted source', () => {
    const saved = settings.saveSystemSettings({ defaultChannels: ['alpha', 'beta', 'delta'] });

    assert.deepEqual(saved.defaultChannels, ['alpha', 'delta']);
    assert.deepEqual(settings.getSystemSettings().defaultChannels, ['alpha', 'delta']);
  });

  await t.test('a stale row is dropped by the migration on the next start', () => {
    const path = join(directory, 'migration.sqlite');
    const seeded = new SqliteDatabase(path);
    seeded.run("INSERT INTO deleted_sources(id,deleted_at) VALUES('gone',?)", Date.now());
    seeded.run("INSERT INTO system_channels(kind,name,position) VALUES('default','gone',0)");
    seeded.run(
      "INSERT INTO source_lifecycle_states(channel,enabled,deleted,updated_at) VALUES('gone',0,0,?)",
      Date.now(),
    );
    seeded.close();

    // A fresh instance runs the migrations the constructor owns.
    const reopened = new SqliteDatabase(path);
    assert.equal(reopened.getRow('SELECT name FROM system_channels WHERE name=?', 'gone'), undefined);
    assert.equal(reopened.getRow('SELECT channel FROM source_lifecycle_states WHERE channel=?', 'gone'), undefined);
    // The delete marker itself must survive: it is what keeps the source hidden.
    assert.equal(reopened.getRow('SELECT id FROM deleted_sources WHERE id=?', 'gone').id, 'gone');
    reopened.close();
  });
});
