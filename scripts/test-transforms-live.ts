import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import { executeSource } from '../server/core/source-runtime/executor';
import { upstreamToSourceDefinition } from '../server/core/services/configuredSourcePlugin';
const db = new Database(process.env.PANHUB_SQLITE_DB || 'data/panhub.sqlite', { readonly: true });
const rows: any[] = db.prepare('SELECT * FROM upstream_definitions WHERE enabled=1 ORDER BY id').all(); db.close();
const reports: any[] = [];
mkdirSync('.genflow_tmp/transform-live', { recursive: true });
let next = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next < rows.length) {
    const row = rows[next++];
    const source = { ...row, sourceKind: row.source_kind, request: row.request_json ? JSON.parse(row.request_json) : undefined };
    const keyword = row.id === 'nyaa' ? 'One Piece' : row.id === 'hunhepan' ? 'python' : '斗破苍穹';
    try {
      let result = await executeSource(upstreamToSourceDefinition(source), keyword);
      let sampleMode = 'keyword';
      if (!result.results.length && row.source_kind === 'telegram') {
        result = await executeSource(upstreamToSourceDefinition(source), '');
        sampleMode = 'recent';
      }
      writeFileSync(`.genflow_tmp/transform-live/${row.id}.raw`, result.raw);
      const bad = result.results.filter(r => !r.name.trim() || /[\r\n]|https?:\/\/|(?:描述|简介|链接)[:：]/.test(r.name));
      const report = { id: row.id, keyword, sampleMode, status: bad.length ? 'format-failed' : result.results.length ? 'passed' : 'empty-unverified', count: result.results.length, samples: result.results.slice(0, 3).map(r => ({ name: r.name, links: r.links })), bad };
      reports.push(report); console.log(row.id, report.status, report.count);
    } catch (error) { reports.push({ id: row.id, keyword, status: 'request-failed', error: String(error) }); console.log(row.id, String(error)); }
  }
}));
writeFileSync('.genflow_tmp/transform-live-report.json', JSON.stringify(reports, null, 2));
console.log('SUMMARY', reports.reduce((sum, row) => { sum[row.status] = (sum[row.status] || 0) + 1; return sum; }, {}));
if (reports.some(r => r.status !== 'passed')) process.exitCode = 1;
