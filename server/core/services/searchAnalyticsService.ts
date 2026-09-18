import { getSqliteDatabase } from "../storage/sqlite";

export function createSearchLog(input: {
  sessionId: number;
  userId: number | null;
  keyword: string;
  ip: string;
  searchScope: string;
  channels: string[];
  sourceIds: string[];
}): number {
  const result = getSqliteDatabase().run(
    "INSERT INTO search_logs(session_id,user_id,keyword,ip,search_scope,channels_json,source_ids_json,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    input.sessionId,
    input.userId,
    input.keyword,
    input.ip,
    input.searchScope,
    JSON.stringify(input.channels),
    JSON.stringify(input.sourceIds),
    "started",
    Date.now(),
  );
  return Number(result.lastInsertRowid);
}

export function completeSearchLog(searchLogId: number, resultCount: number, sourceResultCounts: Record<string, number>): void {
  getSqliteDatabase().run(
    "UPDATE search_logs SET status = 'completed', result_count = ?, has_results = ?, source_result_counts_json = ?, completed_at = ?, outcome_recorded = 1 WHERE id = ?",
    Math.max(0, Math.floor(resultCount)),
    resultCount > 0 ? 1 : 0,
    JSON.stringify(sourceResultCounts),
    Date.now(),
    searchLogId,
  );
}

export function failSearchLog(searchLogId: number): void {
  getSqliteDatabase().run(
    "UPDATE search_logs SET status = 'failed', completed_at = ? WHERE id = ? AND status = 'started'",
    Date.now(),
    searchLogId,
  );
}

export function getSearchAnalytics(options: { from?: number; to?: number } = {}) {
  const db = getSqliteDatabase();
  const conditions = ["l.status = 'completed'", "l.outcome_recorded = 1"];
  const params: unknown[] = [];
  if (options.from !== undefined) { conditions.push("l.created_at >= ?"); params.push(options.from); }
  if (options.to !== undefined) { conditions.push("l.created_at <= ?"); params.push(options.to); }
  const where = conditions.join(" AND ");
  const overview = db.getRow<{ searches: number; with_results: number; no_results: number; result_count: number }>(
    `SELECT COUNT(*) AS searches, COALESCE(SUM(has_results), 0) AS with_results, COALESCE(SUM(CASE WHEN has_results = 0 THEN 1 ELSE 0 END), 0) AS no_results, COALESCE(SUM(result_count), 0) AS result_count FROM search_logs l WHERE ${where}`,
    ...params,
  ) || { searches: 0, with_results: 0, no_results: 0, result_count: 0 };
  const sourceRows = db.allRows<{
    source_id: string;
    result_count: number;
  }>(
    `SELECT source_id, COALESCE(SUM(result_count), 0) AS result_count FROM (
      SELECT json_each.key AS source_id,
        CAST(json_each.value AS INTEGER) AS result_count
      FROM search_logs l, json_each(l.source_result_counts_json)
      WHERE ${where}
    ) GROUP BY source_id ORDER BY result_count DESC, source_id ASC LIMIT 100`,
    ...params,
  );
  const keywordRows = db.allRows<{ keyword: string; searches: number; with_results: number; no_results: number }>(
    `SELECT keyword, COUNT(*) AS searches, COALESCE(SUM(has_results), 0) AS with_results, COALESCE(SUM(CASE WHEN has_results = 0 THEN 1 ELSE 0 END), 0) AS no_results FROM search_logs l WHERE ${where} GROUP BY keyword ORDER BY searches DESC, keyword ASC LIMIT 100`,
    ...params,
  );
  return {
    overview: {
      searches: Number(overview.searches || 0),
      withResults: Number(overview.with_results || 0),
      noResults: Number(overview.no_results || 0),
      resultCount: Number(overview.result_count || 0),
    },
    sources: sourceRows.map((row) => ({
      sourceId: row.source_id,
      resultCount: Number(row.result_count || 0),
    })),
    keywords: keywordRows.map((row) => ({ keyword: row.keyword, searches: Number(row.searches || 0), withResults: Number(row.with_results || 0), noResults: Number(row.no_results || 0) })),
  };
}
