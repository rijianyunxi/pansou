import { Script } from "node:vm";
import { getSqliteDatabase } from "../storage/sqlite";
import type {
  ParserPluginManifest,
  ParserPluginRecord,
  ParserPluginStatus,
} from "./types";

const NAMESPACE = "parser_plugins";
const KEY = "records";
const ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const MAX_CODE = 100_000;

function clone<T>(value: T): T { return structuredClone(value); }

function parserFunctionSource(code: string): string {
  const trimmed = code.trim();
  if (/^(?:async\s+)?function\b/.test(trimmed) || trimmed.includes("=>")) return `(${trimmed})`;
  return `(function(payload, $, context) {\n${trimmed}\n})`;
}

function validateParserSyntax(code: string): void {
  try {
    new Script(parserFunctionSource(code), { filename: "parser-plugin:validation" });
  } catch (error) {
    throw new Error(`解析器代码语法错误：${error instanceof Error ? error.message : String(error)}`);
  }
}

function read(): Record<string, ParserPluginRecord> {
  const value = getSqliteDatabase().get<Record<string, ParserPluginRecord>>(NAMESPACE, KEY, {});
  return value && typeof value === "object" ? value : {};
}
function write(records: Record<string, ParserPluginRecord>): void { getSqliteDatabase().set(NAMESPACE, KEY, records); }

export function validateParserManifest(input: unknown): ParserPluginManifest {
  if (!input || typeof input !== "object") throw new Error("parser manifest 必须是对象");
  const value = input as Partial<ParserPluginManifest>;
  const id = String(value.id || "").trim().toLowerCase();
  const name = String(value.name || "").trim();
  const version = String(value.version || "").trim();
  const format = value.format;
  const target = value.target;
  if (!ID_RE.test(id)) throw new Error("parser manifest.id 只能是 2-64 位小写字母、数字、_ 或 -");
  if (!name || name.length > 100) throw new Error("parser manifest.name 必须是 1-100 个字符");
  if (!VERSION_RE.test(version)) throw new Error("parser manifest.version 必须是 x.y.z");
  if (format !== "html" && format !== "json" && format !== "text" && format !== "auto") throw new Error("parser manifest.format 必须是 html、json、text 或 auto");
  if (target !== "upstream" && target !== "telegram" && target !== "both") throw new Error("parser manifest.target 必须是 upstream、telegram 或 both");
  const timeoutMs = Number.isInteger(value.timeoutMs) ? Number(value.timeoutMs) : 1000;
  const maxResults = Number.isInteger(value.maxResults) ? Number(value.maxResults) : 200;
  if (timeoutMs < 100 || timeoutMs > 5000) throw new Error("parser manifest.timeoutMs 必须是 100-5000");
  if (maxResults < 1 || maxResults > 500) throw new Error("parser manifest.maxResults 必须是 1-500");
  return {
    id, name, version,
    ...(value.description ? { description: String(value.description).slice(0, 500) } : {}),
    format, target, timeoutMs, maxResults,
  };
}

export function validateParserCode(code: unknown): string {
  if (typeof code !== "string" || !code.trim()) throw new Error("parser code 不能为空");
  if (code.length > MAX_CODE) throw new Error(`parser code 不能超过 ${MAX_CODE} 个字符`);
  // This is defense-in-depth, not a sandbox replacement. Parser execution is
  // still isolated from request credentials and restricted to admin-authored code.
  if (/\b(?:require|process|globalThis|Function|eval|import|constructor)\b/.test(code)) {
    throw new Error("解析器代码包含禁止的运行时关键字");
  }
  validateParserSyntax(code);
  return code;
}

export function validateParserPlugin(input: unknown): { manifest: ParserPluginManifest; code: string } {
  if (!input || typeof input !== "object") throw new Error("parser plugin 必须是对象");
  const value = input as { manifest?: unknown; code?: unknown };
  return { manifest: validateParserManifest(value.manifest), code: validateParserCode(value.code) };
}

