import { randomUUID } from "node:crypto";
import { getSqliteDatabase } from "../storage/sqlite";
import type { CloudType, Link, ResourceCheckStatus, SearchResult } from "../types/models";
import { CLOUD_TYPES } from "../../../shared/cloudTypes";
export { CLOUD_TYPES } from "../../../shared/cloudTypes";
import { buildSearchKeywordVariants, normalizeSearchKeyword } from "../utils/searchKeyword";
import { executeSafeHttp } from "../http/safeHttpExecutor";
import { getUnifiedRequestTimeoutMs } from "./timeoutPolicy";

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
export type ManagedResourceApprovalStatus = "pending" | "approved" | "rejected";
export type ManagedResourceCheckStatus = ResourceCheckStatus;
type ResourceRow = { id: string; name: string; description: string | null; datetime: string | null; cloud_types_json: string; links_json: string; tags_json: string; images_json: string; search_text: string; enabled: number; approval_status: ManagedResourceApprovalStatus; check_status: ManagedResourceCheckStatus; check_message: string | null; checked_at: number | null; created_at: number; updated_at: number };

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
function rowToAdmin(row: ResourceRow) { return { ...rowToResource(row), enabled: row.enabled !== 0, approvalStatus: row.approval_status, checkStatus: row.check_status, checkMessage: row.check_message, checkedAt: row.checked_at, createdAt: row.created_at, updatedAt: row.updated_at }; }
function searchText(resource: SearchResult): string {
  return normalizeSearchKeyword([resource.name, resource.description || "", ...(resource.tags || [])].join(" "));
}
function toRow(resource: SearchResult, now: number, approvalStatus: ManagedResourceApprovalStatus, enabled: boolean) { return [resource.id, resource.name, resource.description, resource.datetime, JSON.stringify(resource.cloud_types), JSON.stringify(resource.links), JSON.stringify(resource.tags || []), JSON.stringify(resource.images || []), searchText(resource), enabled ? 1 : 0, approvalStatus, now, now]; }

