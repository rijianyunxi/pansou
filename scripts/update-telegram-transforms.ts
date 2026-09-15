import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { TELEGRAM_DEFAULT_TRANSFORM } from "../server/core/source-runtime/defaults";
// Only replace the known buggy bootstrap; never overwrite user-customized code.
const db = new Database(process.env.PANHUB_SQLITE_DB || "data/panhub.sqlite");
mkdirSync('.genflow_tmp', { recursive: true });
await db.backup(`.genflow_tmp/before-transform-fix-${Date.now()}.sqlite`);
let changed = 0;
db.transaction(() => {
  for (const row of db.prepare("SELECT id,transform FROM upstream_definitions WHERE source_kind='telegram'").all() as any[]) {
    if (!['29c8bc76739375064e5a9f56f28925510945107335ddcefa5173cc8823e3c692', 'e02a9fcb68f598d0d37735e2bad985aa05e14d3e7f20d2fe3e31658f9f55668f'].includes(createHash('sha256').update(row.transform).digest('hex'))) continue;
    changed += db.prepare('UPDATE upstream_definitions SET transform=?,updated_at=? WHERE id=? AND transform=?').run(TELEGRAM_DEFAULT_TRANSFORM, Date.now(), row.id, row.transform).changes;
  }
})();
db.close();
console.log(`Updated ${changed} known legacy Telegram transforms; custom transforms preserved.`);