export class SqliteParserPluginRepository {
  async list(options: { includeArchived?: boolean } = {}): Promise<ParserPluginRecord[]> {
    return Object.values(read())
      .filter((record) => options.includeArchived || record.status !== "archived")
      .map(clone)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async get(id: string): Promise<ParserPluginRecord | undefined> {
    const record = read()[id];
    return record ? clone(record) : undefined;
  }
  async getPublished(id: string): Promise<ParserPluginRecord | undefined> {
    const record = read()[id];
    if (!record || record.status !== "published") return undefined;
    const version = record.versions.find((item) => item.version === record.publishedVersion) ||
      record.versions.at(-1);
    if (!version) return clone(record);
    return clone({ ...record, manifest: version.manifest, code: version.code });
  }
  async saveDraft(input: unknown, actor = "admin", changelog?: string): Promise<ParserPluginRecord> {
    const { manifest, code } = validateParserPlugin(input);
    const records = read();
    const old = records[manifest.id];
    const now = new Date().toISOString();
    const existing = old?.versions.find((version) => version.version === manifest.version);
    if (existing && (existing.code !== code || JSON.stringify(existing.manifest) !== JSON.stringify(manifest))) {
      throw new Error(`解析器版本 ${manifest.version} 已存在且不可修改，请提升版本号`);
    }
    const versions = old?.versions ? [...old.versions] : [];
    if (!existing) versions.push({ version: manifest.version, code, manifest, createdAt: now, createdBy: actor, changelog });
    // Editing a new version must not withdraw the currently published one.
    // `getPublished()` serves `publishedVersion`, while this record carries
    // the editable draft. Publishing is the atomic switch; until then, live
    // requests continue to use the previous immutable version.
    const nextStatus: ParserPluginStatus = !old
      ? "draft"
      : old.status === "archived"
        ? "draft"
        : old.status;
    const versionChanged = !!old && old.manifest.version !== manifest.version;
    const testState = versionChanged
      ? { lastTestedAt: undefined, lastTestedVersion: undefined, lastTestResultCount: undefined, lastTestError: undefined }
      : {};
    const record: ParserPluginRecord = old
      ? { ...old, ...testState, manifest, code, versions, status: nextStatus, updatedAt: now, updatedBy: actor }
      : { id: manifest.id, status: "draft", manifest, code, versions, createdAt: now, updatedAt: now, updatedBy: actor };
    records[manifest.id] = record;
    write(records);
    return clone(record);
  }
  async publish(id: string, actor = "admin"): Promise<ParserPluginRecord> {
    const records = read(); const record = records[id];
    if (!record) throw new Error("解析器不存在");
    validateParserPlugin({ manifest: record.manifest, code: record.code });
    record.status = "published"; record.publishedVersion = record.manifest.version; record.updatedAt = new Date().toISOString(); record.updatedBy = actor;
    records[id] = record; write(records); return clone(record);
  }
  async disable(id: string, actor = "admin"): Promise<ParserPluginRecord> {
    const records = read(); const record = records[id];
    if (!record) throw new Error("解析器不存在");
    record.status = "disabled"; record.updatedAt = new Date().toISOString(); record.updatedBy = actor;
    records[id] = record; write(records); return clone(record);
  }
  async enable(id: string, actor = "admin"): Promise<ParserPluginRecord> {
    const records = read(); const record = records[id];
    if (!record) throw new Error("解析器不存在");
    record.status = "published"; record.publishedVersion = record.publishedVersion || record.manifest.version; record.updatedAt = new Date().toISOString(); record.updatedBy = actor;
    records[id] = record; write(records); return clone(record);
  }
  async archive(id: string, actor = "admin"): Promise<ParserPluginRecord> {
    const records = read(); const record = records[id];
    if (!record) throw new Error("解析器不存在");
    record.status = "archived"; record.updatedAt = new Date().toISOString(); record.updatedBy = actor;
    records[id] = record; write(records); return clone(record);
  }
  async restore(id: string, actor = "admin"): Promise<ParserPluginRecord> {
    const records = read(); const record = records[id];
    if (!record) throw new Error("解析器不存在");
    if (record.status !== "archived") throw new Error("只有已归档解析器可以恢复");
    record.status = "disabled"; record.updatedAt = new Date().toISOString(); record.updatedBy = actor;
    records[id] = record; write(records); return clone(record);
  }
  async purge(id: string): Promise<void> {
    const records = read(); const record = records[id];
    if (!record) throw new Error("解析器不存在");
    if (record.status !== "archived") throw new Error("永久删除前必须先归档解析器");
    delete records[id]; write(records);
  }
  async markTest(id: string, resultCount: number, error?: string): Promise<void> {
    const records = read(); const record = records[id]; if (!record) return;
    record.lastTestedAt = new Date().toISOString();
    record.lastTestedVersion = record.manifest.version;
    record.lastTestResultCount = resultCount;
    record.lastTestError = error;
    record.updatedAt = new Date().toISOString();
    records[id] = record;
    write(records);
  }
}

let repository: SqliteParserPluginRepository | undefined;
export function getParserPluginRepository(): SqliteParserPluginRepository { return repository || (repository = new SqliteParserPluginRepository()); }
export function setParserPluginRepository(value: SqliteParserPluginRepository): void { repository = value; }
