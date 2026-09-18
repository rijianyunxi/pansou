import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from 'jiti';

const directory = mkdtempSync(join(tmpdir(), 'panhub-capture-'));
process.env.PANHUB_SQLITE_DB = join(directory, 'capture.sqlite');

const jiti = createJiti(import.meta.url);
const { getSqliteDatabase } = await jiti.import('../server/core/storage/sqlite.ts');
const resources = await jiti.import('../server/core/services/managedResourceService.ts');
const db = getSqliteDatabase();

function resource(name, url) {
  return {
    id: 'ignored-client-id',
    name,
    description: '用户选中的资源',
    datetime: '2023-05-17 16:47:53',
    links: [{ type: 'baidu', url, password: null }],
    tags: ['测试'],
    images: [],
  };
}

test('captured resources enter review queue and deduplicate by cloud link', () => {
  const first = resources.captureManagedResource(resource('三体', 'https://pan.baidu.com/s/ABC#fragment'));
  assert.equal(first.status, 'created');

  const row = db.getRow('SELECT approval_status, enabled FROM managed_resources WHERE id = ?', first.resource.id);
  assert.deepEqual(row, { approval_status: 'pending', enabled: 0 });

  const duplicate = resources.captureManagedResource(resource('换一个名称', 'https://PAN.BAIDU.COM/s/ABC'));
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(duplicate.resource.id, first.resource.id);
  assert.equal(db.getRow('SELECT COUNT(*) AS count FROM managed_resources').count, 1);

  assert.equal(resources.setManagedResourceApproval([first.resource.id], 'approved'), 1);
  assert.equal(db.getRow('SELECT approval_status, enabled FROM managed_resources WHERE id = ?', first.resource.id).approval_status, 'approved');
  assert.equal(resources.searchManagedResources('三体').some((item) => item.id === first.resource.id), true);

  assert.equal(resources.setManagedResourceApproval([first.resource.id], 'rejected'), 1);
  assert.equal(resources.searchManagedResources('三体').some((item) => item.id === first.resource.id), false);
});
