import { randomUUID } from "node:crypto";
import { getSqliteDatabase } from "../storage/sqlite";
import type { CloudType, Link, SearchResult } from "../types/models";
import { CLOUD_TYPES } from "../../../shared/cloudTypes";
export { CLOUD_TYPES } from "../../../shared/cloudTypes";
import { buildSearchKeywordVariants, normalizeSearchKeyword } from "../utils/searchKeyword";

const CLOUD_TYPE_SET = new Set<string>(CLOUD_TYPES);
const MAX_LINKS = 50;
const MAX_TAGS = 30;
const MAX_IMAGES = 30;
/** Local resources are prepended to every search they match, so their count is capped. */
const MAX_SEARCH_RESULTS = 100;
/** Keyword cache for the search path. Writes clear it; the TTL only bounds staleness from another process. */
const SEARCH_CACHE_TTL_MS = 30_000;
const SEARCH_CACHE_MAX_ENTRIES = 256;

type ManagedResourceInput = Partial<SearchResult> & { id?: unknown };
type ResourceRow = { id: string; name: string; description: string | null; datetime: string | null; cloud_types_json: string; links_json: string; tags_json: string; images_json: string; search_text: string; enabled: number; created_at: number; updated_at: number };

function parseJson<T>(value: string, fallback: T): T { try { return JSON.parse(value) as T; } catch { return fallback; } }
function cleanString(value: unknown, field: string, max: number, nullable = false): string | null {
  if (value === null || value === undefined || value === "") return nullable ? null : (() => { throw new Error(`${field}不能为空`); })();
  if (typeof value !== "string") throw new Error(`${field}必须是字符串`);
  const result = value.trim();
  if (!result && nullable) return null;
  if (!result || result.length > max) throw new Error(`${field}长度不合法`);
  return result;
}
function cleanList(value: unknown, field: string, max: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${field}必须是数组`);
  const values = value.map((item) => { if (typeof item !== "string") throw new Error(`${field}内容必须是字符串`); return item.trim(); }).filter(Boolean);
  if (values.length > max || values.some((item) => item.length > 300)) throw new Error(`${field}数量或长度不合法`);
  return [...new Set(values)];
}
function normalizeInput(raw: unknown, requireName = true): SearchResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("资源数据格式不正确");
  const input = raw as ManagedResourceInput;
  const name = cleanString(input.name, "资源名称", 200, !requireName) || "";
  const description = cleanString(input.description, "描述", 5000, true);
  const datetime = cleanString(input.datetime, "资源时间", 80, true);
  if (!Array.isArray(input.links) || input.links.length < 1 || input.links.length > MAX_LINKS) throw new Error("至少需要一个网盘链接");
  const links: Link[] = input.links.map((rawLink) => {
    if (!rawLink || typeof rawLink !== "object") throw new Error("链接格式不正确");
    const link = rawLink as Partial<Link>;
    if (typeof link.type !== "string" || !CLOUD_TYPE_SET.has(link.type)) throw new Error("网盘类型不合法");
    const url = cleanString(link.url, "链接地址", 2000) as string;
    if (!/^(https?:\/\/|magnet:\?|ed2k:\/\/)/iu.test(url)) throw new Error("链接地址协议不支持");
    // A link copied out of a chat message or a Markdown `[标题](url)` arrives
    // with the surrounding punctuation still attached. None of these characters
    // can appear unescaped in a URL, and a second `://` means a second link got
    // swallowed — reject both instead of storing something nobody can open.
    if (/[\s"'<>\\^`{|}]/u.test(url)) throw new Error("链接地址含空格或引号，请只填写链接本身");
    const schemeEnd = url.indexOf("://");
    if (schemeEnd !== -1 && url.indexOf("://", schemeEnd + 3) !== -1) throw new Error("链接地址里出现了第二个链接，请只填写一个");
    const password = cleanString(link.password, "提取码", 100, true);
    return { type: link.type as CloudType, url, password };
  });
  const tags = cleanList(input.tags, "标签", MAX_TAGS);
  const images = cleanList(input.images, "图片", MAX_IMAGES);
  return {
    id: typeof input.id === "string" && input.id.trim() ? input.id.trim() : `local-${randomUUID()}`,
    name, description, datetime,
    cloud_types: [...new Set(links.map((link) => link.type))], links,
    ...(tags.length ? { tags } : {}), ...(images.length ? { images } : {}),
  };
}
function rowToResource(row: ResourceRow): SearchResult {
  const tags = parseJson<string[]>(row.tags_json, []); const images = parseJson<string[]>(row.images_json, []);
  return { id: row.id, name: row.name, description: row.description, datetime: row.datetime, cloud_types: parseJson<CloudType[]>(row.cloud_types_json, []), links: parseJson<Link[]>(row.links_json, []), ...(tags.length ? { tags } : {}), ...(images.length ? { images } : {}) };
}
function rowToAdmin(row: ResourceRow) { return { ...rowToResource(row), enabled: row.enabled !== 0, createdAt: row.created_at, updatedAt: row.updated_at }; }
function searchText(resource: SearchResult): string {
  return normalizeSearchKeyword([resource.name, resource.description || "", ...(resource.tags || [])].join(" "));
}
function toRow(resource: SearchResult, now: number) { return [resource.id, resource.name, resource.description, resource.datetime, JSON.stringify(resource.cloud_types), JSON.stringify(resource.links), JSON.stringify(resource.tags || []), JSON.stringify(resource.images || []), searchText(resource), now, now]; }

