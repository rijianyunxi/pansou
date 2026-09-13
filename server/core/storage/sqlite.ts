import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * The application database. Runtime stores use typed tables below; the small
 * key/value adapter is retained only as a one-release migration bridge for
 * databases created by older PanHub versions and for isolated legacy tests.
 */
const IS_TEST_RUNTIME = process.env.NODE_ENV === "test" || process.env.VITEST === "true" || Boolean(process.env.VITEST_WORKER_ID);
const DEFAULT_PATH = process.env.PANHUB_SQLITE_DB || (IS_TEST_RUNTIME ? ":memory:" : "./data/panhub.sqlite");
const connections = new Map<string, SqliteDatabase>();
const clone = <T>(value: T): T => structuredClone(value);
const normalizePath = (path: string): string => path === ":memory:" ? path : resolve(path);

export class SqliteDatabase {
  readonly path: string;
  private readonly db: Database.Database;
  constructor(path = DEFAULT_PATH) {
    this.path = normalizePath(path);
    if (this.path !== ":memory:") {
      mkdirSync(dirname(this.path), { recursive: true });
      this.migrateLegacyFiles();
    }
    this.db = new Database(this.path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(SCHEMA);
    this.migrateSchemaColumns();
    this.migrateLegacyRows();
  }

  exec(sql: string): void { this.db.exec(sql); }
  run(sql: string, ...params: unknown[]): Database.RunResult { return this.db.prepare(sql).run(...params); }
  getRow<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined { return this.db.prepare(sql).get(...params) as T | undefined; }
  allRows<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] { return this.db.prepare(sql).all(...params) as T[]; }
  transaction<T>(callback: () => T): T { return this.db.transaction(callback)(); }