function linkKey(url: string): string {
  const value = url.trim();
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    return parsed.toString().replace(/\/$/u, "").toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

function linkKeys(resource: SearchResult): Set<string> {
  return new Set(resource.links.map((link) => linkKey(link.url)));
}

function findDuplicateResource(resource: SearchResult): ResourceRow | undefined {
  const wanted = linkKeys(resource);
  for (const row of getSqliteDatabase().allRows<ResourceRow>("SELECT * FROM managed_resources")) {
    const existing = parseJson<Link[]>(row.links_json, []);
    if (existing.some((link) => wanted.has(linkKey(link.url)))) return row;
  }
  return undefined;
}

function insertResource(resource: SearchResult, approvalStatus: ManagedResourceApprovalStatus, enabled: boolean): void {
  const now = Date.now();
  getSqliteDatabase().run(
    "INSERT INTO managed_resources(id,name,description,datetime,cloud_types_json,links_json,tags_json,images_json,search_text,enabled,approval_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ...toRow(resource, now, approvalStatus, enabled),
  );
}

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

export function listManagedResources(options: { q?: string; cloudType?: string; approvalStatus?: ManagedResourceApprovalStatus; page: number; pageSize: number }) {
  const db = getSqliteDatabase(); const q = options.q?.trim() || ""; const cloudType = options.cloudType && CLOUD_TYPE_SET.has(options.cloudType) ? options.cloudType : "";
  const approvalStatus = options.approvalStatus || "approved";
  const conditions: string[] = ["approval_status = ?"]; const params: unknown[] = [approvalStatus];
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
export function countManagedResourcesByApproval(): Record<ManagedResourceApprovalStatus, number> {
  const counts: Record<ManagedResourceApprovalStatus, number> = { pending: 0, approved: 0, rejected: 0 };
  for (const row of getSqliteDatabase().allRows<{ approval_status: ManagedResourceApprovalStatus; count: number }>("SELECT approval_status, COUNT(*) AS count FROM managed_resources GROUP BY approval_status")) {
    if (row.approval_status in counts) counts[row.approval_status] = Number(row.count || 0);
  }
  return counts;
}
export function getManagedResource(id: string): SearchResult | null { const row = getSqliteDatabase().getRow<ResourceRow>("SELECT * FROM managed_resources WHERE id = ?", id); return row ? rowToResource(row) : null; }
export function createManagedResource(raw: unknown): SearchResult { const resource = normalizeInput(raw); insertResource(resource, "pending", false); invalidateSearchCache(); return resource; }

export function captureManagedResource(raw: unknown): { status: "created" | "duplicate"; resource: SearchResult } {
  const resource = normalizeInput({ ...(raw as object), id: `captured-${randomUUID()}` });
  const result = getSqliteDatabase().transaction(() => {
    const duplicate = findDuplicateResource(resource);
    if (duplicate) return { status: "duplicate" as const, resource: rowToResource(duplicate) };
    insertResource(resource, "pending", false);
    return { status: "created" as const, resource };
  });
  invalidateSearchCache();
  return result;
}
export function updateManagedResource(id: string, raw: unknown): SearchResult { const resource = normalizeInput({ ...(raw as object), id }); const db = getSqliteDatabase(); const now = Date.now(); const result = db.run("UPDATE managed_resources SET name=?,description=?,datetime=?,cloud_types_json=?,links_json=?,tags_json=?,images_json=?,search_text=?,check_status='unchecked',check_message=NULL,checked_at=NULL,updated_at=? WHERE id=?", resource.name, resource.description, resource.datetime, JSON.stringify(resource.cloud_types), JSON.stringify(resource.links), JSON.stringify(resource.tags || []), JSON.stringify(resource.images || []), searchText(resource), now, id); if (!result.changes) throw new Error("资源不存在"); invalidateSearchCache(); return resource; }
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

export function setManagedResourceApproval(ids: string[], status: Exclude<ManagedResourceApprovalStatus, "pending">): number {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return 0;
  const db = getSqliteDatabase();
  const enabled = status === "approved" ? 1 : 0;
  // Only pending submissions can enter the inventory. This prevents a stale
  // admin tab from silently changing an already approved/rejected resource.
  const changes = db.transaction(() => unique.reduce((count, id) => count + Number(db.run("UPDATE managed_resources SET approval_status=?,enabled=?,updated_at=? WHERE id=? AND approval_status='pending'", status, enabled, Date.now(), id).changes), 0));
  if (changes) invalidateSearchCache();
  return changes;
}

export interface ResourceCheckResult {
  id: string;
  status: ManagedResourceCheckStatus;
  message: string;
  checkedAt: number;
}

type LinkCheckStatus = "valid" | "invalid" | "unknown";

interface LinkCheckResult {
  status: LinkCheckStatus;
  message: string;
}

function classifyLinkResponse(status: number, body: string): LinkCheckResult {
  const text = body.slice(0, 128_000).toLowerCase();
  if (status === 404 || status === 410) {
    return { status: "invalid", message: `资源链接返回 HTTP ${status}，通常表示链接已失效` };
  }
  if (/分享不存在|链接不存在|资源不存在|页面不存在|分享已取消|链接已失效|资源已失效|not found|expired|removed|deleted/.test(text)) {
    return { status: "invalid", message: `页面包含资源失效提示（HTTP ${status}）` };
  }
  if (status === 401 || status === 403 || /请登录|登录后访问|access denied|unauthorized/.test(text)) {
    return { status: "unknown", message: "链接需要登录或当前访问被拒绝" };
  }
  if (/请输入提取码|输入提取码|提取码验证|password required/.test(text)) {
    return { status: "unknown", message: "链接需要提取码，暂无法确认文件是否有效" };
  }
  if (status >= 200 && status < 300) {
    return { status: "unknown", message: `页面可访问，但未发现可验证的分享状态（HTTP ${status}）` };
  }
  return { status: "unknown", message: `暂时无法确认链接状态（HTTP ${status}）` };
}

function classifyQuarkTokenResponse(body: string): LinkCheckResult {
  let payload: { status?: unknown; code?: unknown; message?: unknown; data?: { stoken?: unknown } };
  try {
    payload = JSON.parse(body) as typeof payload;
  } catch {
    return { status: "unknown", message: "夸克检测接口返回了无法解析的响应" };
  }

  const message = typeof payload.message === "string" ? payload.message : "";
  const status = Number(payload.status);
  const code = Number(payload.code);
  const lowerMessage = message.toLowerCase();

  // 夸克会用 HTTP 200 返回业务错误，不能只看 HTTP 状态码。
  if (
    code === 41011 ||
    status === 404 ||
    /分享地址已失效|分享不存在|分享已取消|分享已过期|链接已失效|expired|not found|removed|deleted/.test(lowerMessage)
  ) {
    return { status: "invalid", message: `夸克接口确认分享已失效（${message || `code ${code}`}）` };
  }

  // 没有提取码并不代表链接失效；接口能返回分享元信息，说明分享仍存在。
  if (code === 41008 || /需要提取码|请输入提取码|输入提取码|password required/.test(lowerMessage)) {
    return { status: "unknown", message: "夸克分享仍存在，但需要提取码，暂无法确认文件状态" };
  }

  if ((message === "ok" || code === 0) && typeof payload.data?.stoken === "string" && payload.data.stoken) {
    return { status: "valid", message: "夸克分享有效，接口已成功获取访问令牌" };
  }

  return { status: "unknown", message: `夸克接口暂时无法确认链接状态（${message || `code ${code}`}）` };
}

async function checkQuarkLink(link: Link, timeoutMs: number): Promise<LinkCheckResult> {
  let url: URL;
  try {
    url = new URL(link.url);
  } catch {
    return { status: "invalid", message: "夸克链接地址格式不正确" };
  }

  const match = url.pathname.match(/^\/s\/([A-Za-z0-9_-]+)\/?$/u);
  if (!match) return { status: "unknown", message: "无法从夸克链接中提取分享 ID" };

  const passcode = link.password || url.searchParams.get("pwd") || url.searchParams.get("passcode") || "";
  const apiUrl = "https://drive.quark.cn/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc";
  const response = await executeSafeHttp({
    method: "POST",
    url: apiUrl,
    headers: {
      accept: "application/json, text/plain, */*",
      "accept-language": "zh-CN,zh;q=0.9",
      "content-type": "application/json",
      origin: "https://pan.quark.cn",
      referer: "https://pan.quark.cn/",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
    },
    body: JSON.stringify({ pwd_id: match[1], passcode }),
    timeoutMs,
    maxRequestBodyBytes: 8 * 1024,
    maxResponseBytes: 256 * 1024,
    maxRedirects: 2,
    followRedirects: true,
    expectedContentTypes: ["application/json", "text/plain"],
    allowedDomains: ["drive.quark.cn"],
    allowHttp: false,
  });

  return classifyQuarkTokenResponse(response.body);
}

async function checkLink(link: Link, timeoutMs: number): Promise<LinkCheckResult> {
  if (link.type === "magnet") return { status: "unknown", message: "磁力链接不支持通过网页请求检测" };
  if (link.type === "others" && /^ed2k:\/\//iu.test(link.url)) return { status: "unknown", message: "ed2k 链接不支持通过网页请求检测" };
  try {
    if (link.type === "quark") return await checkQuarkLink(link, timeoutMs);
    const url = new URL(link.url);
    const response = await executeSafeHttp({
      method: "GET",
      url: link.url,
      timeoutMs,
      maxRequestBodyBytes: 8 * 1024,
      maxResponseBytes: 256 * 1024,
      maxRedirects: 3,
      followRedirects: true,
      expectedContentTypes: ["text/html", "application/xhtml+xml", "text/plain", "application/json", "application/ld+json"],
      allowedDomains: [url.hostname],
      allowHttp: true,
    });
    return classifyLinkResponse(response.response.status, response.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.match(/(?:HTTP 错误|HTTP)[:： ]+(\d{3})/i)?.[1];
    if (code) return classifyLinkResponse(Number(code), message);
    return { status: "unknown", message: `检测失败：${message}` };
  }
}

function summarizeChecks(checks: LinkCheckResult[]): { status: ManagedResourceCheckStatus; message: string } {
  if (checks.some((check) => check.status === "valid")) {
    return { status: "valid", message: checks.length > 1 ? `至少 1 条链接可访问（共检测 ${checks.length} 条）` : checks[0].message };
  }
  if (checks.length > 0 && checks.every((check) => check.status === "invalid")) {
    return { status: "invalid", message: checks.length > 1 ? `全部 ${checks.length} 条链接均已失效` : checks[0].message };
  }
  return { status: "unknown", message: checks.map((check) => check.message).filter(Boolean).slice(0, 2).join("；") || "暂时无法确认链接状态" };
}

export async function checkManagedResources(ids: string[]): Promise<ResourceCheckResult[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return [];
  const db = getSqliteDatabase();
  const now = Date.now();
  const rows = unique.map((id) => db.getRow<ResourceRow>("SELECT * FROM managed_resources WHERE id = ?", id)).filter((row): row is ResourceRow => !!row);
  const timeoutMs = getUnifiedRequestTimeoutMs();
  const results: ResourceCheckResult[] = [];
  for (const row of rows) {
    db.run("UPDATE managed_resources SET check_status='checking', check_message=NULL WHERE id=?", row.id);
    const links = parseJson<Link[]>(row.links_json, []);
    const checks = await Promise.all(links.map((link) => checkLink(link, timeoutMs)));
    const summary = summarizeChecks(checks);
    db.run("UPDATE managed_resources SET check_status=?, check_message=?, checked_at=? WHERE id=?", summary.status, summary.message, now, row.id);
    results.push({ id: row.id, status: summary.status, message: summary.message, checkedAt: now });
  }
  return results;
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
    `SELECT * FROM managed_resources WHERE enabled = 1 AND approval_status = 'approved' AND (${placeholders}) ` +
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
