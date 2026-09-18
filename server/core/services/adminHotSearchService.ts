import { compactHotSearchTerm, normalizeHotSearchTerm, type HotSearchItem, type HotSearchSource, type HotSearchStatus } from "./hotSearchStore";
import { getSqliteDatabase } from "../storage/sqlite";
import { rowToHotSearch } from "./sqliteHotSearchStore";

type HotSearchRow = {
  term: string;
  normalized_term: string;
  score: number;
  last_searched: number;
  created_at: number;
  status: HotSearchStatus;
  source: HotSearchSource;
  pinned: number;
  manual_weight: number;
  updated_at: number;
};

const STATUSES = new Set<HotSearchStatus>(["approved", "pending", "blocked", "hidden"]);

function parseStatus(value: unknown, fallback: HotSearchStatus = "approved"): HotSearchStatus {
  return typeof value === "string" && STATUSES.has(value as HotSearchStatus) ? value as HotSearchStatus : fallback;
}

function parseTerm(value: unknown): { term: string; normalizedTerm: string } {
  const term = normalizeHotSearchTerm(typeof value === "string" ? value : "");
  const normalizedTerm = compactHotSearchTerm(term);
  if (!term || !normalizedTerm || [...term].length > 100) throw new Error("热门搜索词不能为空且最多 100 个字符");
  return { term, normalizedTerm };
}

const selectSql = "SELECT term,normalized_term,score,last_searched,created_at,status,source,pinned,manual_weight,updated_at FROM hot_searches";

export function listAdminHotSearches(options: { page: number; pageSize: number; q?: string; status?: string; source?: string }): { items: HotSearchItem[]; total: number } {
  const db = getSqliteDatabase();
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.q) { where.push("(term LIKE ? OR normalized_term LIKE ?)"); const q = `%${options.q}%`; params.push(q, q); }
  if (STATUSES.has(options.status as HotSearchStatus)) { where.push("status = ?"); params.push(options.status); }
  if (options.source === "auto" || options.source === "manual") { where.push("source = ?"); params.push(options.source); }
  const condition = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const total = Number(db.getRow<{ count: number }>(`SELECT COUNT(*) AS count FROM hot_searches${condition}`, ...params)?.count || 0);
  const rows = db.allRows<HotSearchRow>(`${selectSql}${condition} ORDER BY pinned DESC,manual_weight DESC,score DESC,last_searched DESC LIMIT ? OFFSET ?`, ...params, options.pageSize, (options.page - 1) * options.pageSize);
  return { items: rows.map(rowToHotSearch), total };
}

export function getAdminHotSearch(term: string): HotSearchItem | null {
  const row = getSqliteDatabase().getRow<HotSearchRow>(`${selectSql} WHERE term = ?`, term);
  return row ? rowToHotSearch(row) : null;
}

function writeManualHotSearch(term: string, input: Record<string, unknown>, existing?: HotSearchItem): HotSearchItem {
  const parsed = parseTerm(term);
  const status = parseStatus(input.status, existing?.status || "approved");
  const score = Number.isFinite(Number(input.score)) ? Math.max(0, Math.min(2_000_000_000, Math.floor(Number(input.score)))) : (existing?.score || 0);
  const manualWeight = Number.isFinite(Number(input.manualWeight)) ? Math.max(0, Math.min(1_000_000, Math.floor(Number(input.manualWeight)))) : (existing?.manualWeight || 0);
  const pinned = input.pinned === undefined ? Boolean(existing?.pinned) : input.pinned === true;
  const now = Date.now();
  const db = getSqliteDatabase();
  if (existing && existing.term !== parsed.term) {
    if (getAdminHotSearch(parsed.term)) throw new Error("该热门搜索词已存在");
    db.run("UPDATE hot_searches SET term=?,normalized_term=?,score=?,status=?,source='manual',pinned=?,manual_weight=?,updated_at=? WHERE term=?", parsed.term, parsed.normalizedTerm, score, status, pinned ? 1 : 0, manualWeight, now, existing.term);
  } else if (existing) {
    db.run("UPDATE hot_searches SET normalized_term=?,score=?,status=?,source='manual',pinned=?,manual_weight=?,updated_at=? WHERE term=?", parsed.normalizedTerm, score, status, pinned ? 1 : 0, manualWeight, now, existing.term);
  } else {
    db.run("INSERT INTO hot_searches(term,normalized_term,score,last_searched,created_at,status,source,pinned,manual_weight,updated_at) VALUES(?,?,?, ?,?,?, 'manual',?,?,?)", parsed.term, parsed.normalizedTerm, score, now, now, status, pinned ? 1 : 0, manualWeight, now);
  }
  return getAdminHotSearch(parsed.term)!;
}

export function createAdminHotSearch(input: unknown): HotSearchItem {
  const raw = (input || {}) as Record<string, unknown>;
  const { term } = parseTerm(raw.term);
  if (getAdminHotSearch(term)) throw new Error("该热门搜索词已存在");
  return writeManualHotSearch(term, raw);
}

export function updateAdminHotSearch(oldTerm: string, input: unknown): HotSearchItem {
  const existing = getAdminHotSearch(oldTerm);
  if (!existing) throw new Error("热门搜索词不存在");
  return writeManualHotSearch(String((input as Record<string, unknown> || {}).term ?? oldTerm), (input || {}) as Record<string, unknown>, existing);
}

export function setAdminHotSearchStatus(terms: string[], status: HotSearchStatus): number {
  if (!STATUSES.has(status)) throw new Error("无效的热门搜索状态");
  const unique = [...new Set(terms.map((term) => String(term || "").trim()).filter(Boolean))];
  if (!unique.length) return 0;
  const placeholders = unique.map(() => "?").join(",");
  const sql = "UPDATE hot_searches SET status=?,source='manual',updated_at=? WHERE term IN (" + placeholders + ")";
  return getSqliteDatabase().run(sql, status, Date.now(), ...unique).changes;
}

export function setAdminHotSearchPinned(terms: string[], pinned: boolean): number {
  const unique = [...new Set(terms.map((term) => String(term || "").trim()).filter(Boolean))];
  if (!unique.length) return 0;
  const placeholders = unique.map(() => "?").join(",");
  return getSqliteDatabase().run(`UPDATE hot_searches SET pinned=?,updated_at=? WHERE term IN (${placeholders})`, pinned ? 1 : 0, Date.now(), ...unique).changes;
}

export function deleteAdminHotSearch(terms: string[]): number {
  const unique = [...new Set(terms.map((term) => String(term || "").trim()).filter(Boolean))];
  if (!unique.length) return 0;
  const placeholders = unique.map(() => "?").join(",");
  return getSqliteDatabase().run(`DELETE FROM hot_searches WHERE term IN (${placeholders})`, ...unique).changes;
}
