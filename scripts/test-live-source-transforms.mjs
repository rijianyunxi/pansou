import { createJiti } from "jiti";

const keyword = process.argv[2] ?? "电影";
const jiti = createJiti(import.meta.url);
const [{ listConfiguredSources }, { toSourceDefinition }, { executeSource }] = await Promise.all([
  jiti.import("../server/core/services/sourceCatalog.ts"),
  jiti.import("../server/core/services/configuredSource.ts"),
  jiti.import("../server/core/source-runtime/executor.ts"),
]);

const rows = [];
for (const source of listConfiguredSources()) {
  const startedAt = Date.now();
  try {
    const result = await executeSource(toSourceDefinition(source), keyword, { limit: 200 });
    rows.push({
      id: source.id,
      ok: true,
      resultCount: result.results.length,
      linkCount: result.results.reduce((count, item) => count + item.links.length, 0),
      statuses: result.traces.map((trace) => trace.status),
      elapsedMs: Date.now() - startedAt,
    });
  } catch (error) {
    rows.push({
      id: source.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - startedAt,
    });
  }
}

console.log(JSON.stringify({ keyword, total: rows.length, success: rows.filter((row) => row.ok).length, rows }, null, 2));
if (rows.some((row) => !row.ok)) process.exitCode = 1;
