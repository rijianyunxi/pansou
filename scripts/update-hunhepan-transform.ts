import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
const db = new Database(process.env.PANHUB_SQLITE_DB || 'data/panhub.sqlite');
mkdirSync('.genflow_tmp', { recursive: true });
await db.backup(`.genflow_tmp/before-hunhepan-fix-${Date.now()}.sqlite`);
const row = db.prepare("SELECT * FROM upstream_definitions WHERE id='hunhepan'").get() as any;
if (row) {
  const request = JSON.parse(row.request_json);
  if (request.body?.page === '{{page}}') request.body.page = 1;
  const guard = '  if (payload && payload.code === 0 && payload.msg && !Array.isArray(payload.data?.list)) throw new Error("混合盘: " + payload.msg);\n';
  let transform = row.transform.includes('混合盘: ') ? row.transform : row.transform.replace('  var keyword =', guard + '  var keyword =');
  transform = transform.replace('replace(/<[^>]*>/g, " ")', 'replace(/<[^>]*>/g, "")').replace('item.updated_at || item.created_at || item.time', 'item.update_time || item.updated_at || item.create_time || item.created_at || item.shared_time || item.time');
  db.prepare('UPDATE upstream_definitions SET request_json=?,transform=?,updated_at=? WHERE id=? AND transform=? AND request_json=?').run(JSON.stringify(request), transform, Date.now(), row.id, row.transform, row.request_json);
}
db.close();