  /** @deprecated Only migration compatibility. Do not use for runtime stores. */
  get<T>(namespace: string, key: string, fallback: T): T {
    // Compatibility projection for older diagnostics/tests. Runtime stores do
    // not write this JSON-shaped view; it is reconstructed from normalized rows.
    if (namespace === "plugin_health" && key === "state") {
      const projection: Record<string, any> = {};
      for (const row of this.allRows<any>("SELECT * FROM plugin_health")) {
        const last = this.getRow<any>("SELECT error_category,message FROM plugin_health_events WHERE plugin_id=? ORDER BY seq DESC LIMIT 1", row.plugin_id);
        projection[row.plugin_id] = { name: row.plugin_id, isHealthy: !!row.is_healthy, circuitState: row.circuit_state, avgResponseTime: row.avg_response_time, p50ResponseTime: row.p50_response_time, p95ResponseTime: row.p95_response_time, failureCount: row.failure_count, totalFailureCount: row.total_failure_count, successCount: row.success_count, requestCount: row.request_count, errorCounts: {}, ...(last?.error_category ? { lastErrorCategory: last.error_category } : {}), ...(last?.message ? { lastErrorMessage: last.message } : {}) };
      }
      return clone(projection) as T;
    }
    if (namespace === "tg_channel_health" && key === "state") {
      const out: Record<string, any[]> = {};
      for (const row of this.allRows<any>("SELECT * FROM tg_channel_health ORDER BY channel,checked_at")) {
        (out[row.channel] ||= []).push({ at: row.checked_at, ok: !!row.ok, elapsedMs: row.elapsed_ms, resultsCount: row.results_count, source: row.source, ...(row.failure_kind ? { failureKind: row.failure_kind } : {}), ...(row.message ? { message: row.message } : {}) });
      }
      return clone(out as T);
    }
    if (namespace === "upstream_catalog" && key === "definitions") {
      const out = Object.fromEntries(this.allRows<any>("SELECT id,definition FROM upstream_definitions").flatMap(row => { try { return [[row.id, JSON.parse(row.definition)]]; } catch { return []; } }));
      return clone(out as T);
    }
    if (namespace === "upstream_catalog" && key === "deleted") {
      return clone(this.allRows<any>("SELECT id FROM deleted_upstreams").map(row => row.id) as T);
    }
    if (namespace === "tg_channel_settings" && key === "state") {
      const policies: Record<string, any> = {};
      for (const row of this.allRows<any>("SELECT * FROM tg_channel_policies")) policies[row.channel] = { ...(row.timeout_ms != null ? { timeoutMs: row.timeout_ms } : {}), ...(row.max_pages != null ? { maxPages: row.max_pages } : {}), ...(row.max_results != null ? { maxResults: row.max_results } : {}), ...(row.max_retries != null ? { maxRetries: row.max_retries } : {}), ...(row.retry_delay_ms != null ? { retryDelayMs: row.retry_delay_ms } : {}), ...(row.fallback ? { fallback: row.fallback } : {}) };
      const channelState = Object.fromEntries(this.allRows<any>("SELECT channel,enabled,deleted FROM tg_channel_states").map(row => [row.channel, { enabled: !!row.enabled, deleted: !!row.deleted }]));
      return clone({ policies, channelState, parsers: {}, upstreamParsers: {} } as T);
    }
    const row = this.getRow<{ value: string }>("SELECT value FROM legacy_kv WHERE namespace = ? AND key = ?", namespace, key);
    if (!row?.value) return clone(fallback);
    try { return clone(JSON.parse(row.value) as T); } catch { return clone(fallback); }
  }
  /** @deprecated Only migration compatibility. Do not use for runtime stores. */
  set<T>(namespace: string, key: string, value: T): void {
    // Compatibility writes from old callers/tests are normalized immediately;
    // runtime stores do not persist JSON documents in legacy_kv.
    if (namespace === "tg_channel_health" && key === "state") {
      this.run("DELETE FROM tg_channel_health");
      migrateLegacyValue(this, namespace, key, value);
      return;
    }
    if (namespace === "tg_channel_settings" && key === "state") {
      this.run("DELETE FROM tg_channel_policies");
      this.run("DELETE FROM tg_channel_states");
      this.run("DELETE FROM parser_bindings");
      migrateLegacyValue(this, namespace, key, value);
      return;
    }
    if (namespace === "upstream_catalog" && key === "definitions") {
      this.run("DELETE FROM upstream_definitions");
      migrateLegacyValue(this, namespace, key, value);
      return;
    }
    if (namespace === "upstream_catalog" && key === "deleted") {
      this.run("DELETE FROM deleted_upstreams");
      for (const id of (Array.isArray(value) ? value : [])) if (typeof id === "string") this.run("INSERT OR IGNORE INTO deleted_upstreams(id,deleted_at) VALUES(?,?)", id, Date.now());
      return;
    }
    if (namespace === "plugin_health" && key === "state") {
      migrateLegacyValue(this, namespace, key, value);
      return;
    }
    this.run(`INSERT INTO legacy_kv(namespace,key,value,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, namespace, key, JSON.stringify(value), Date.now());
  }
  getUpdatedAt(namespace: string, key: string): number | null {
    const row = this.getRow<{ updated_at: number }>("SELECT updated_at FROM legacy_kv WHERE namespace = ? AND key = ?", namespace, key);
    return typeof row?.updated_at === "number" ? row.updated_at : null;
  }
  delete(namespace: string, key: string): void { this.run("DELETE FROM legacy_kv WHERE namespace = ? AND key = ?", namespace, key); }
  list<T>(namespace: string): Array<{ key: string; value: T }> {
    return this.allRows<{ key: string; value: string }>("SELECT key,value FROM legacy_kv WHERE namespace=? ORDER BY key", namespace).flatMap(row => { try { return [{ key: row.key, value: clone(JSON.parse(row.value) as T) }]; } catch { return []; } });
  }
  close(): void { this.db.close(); }

  private migrateLegacyFiles(): void {
    if (existsSync(this.path)) return;
    const baseDir = process.env.PANHUB_LEGACY_DATA_DIR?.trim() ? resolve(process.env.PANHUB_LEGACY_DATA_DIR) : dirname(this.path);
    const legacy = [
      ["search_settings", "state", "search-settings.json"], ["tg_channel_settings", "state", "tg-channel-settings.json"],
      ["tg_channel_health", "state", "tg-channel-health.json"], ["plugin_health", "state", "plugin-health.json"],
      ["hot_searches", "items", "hot-searches.json"], ["plugin_repository", "state", "plugins.json"],
      ["plugin_secrets", "state", "plugin-secrets.json"], ["tg_accounts", "records", "tg-accounts.json"],
      ["parser_plugins", "records", "parser-plugins.json"], ["upstream_catalog", "definitions", "upstreams.json"],
    ] as const;
    const pending: Array<[string, string, unknown, string]> = [];
    for (const [namespace, key, filename] of legacy) {
      const file = resolve(baseDir, filename);
      if (!existsSync(file)) continue;
      try { pending.push([namespace, key, JSON.parse(readFileSync(file, "utf8")), file]); } catch { /* keep malformed files for manual recovery */ }
    }
    if (!pending.length) return;
    const db = new Database(this.path);
    db.exec("CREATE TABLE IF NOT EXISTS legacy_kv(namespace TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(namespace,key));");
    const insert = db.prepare("INSERT OR IGNORE INTO legacy_kv(namespace,key,value,updated_at) VALUES(?,?,?,?)");
    db.transaction(() => { for (const [namespace, key, value] of pending) insert.run(namespace, key, JSON.stringify(value), Date.now()); })();
    db.close();
    // Once imported successfully, the database is the only runtime source.
    for (const [, , , file] of pending) { try { unlinkSync(file); } catch { /* do not fail boot on a read-only legacy dir */ } }
  }

  /** CREATE TABLE IF NOT EXISTS does not upgrade databases created by an older build. */
  private migrateSchemaColumns(): void {
    const columns: Record<string, Array<[string, string]>> = {
      search_settings: [
        ["plugins_configured", "INTEGER NOT NULL DEFAULT 0"],
        ["channels_configured", "INTEGER NOT NULL DEFAULT 0"],
      ],
      tg_source_settings: [
        ["fallback_urls", "TEXT NOT NULL DEFAULT '[]'"],
        ["max_retries", "INTEGER NOT NULL DEFAULT 0"],
        ["delay_ms", "INTEGER NOT NULL DEFAULT 250"],
        ["parser_version", "TEXT NOT NULL DEFAULT '1.0.0'"],
      ],
    };
    for (const [table, additions] of Object.entries(columns)) {
      const existing = new Set(this.allRows<{ name: string }>(`PRAGMA table_info(${table})`).map(row => row.name));
      for (const [name, definition] of additions) {
        if (!existing.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    }
  }

  private migrateLegacyRows(): void {
    // legacy_kv is the current bridge; json_store is the table used by the
    // previous SQLite-backed JSON store. Read the bridge first so that, when
    // both tables contain the same record, the newer migration source wins.
    const rows: Array<{ namespace: string; key: string; value: string }> = [];
    const seen = new Set<string>();
    const readRows = (table: "legacy_kv" | "json_store"): void => {
      if (!this.getRow("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", table)) return;
      for (const row of this.allRows<{ namespace: string; key: string; value: string }>(`SELECT namespace,key,value FROM ${table} ORDER BY namespace,key`)) {
        const identity = `${row.namespace}\u0000${row.key}`;
        if (seen.has(identity)) continue;
        // Do not let an invalid preferred row hide a valid copy in the other
        // legacy table. The marker is written only after all valid rows have
        // been applied to their normalized tables below.
        try { JSON.parse(row.value); } catch { continue; }
        seen.add(identity);
        rows.push(row);
      }
    };
    readRows("legacy_kv");
    readRows("json_store");

    this.transaction(() => {
      for (const row of rows) migrateLegacyValue(this, row.namespace, row.key, JSON.parse(row.value));
      // Keep this write last and in the same transaction as the normalized
      // writes. INSERT OR IGNORE migrations are safe to replay on every boot.
      this.run("INSERT OR REPLACE INTO schema_meta(key,value) VALUES('normalized_storage_v1',?)", new Date().toISOString());
    });
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS legacy_kv(namespace TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(namespace,key));
CREATE TABLE IF NOT EXISTS system_settings(id INTEGER PRIMARY KEY CHECK(id=1),default_concurrency INTEGER NOT NULL,plugin_timeout_ms INTEGER NOT NULL,cache_ttl_minutes INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS system_channels(kind TEXT NOT NULL,name TEXT NOT NULL,position INTEGER NOT NULL,PRIMARY KEY(kind,name));
CREATE TABLE IF NOT EXISTS tg_source_settings(id INTEGER PRIMARY KEY CHECK(id=1),direct_template TEXT NOT NULL,jina_template TEXT NOT NULL,user_agent TEXT NOT NULL,headers TEXT NOT NULL,transform TEXT NOT NULL,fallback_urls TEXT NOT NULL,max_retries INTEGER NOT NULL,delay_ms INTEGER NOT NULL,parser_version TEXT NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS search_settings(id INTEGER PRIMARY KEY CHECK(id=1),concurrency INTEGER,plugin_timeout_ms INTEGER,plugins_configured INTEGER NOT NULL DEFAULT 0,channels_configured INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS search_setting_plugins(plugin_id TEXT PRIMARY KEY,trashed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS search_setting_channels(channel TEXT PRIMARY KEY,position INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tg_channel_policies(channel TEXT PRIMARY KEY,timeout_ms INTEGER,max_pages INTEGER,max_results INTEGER,max_retries INTEGER,retry_delay_ms INTEGER,fallback TEXT,fallback_urls TEXT,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tg_channel_states(channel TEXT PRIMARY KEY,enabled INTEGER NOT NULL,deleted INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS parser_bindings(scope TEXT NOT NULL,source_id TEXT NOT NULL,plugin_id TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(scope,source_id));
CREATE TABLE IF NOT EXISTS tg_accounts(id TEXT PRIMARY KEY,name TEXT NOT NULL,phone TEXT,api_id INTEGER NOT NULL,api_hash TEXT,session_string TEXT,enabled INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS plugin_secrets(plugin_id TEXT NOT NULL,name TEXT NOT NULL,value TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(plugin_id,name));
CREATE TABLE IF NOT EXISTS hot_searches(term TEXT PRIMARY KEY,score INTEGER NOT NULL,last_searched INTEGER NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tg_channel_health(channel TEXT NOT NULL,checked_at INTEGER NOT NULL,ok INTEGER NOT NULL,elapsed_ms INTEGER NOT NULL,results_count INTEGER NOT NULL,source TEXT NOT NULL,failure_kind TEXT,message TEXT,PRIMARY KEY(channel,checked_at));
CREATE INDEX IF NOT EXISTS idx_tg_channel_health_recent ON tg_channel_health(channel,checked_at DESC);
CREATE TABLE IF NOT EXISTS plugin_health_events(plugin_id TEXT NOT NULL,seq INTEGER NOT NULL,checked_at INTEGER NOT NULL,ok INTEGER NOT NULL,response_time_ms INTEGER NOT NULL,result_count INTEGER NOT NULL,error_category TEXT,message TEXT,PRIMARY KEY(plugin_id,seq));
CREATE INDEX IF NOT EXISTS idx_plugin_health_events_recent ON plugin_health_events(plugin_id,seq DESC);
CREATE TABLE IF NOT EXISTS plugin_health(plugin_id TEXT PRIMARY KEY,is_healthy INTEGER NOT NULL,circuit_state TEXT NOT NULL,avg_response_time REAL NOT NULL,p50_response_time REAL NOT NULL,p95_response_time REAL NOT NULL,failure_count INTEGER NOT NULL,total_failure_count INTEGER NOT NULL,success_count INTEGER NOT NULL,request_count INTEGER NOT NULL,last_success_time INTEGER,last_failure_time INTEGER,last_error TEXT,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS plugin_health_errors(plugin_id TEXT NOT NULL,category TEXT NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(plugin_id,category));
CREATE TABLE IF NOT EXISTS plugin_health_dimensions(plugin_id TEXT NOT NULL,dimension TEXT NOT NULL,state TEXT NOT NULL,pass_rate REAL NOT NULL,pass_count INTEGER NOT NULL,fail_count INTEGER NOT NULL,empty_count INTEGER NOT NULL,recent TEXT NOT NULL,last_pass_time INTEGER,last_fail_time INTEGER,last_message TEXT,PRIMARY KEY(plugin_id,dimension));
CREATE TABLE IF NOT EXISTS plugin_health_history(plugin_id TEXT NOT NULL,bucket_time INTEGER NOT NULL,total_count INTEGER NOT NULL,success_count INTEGER NOT NULL,failure_count INTEGER NOT NULL,empty_count INTEGER NOT NULL,error_counts TEXT,PRIMARY KEY(plugin_id,bucket_time));
CREATE TABLE IF NOT EXISTS plugin_records(id TEXT PRIMARY KEY,status TEXT NOT NULL,published_version TEXT,definition TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,updated_by TEXT NOT NULL,validation TEXT,updated_at_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS plugin_versions(plugin_id TEXT NOT NULL,version TEXT NOT NULL,definition TEXT NOT NULL,created_at TEXT NOT NULL,created_by TEXT NOT NULL,changelog TEXT,PRIMARY KEY(plugin_id,version));
CREATE TABLE IF NOT EXISTS plugin_audit(plugin_id TEXT NOT NULL,seq INTEGER NOT NULL,action TEXT NOT NULL,actor TEXT NOT NULL,created_at TEXT NOT NULL,metadata TEXT,PRIMARY KEY(plugin_id,seq));
CREATE TABLE IF NOT EXISTS parser_plugins(id TEXT PRIMARY KEY,record TEXT NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS upstream_definitions(id TEXT PRIMARY KEY,source_kind TEXT NOT NULL,channel TEXT,name TEXT NOT NULL,description TEXT NOT NULL,url TEXT NOT NULL,method TEXT NOT NULL,format TEXT NOT NULL,enabled INTEGER NOT NULL,definition TEXT NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS deleted_upstreams(id TEXT PRIMARY KEY,deleted_at INTEGER NOT NULL);
`;

function migrateLegacyValue(db: SqliteDatabase, namespace: string, key: string, value: any): void {
  const now = Date.now();
  if (namespace === "plugin_secrets") {
    const state = value?.secrets || value || {};
    for (const [pluginId, bucket] of Object.entries(state)) for (const [name, secret] of Object.entries((bucket || {}) as Record<string,string>)) if (typeof secret === "string") db.run("INSERT OR IGNORE INTO plugin_secrets VALUES(?,?,?,?)", pluginId, name, secret, now);
  } else if (namespace === "hot_searches") {
    const items = value?.items || value || {};
    for (const item of Object.values(items) as any[]) if (item?.term) db.run("INSERT OR IGNORE INTO hot_searches VALUES(?,?,?,?)", item.term, Number(item.score)||0, Number(item.lastSearched)||now, Number(item.createdAt)||now);
  } else if (namespace === "tg_channel_health") {
    for (const [channel, records] of Object.entries(value || {})) for (const record of (records as any[]) || []) if (record && Number.isFinite(Number(record.at)) && Number(record.at) > 0) db.run("INSERT OR IGNORE INTO tg_channel_health VALUES(?,?,?,?,?,?,?,?)", channel, Math.floor(Number(record.at)), record.ok ? 1 : 0, Number(record.elapsedMs) || 0, Number(record.resultsCount) || 0, String(record.source || "search"), record.failureKind ? String(record.failureKind) : null, record.message ? String(record.message) : null);
  } else if (namespace === "tg_channel_settings") {
    const policies = value?.policies || {};
    for (const [channel, policy] of Object.entries(policies) as any) db.run("INSERT OR REPLACE INTO tg_channel_policies(channel,timeout_ms,max_pages,max_results,max_retries,retry_delay_ms,fallback,fallback_urls,updated_at) VALUES(?,?,?,?,?,?,?,?,?)", channel, policy.timeoutMs || null, policy.maxPages || null, policy.maxResults || null, policy.maxRetries || null, policy.retryDelayMs || null, policy.fallback || null, policy.fallbackUrls ? JSON.stringify(policy.fallbackUrls) : null, now);
    for (const [channel, state] of Object.entries(value?.channelState || {}) as any) if (/^[a-z0-9_]{3,64}$/.test(channel)) db.run("INSERT OR REPLACE INTO tg_channel_states(channel,enabled,deleted,updated_at) VALUES(?,?,?,?)", channel, state.enabled === false ? 0 : 1, state.deleted ? 1 : 0, now);
    for (const [sourceId, binding] of Object.entries(value?.parsers || {}) as any) if (binding?.pluginId) db.run("INSERT OR REPLACE INTO parser_bindings(scope,source_id,plugin_id,updated_at) VALUES(?,?,?,?)", "telegram", sourceId, binding.pluginId, binding.updatedAt || new Date(now).toISOString());
    for (const [sourceId, binding] of Object.entries(value?.upstreamParsers || {}) as any) if (binding?.pluginId) db.run("INSERT OR REPLACE INTO parser_bindings(scope,source_id,plugin_id,updated_at) VALUES(?,?,?,?)", "upstream", sourceId, binding.pluginId, binding.updatedAt || new Date(now).toISOString());
  } else if (namespace === "search_settings" && key === "state") {
    const plugins = Array.isArray(value?.plugins) ? value.plugins.filter((id: unknown): id is string => typeof id === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) : null;
    const channels = Array.isArray(value?.channels) ? value.channels.filter((channel: unknown): channel is string => typeof channel === "string" && channel.trim().length > 0).map((channel: string) => channel.trim()) : null;
    const trashed = new Set(Array.isArray(value?.trashedPlugins) ? value.trashedPlugins.filter((id: unknown): id is string => typeof id === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) : []);
    const concurrency = typeof value?.concurrency === "number" && Number.isFinite(value.concurrency) ? Math.round(value.concurrency) : null;
    const pluginTimeoutMs = typeof value?.pluginTimeoutMs === "number" && Number.isFinite(value.pluginTimeoutMs) ? Math.round(value.pluginTimeoutMs) : null;
    db.run("INSERT OR IGNORE INTO search_settings(id,concurrency,plugin_timeout_ms,plugins_configured,channels_configured,updated_at) VALUES(1,?,?,?,?,?)", concurrency, pluginTimeoutMs, plugins !== null ? 1 : 0, channels !== null ? 1 : 0, now);
    for (const id of new Set([...(plugins || []), ...trashed])) db.run("INSERT OR IGNORE INTO search_setting_plugins(plugin_id,trashed) VALUES(?,?)", id, trashed.has(id) ? 1 : 0);
    for (const [position, channel] of [...new Set(channels || [])].entries()) db.run("INSERT OR IGNORE INTO search_setting_channels(channel,position) VALUES(?,?)", channel, position);
  } else if (namespace === "system_settings" && key === "seed") {
    const priorityChannels = Array.isArray(value?.priorityChannels) ? value.priorityChannels.filter((channel: unknown): channel is string => typeof channel === "string" && channel.trim().length > 0).map((channel: string) => channel.trim()) : [];
    const defaultChannels = Array.isArray(value?.defaultChannels) ? value.defaultChannels.filter((channel: unknown): channel is string => typeof channel === "string" && channel.trim().length > 0).map((channel: string) => channel.trim()) : [];
    const defaultConcurrency = Number.isFinite(Number(value?.defaultConcurrency)) && Number(value.defaultConcurrency) > 0 ? Math.round(Number(value.defaultConcurrency)) : 10;
    const pluginTimeoutMs = Number.isFinite(Number(value?.pluginTimeoutMs)) && Number(value.pluginTimeoutMs) > 0 ? Math.round(Number(value.pluginTimeoutMs)) : 15000;
    const cacheTtlMinutes = Number.isFinite(Number(value?.cacheTtlMinutes)) && Number(value.cacheTtlMinutes) > 0 ? Math.round(Number(value.cacheTtlMinutes)) : 30;
    db.run("INSERT OR IGNORE INTO system_settings(id,default_concurrency,plugin_timeout_ms,cache_ttl_minutes,updated_at) VALUES(1,?,?,?,?)", defaultConcurrency, pluginTimeoutMs, cacheTtlMinutes, now);
    for (const [position, channel] of [...new Set(priorityChannels)].entries()) db.run("INSERT OR IGNORE INTO system_channels(kind,name,position) VALUES(?,?,?)", "priority", channel, position);
    for (const [position, channel] of [...new Set(defaultChannels)].entries()) db.run("INSERT OR IGNORE INTO system_channels(kind,name,position) VALUES(?,?,?)", "default", channel, position);
  } else if (namespace === "tg_source_settings" && key === "config") {
    const directTemplate = typeof value?.directTemplate === "string" && value.directTemplate.includes("{{channel}}") ? value.directTemplate.trim() : "https://t.me/s/{{channel}}";
    const jinaTemplate = typeof value?.jinaTemplate === "string" && value.jinaTemplate.includes("{{channel}}") ? value.jinaTemplate.trim() : "https://r.jina.ai/https://t.me/s/{{channel}}";
    const userAgent = typeof value?.userAgent === "string" && value.userAgent.trim() ? value.userAgent.trim() : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
    const headers = Object.fromEntries(Object.entries(value?.headers && typeof value.headers === "object" ? value.headers : {}).filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string"));
    headers["user-agent"] ||= userAgent;
    const fallbackUrls = Array.isArray(value?.fallbackUrls) ? [...new Set(value.fallbackUrls.filter((url: unknown): url is string => typeof url === "string" && url.trim().length > 0).map((url: string) => url.trim()))] : [];
    const retry = value?.retry && typeof value.retry === "object" ? value.retry : {};
    const maxRetries = Number.isInteger(retry.maxRetries) ? Math.min(3, Math.max(0, Number(retry.maxRetries))) : 0;
    const delayMs = Number.isInteger(retry.delayMs) ? Math.min(5000, Math.max(0, Number(retry.delayMs))) : 250;
    const parserVersion = typeof value?.parserVersion === "string" && /^\d+\.\d+\.\d+$/.test(value.parserVersion) ? value.parserVersion : "1.0.0";
    const transform = typeof value?.transform === "string" ? value.transform : "";
    db.run("INSERT OR IGNORE INTO tg_source_settings(id,direct_template,jina_template,user_agent,headers,transform,fallback_urls,max_retries,delay_ms,parser_version,updated_at) VALUES(1,?,?,?,?,?,?,?,?,?,?)", directTemplate, jinaTemplate, userAgent, JSON.stringify(headers), transform, JSON.stringify(fallbackUrls), maxRetries, delayMs, parserVersion, now);
  } else if (namespace === "plugin_health") {
    for (const [pluginId, status] of Object.entries(value || {}) as any) migrateHealth(db, pluginId, status);
  } else if (namespace === "plugin_repository") {
    for (const record of Object.values(value?.records || {}) as any[]) migratePlugin(db, record);
  } else if (namespace === "tg_accounts") {
    for (const record of Object.values(value?.records || value || {}) as any[]) db.run("INSERT OR IGNORE INTO tg_accounts VALUES(?,?,?,?,?,?,?,?,?)", record.id, record.name, record.phone || null, record.apiId || 0, record.apiHash || null, record.sessionString || null, record.enabled === false ? 0 : 1, record.createdAt || new Date(now).toISOString(), record.updatedAt || new Date(now).toISOString());
  } else if (namespace === "parser_plugins") {
    for (const [id, record] of Object.entries(value?.records || value || {})) db.run("INSERT OR IGNORE INTO parser_plugins VALUES(?,?,?)", id, JSON.stringify(record), now);
  } else if (namespace === "upstream_catalog" && key === "definitions") {
    for (const [id, definition] of Object.entries(value || {}) as any) db.run("INSERT OR IGNORE INTO upstream_definitions VALUES(?,?,?,?,?,?,?,?,?,?,?)", id, definition.sourceKind || "http", definition.channel || null, definition.name || id, definition.description || "", definition.url || "", definition.method || "GET", definition.format || "json", definition.enabled === false ? 0 : 1, JSON.stringify(definition), now);
  }
}
function migrateHealth(db: SqliteDatabase, pluginId: string, status: any): void {
  db.run("INSERT OR IGNORE INTO plugin_health VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", pluginId, status.isHealthy === false ? 0 : 1, status.circuitState || "closed", status.avgResponseTime || 0, status.p50ResponseTime || 0, status.p95ResponseTime || 0, status.failureCount || 0, status.totalFailureCount || 0, status.successCount || 0, status.requestCount || 0, status.lastSuccessTime || null, status.lastFailureTime || null, status.lastError || null, Date.now());
  for (const [category, count] of Object.entries(status.errorCounts || {})) db.run("INSERT OR IGNORE INTO plugin_health_errors VALUES(?,?,?)", pluginId, category, count);
  for (const [dimension, value] of Object.entries(status.dimensions || {}) as any) db.run("INSERT OR IGNORE INTO plugin_health_dimensions VALUES(?,?,?,?,?,?,?,?,?,?,?)", pluginId, dimension, value.state || "unknown", value.passRate || 0, value.passCount || 0, value.failCount || 0, value.emptyCount || 0, value.recent || "", value.lastPassTime || null, value.lastFailTime || null, value.lastMessage || null);
  for (const bucket of status.history?.buckets || []) db.run("INSERT OR IGNORE INTO plugin_health_history VALUES(?,?,?,?,?,?,?)", pluginId, bucket.t, bucket.n || 0, bucket.s || 0, bucket.f || 0, bucket.z || 0, JSON.stringify(bucket.e || {}));
}
function migratePlugin(db: SqliteDatabase, record: any): void {
  if (!record?.id) return;
  db.run("INSERT OR IGNORE INTO plugin_records VALUES(?,?,?,?,?,?,?,?,?)", record.id, record.status || "draft", record.publishedVersion || null, JSON.stringify(record.definition || {}), record.createdAt || new Date().toISOString(), record.updatedAt || new Date().toISOString(), record.updatedBy || "system", record.validation ? JSON.stringify(record.validation) : null, Date.now());
  for (const version of record.versions || []) db.run("INSERT OR IGNORE INTO plugin_versions VALUES(?,?,?,?,?,?)", record.id, version.version, JSON.stringify(version.definition), version.createdAt, version.createdBy, version.changelog || null);
  (record.auditTrail || []).forEach((entry: any, index: number) => db.run("INSERT OR IGNORE INTO plugin_audit VALUES(?,?,?,?,?,?)", record.id, index + 1, entry.action, entry.actor, entry.createdAt, entry.metadata ? JSON.stringify(entry.metadata) : null));
}

export function getSqliteDatabase(path?: string): SqliteDatabase {
  const resolved = normalizePath(path || DEFAULT_PATH); const existing = connections.get(resolved); if (existing) return existing;
  const created = new SqliteDatabase(resolved); connections.set(resolved, created); return created;
}
export function resetSqliteDatabase(path?: string): void { const resolved = normalizePath(path || DEFAULT_PATH); const existing = connections.get(resolved); if (existing) { existing.close(); connections.delete(resolved); } }
