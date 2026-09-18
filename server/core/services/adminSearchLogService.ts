import { getSqliteDatabase } from "../storage/sqlite";

export type AdminSearchLog = {
  id: number;
  sessionId: number | null;
  userId: number | null;
  username: string | null;
  nickname: string | null;
  keyword: string;
  ip: string;
  searchScope: string;
  channels: string[];
  sourceIds: string[];
  status: string;
  resultCount: number;
  hasResults: boolean;
  outcomeRecorded: boolean;
  sourceResultCounts: Record<string, number>;
  createdAt: number;
};

type LogRow = {
  id: number; session_id: number | null; user_id: number | null; username: string | null; nickname: string | null;
  keyword: string; ip: string; search_scope: string; channels_json: string; source_ids_json: string; status: string; result_count: number; has_results: number; outcome_recorded: number; source_result_counts_json: string; created_at: number;
};

function parseArray(value: string): string[] {
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []; } catch { return []; }
}
function parseCounts(value: string): Record<string, number> {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([key, count]) => typeof key === "string" && Number.isFinite(Number(count))).map(([key, count]) => [key, Number(count)]));
  } catch { return {}; }
}
function toLog(row: LogRow): AdminSearchLog {
  return { id: row.id, sessionId: row.session_id, userId: row.user_id, username: row.username, nickname: row.nickname, keyword: row.keyword, ip: row.ip, searchScope: row.search_scope, channels: parseArray(row.channels_json), sourceIds: parseArray(row.source_ids_json), status: row.status || "completed", resultCount: Number(row.result_count || 0), hasResults: row.has_results === 1, outcomeRecorded: row.outcome_recorded === 1, sourceResultCounts: parseCounts(row.source_result_counts_json), createdAt: row.created_at };
}

export function listAdminSearchLogs(options: {
  page: number; pageSize: number; keyword?: string; userId?: number; sessionId?: number; ip?: string; searchScope?: string; from?: number; to?: number;
}) {
  const db = getSqliteDatabase();
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.keyword) { where.push("l.keyword LIKE ?"); params.push(`%${options.keyword}%`); }
  if (options.userId !== undefined) { where.push("l.user_id = ?"); params.push(options.userId); }
  if (options.sessionId !== undefined) { where.push("l.session_id = ?"); params.push(options.sessionId); }
  if (options.ip) { where.push("l.ip LIKE ?"); params.push(`%${options.ip}%`); }
  if (options.searchScope) { where.push("l.search_scope = ?"); params.push(options.searchScope); }
  if (options.from !== undefined) { where.push("l.created_at >= ?"); params.push(options.from); }
  if (options.to !== undefined) { where.push("l.created_at <= ?"); params.push(options.to); }
  const condition = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const from = " FROM search_logs l LEFT JOIN users u ON u.id = l.user_id";
  const total = Number(db.getRow<{ total: number }>(`SELECT COUNT(*) AS total${from}${condition}`, ...params)?.total || 0);
  const rows = db.allRows<LogRow>(`SELECT l.id,l.session_id,l.user_id,u.username,u.nickname,l.keyword,COALESCE(NULLIF(NULLIF(l.ip, 'unknown'), ''), u.last_login_ip, 'unknown') AS ip,l.search_scope,l.channels_json,l.source_ids_json,l.status,l.result_count,l.has_results,l.outcome_recorded,l.source_result_counts_json,l.created_at${from}${condition} ORDER BY l.created_at DESC,l.id DESC LIMIT ? OFFSET ?`, ...params, options.pageSize, (options.page - 1) * options.pageSize);
  const logs = rows.map(toLog);
  return { logs, items: logs, total, page: options.page, pageSize: options.pageSize, totalPages: Math.ceil(total / options.pageSize) };
}

export function deleteAdminSearchLogs(ids: unknown[]): { deleted: number } {
  const uniqueIds = [...new Set(ids.map((value) => Number(value)).filter((value) => Number.isSafeInteger(value) && value > 0))];
  if (!uniqueIds.length) return { deleted: 0 };
  const placeholders = uniqueIds.map(() => "?").join(",");
  const result = getSqliteDatabase().run(`DELETE FROM search_logs WHERE id IN (${placeholders})`, ...uniqueIds);
  return { deleted: result.changes };
}
