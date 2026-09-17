import { randomUUID } from "node:crypto";
import { getSqliteDatabase } from "../storage/sqlite";
import type { CloudType, Link, SearchResult } from "../types/models";
import { CLOUD_TYPES } from "../../../shared/cloudTypes";
export { CLOUD_TYPES } from "../../../shared/cloudTypes";
import { buildSearchKeywordVariants, matchesSearchKeyword, normalizeSearchKeyword } from "../utils/searchKeyword";

const CLOUD_TYPE_SET = new Set<string>(CLOUD_TYPES);
const MAX_LINKS = 50;
const MAX_TAGS = 30;
const MAX_IMAGES = 30;

type ManagedResourceInput = Partial<SearchResult> & { id?: unknown };
type ResourceRow = { id: string; name: string; description: string | null; datetime: string | null; cloud_types_json: string; links_json: string; tags_json: string; images_json: string; search_text: string; created_at: number; updated_at: number };

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
function rowToAdmin(row: ResourceRow) { return { ...rowToResource(row), createdAt: row.created_at, updatedAt: row.updated_at }; }
function searchText(resource: SearchResult): string {
  return normalizeSearchKeyword([resource.name, resource.description || "", ...(resource.tags || [])].join(" "));
}
function toRow(resource: SearchResult, now: number) { return [resource.id, resource.name, resource.description, resource.datetime, JSON.stringify(resource.cloud_types), JSON.stringify(resource.links), JSON.stringify(resource.tags || []), JSON.stringify(resource.images || []), searchText(resource), now, now]; }

export function listManagedResources(options: { q?: string; cloudType?: string; page: number; pageSize: number }) {
  const db = getSqliteDatabase(); const q = options.q?.trim() || ""; const cloudType = options.cloudType && CLOUD_TYPE_SET.has(options.cloudType) ? options.cloudType : "";
  const conditions: string[] = []; const params: unknown[] = [];
  if (q) { conditions.push("(instr(lower(name), lower(?)) > 0 OR instr(lower(COALESCE(description, '')), lower(?)) > 0 OR instr(lower(tags_json), lower(?)) > 0)"); params.push(q, q, q); }
  if (cloudType) { conditions.push("cloud_types_json LIKE ?"); params.push(`%\"${cloudType}\"%`); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const total = Number(db.getRow<{ count: number }>(`SELECT COUNT(*) AS count FROM managed_resources ${where}`, ...params)?.count || 0);
  const rows = db.allRows<ResourceRow>(`SELECT * FROM managed_resources ${where} ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`, ...params, options.pageSize, (options.page - 1) * options.pageSize);
  return { items: rows.map(rowToAdmin), total, page: options.page, pageSize: options.pageSize };
}
export function getManagedResource(id: string): SearchResult | null { const row = getSqliteDatabase().getRow<ResourceRow>("SELECT * FROM managed_resources WHERE id = ?", id); return row ? rowToResource(row) : null; }
export function createManagedResource(raw: unknown): SearchResult { const resource = normalizeInput(raw); const db = getSqliteDatabase(); const now = Date.now(); db.run("INSERT INTO managed_resources(id,name,description,datetime,cloud_types_json,links_json,tags_json,images_json,search_text,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)", ...toRow(resource, now)); return resource; }
export function updateManagedResource(id: string, raw: unknown): SearchResult { const resource = normalizeInput({ ...(raw as object), id }); const db = getSqliteDatabase(); const now = Date.now(); const result = db.run("UPDATE managed_resources SET name=?,description=?,datetime=?,cloud_types_json=?,links_json=?,tags_json=?,images_json=?,search_text=?,updated_at=? WHERE id=?", resource.name, resource.description, resource.datetime, JSON.stringify(resource.cloud_types), JSON.stringify(resource.links), JSON.stringify(resource.tags || []), JSON.stringify(resource.images || []), searchText(resource), now, id); if (!result.changes) throw new Error("资源不存在"); return resource; }
export function deleteManagedResources(ids: string[]): number { const unique = [...new Set(ids.filter(Boolean))]; if (!unique.length) return 0; return getSqliteDatabase().transaction(() => unique.reduce((count, id) => count + Number(getSqliteDatabase().run("DELETE FROM managed_resources WHERE id = ?", id).changes), 0)); }
export function searchManagedResources(keyword: string): SearchResult[] {
  const variants = buildSearchKeywordVariants(keyword)
    .map((variant) => normalizeSearchKeyword(variant))
    .filter((variant, index, all) => variant.length >= 2 && all.indexOf(variant) === index);
  if (!variants.length) return [];

  // Query the normalized projection first, then retain the existing JS matcher
  // as the final semantic check. This avoids loading/parsing every resource
  // row for each public search while preserving variant matching behavior.
  const placeholders = variants.map(() => "instr(search_text, ?) > 0").join(" OR ");
  const db = getSqliteDatabase();
  const results: SearchResult[] = [];
  const pageSize = 500;
  let offset = 0;
  for (;;) {
    const rows = db.allRows<ResourceRow>(
      `SELECT * FROM managed_resources WHERE ${placeholders} ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`,
      ...variants, pageSize, offset,
    );
    if (!rows.length) break;
    for (const resource of rows.map(rowToResource)) {
      if (matchesSearchKeyword([resource.name, resource.description || "", ...(resource.tags || [])].join(" "), keyword)) {
        results.push(resource);
        if (results.length >= 100) return results;
      }
    }
    if (rows.length < pageSize) break;
    offset += rows.length;
  }
  return results;
}