/**
 * Keyword variants usable against the normalized `search_text` projection.
 *
 * The console list and the search path must share this builder. They used to
 * disagree — the console matched the raw query against the raw columns — so a
 * keyword the front end matched happily (say "三体 1080p", whose noise suffix is
 * stripped before matching) returned nothing in the console and an operator
 * could not tell whether a resource was reachable.
 */
function keywordVariants(keyword: string): string[] {
  return buildSearchKeywordVariants(keyword)
    .map((variant) => normalizeSearchKeyword(variant))
    .filter((variant, index, all) => variant.length >= 2 && all.indexOf(variant) === index);
}
function keywordPredicate(keyword: string): { sql: string; params: string[] } | null {
  const variants = keywordVariants(keyword);
  if (!variants.length) return null;
  return { sql: variants.map(() => "instr(search_text, ?) > 0").join(" OR "), params: variants };
}

/**
 * Keyword results for the search path.
 *
 * Every write clears the whole cache; the console is the only writer and writes
 * are rare, so the search hot path never scans the table when nothing changed.
 * Results are cloned on the way out because callers keep them past the call.
 */
const searchCache = new Map<string, { at: number; results: SearchResult[] }>();
function invalidateSearchCache(): void { searchCache.clear(); }
function cloneResults(results: SearchResult[]): SearchResult[] {
  return results.map((result) => ({
    ...result,
    links: result.links.map((link) => ({ ...link })),
    cloud_types: [...result.cloud_types],
    ...(result.tags ? { tags: [...result.tags] } : {}),
    ...(result.images ? { images: [...result.images] } : {}),
  }));
}

export function listManagedResources(options: { q?: string; cloudType?: string; page: number; pageSize: number }) {
  const db = getSqliteDatabase(); const q = options.q?.trim() || ""; const cloudType = options.cloudType && CLOUD_TYPE_SET.has(options.cloudType) ? options.cloudType : "";
  const conditions: string[] = []; const params: unknown[] = [];
  // Same predicate as the search path. The projection already covers name,
  // description and tags, so matching it is both cheaper and consistent.
  const predicate = keywordPredicate(q);
  if (predicate) { conditions.push(`(${predicate.sql})`); params.push(...predicate.params); }
  if (cloudType) { conditions.push("cloud_types_json LIKE ?"); params.push(`%\"${cloudType}\"%`); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const total = Number(db.getRow<{ count: number }>(`SELECT COUNT(*) AS count FROM managed_resources ${where}`, ...params)?.count || 0);
  const rows = db.allRows<ResourceRow>(`SELECT * FROM managed_resources ${where} ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`, ...params, options.pageSize, (options.page - 1) * options.pageSize);
  return { items: rows.map(rowToAdmin), total, page: options.page, pageSize: options.pageSize };
}
export function getManagedResource(id: string): SearchResult | null { const row = getSqliteDatabase().getRow<ResourceRow>("SELECT * FROM managed_resources WHERE id = ?", id); return row ? rowToResource(row) : null; }
export function createManagedResource(raw: unknown): SearchResult { const resource = normalizeInput(raw); const db = getSqliteDatabase(); const now = Date.now(); db.run("INSERT INTO managed_resources(id,name,description,datetime,cloud_types_json,links_json,tags_json,images_json,search_text,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)", ...toRow(resource, now)); invalidateSearchCache(); return resource; }
export function updateManagedResource(id: string, raw: unknown): SearchResult { const resource = normalizeInput({ ...(raw as object), id }); const db = getSqliteDatabase(); const now = Date.now(); const result = db.run("UPDATE managed_resources SET name=?,description=?,datetime=?,cloud_types_json=?,links_json=?,tags_json=?,images_json=?,search_text=?,updated_at=? WHERE id=?", resource.name, resource.description, resource.datetime, JSON.stringify(resource.cloud_types), JSON.stringify(resource.links), JSON.stringify(resource.tags || []), JSON.stringify(resource.images || []), searchText(resource), now, id); if (!result.changes) throw new Error("资源不存在"); invalidateSearchCache(); return resource; }
export function deleteManagedResources(ids: string[]): number { const unique = [...new Set(ids.filter(Boolean))]; if (!unique.length) return 0; const changes = getSqliteDatabase().transaction(() => unique.reduce((count, id) => count + Number(getSqliteDatabase().run("DELETE FROM managed_resources WHERE id = ?", id).changes), 0)); if (changes) invalidateSearchCache(); return changes; }
/**
 * Flip the search visibility of a set of resources.
 *
 * `updated_at` is deliberately left alone: this is not a content edit, and
 * bumping it would reshuffle both the console list and the search tie-break
 * order every time an operator toggles a resource.
 */
export function setManagedResourcesEnabled(ids: string[], enabled: boolean): number {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return 0;
  const flag = enabled ? 1 : 0;
  const db = getSqliteDatabase();
  const changes = db.transaction(() => unique.reduce((count, id) => count + Number(db.run("UPDATE managed_resources SET enabled = ? WHERE id = ? AND enabled <> ?", flag, id, flag).changes), 0));
  if (changes) invalidateSearchCache();
  return changes;
}
export function searchManagedResources(keyword: string): SearchResult[] {
  const cacheKey = keyword.trim();
  if (!cacheKey) return [];
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) return cloneResults(cached.results);

  const variants = keywordVariants(keyword);
  if (!variants.length) return [];

  // One streaming pass over the normalized projection, capped while streaming.
  // `instr()` cannot use an index, so the previous OFFSET paging re-scanned the
  // whole table once per page. Ordering is relevance first — the leading
  // variant's position in the projection, 1 meaning the name starts with it — so
  // the cap drops the least relevant matches rather than the oldest ones, which
  // is what a plain `updated_at DESC` ordering did.
  const placeholders = variants.map(() => "instr(search_text, ?) > 0").join(" OR ");
  const results: SearchResult[] = [];
  for (const row of getSqliteDatabase().iterate<ResourceRow>(
    `SELECT * FROM managed_resources WHERE enabled = 1 AND (${placeholders}) ` +
    `ORDER BY CASE WHEN instr(search_text, ?) > 0 THEN instr(search_text, ?) ELSE 2147483647 END, updated_at DESC, id`,
    ...variants, variants[0], variants[0],
  )) {
    results.push(rowToResource(row));
    if (results.length >= MAX_SEARCH_RESULTS) break;
  }
  if (searchCache.size >= SEARCH_CACHE_MAX_ENTRIES) searchCache.clear();
  searchCache.set(cacheKey, { at: Date.now(), results });
  return cloneResults(results);
}
