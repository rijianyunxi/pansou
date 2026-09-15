import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_PATH = process.env.PANHUB_SQLITE_DB || "./data/panhub.sqlite";
const connections = new Map<string, SqliteDatabase>();
const normalizePath = (path: string): string => path === ":memory:" ? path : resolve(path);

/** Thin typed-SQL wrapper around the application's normalized SQLite schema. */
export class SqliteDatabase {
  readonly path: string;
  private readonly db: Database.Database;
  private readonly statements = new Map<string, Database.Statement>();

  constructor(path = DEFAULT_PATH) {
    this.path = normalizePath(path);
    if (this.path !== ":memory:") mkdirSync(dirname(this.path), { recursive: true });
    this.db = new Database(this.path);
    const schemaVersion = Number(this.db.pragma("user_version", { simple: true }));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("temp_store = MEMORY");
    this.db.exec(SCHEMA);
    this.db.prepare("INSERT OR IGNORE INTO config_revisions(scope, revision) VALUES('upstreams', 0)").run();
    this.db.prepare("UPDATE config_revisions SET revision=1 WHERE scope='upstreams' AND revision=0 AND (EXISTS(SELECT 1 FROM upstream_definitions) OR EXISTS(SELECT 1 FROM deleted_upstreams))").run();
    if (schemaVersion < 2) this.migrateToV2();
    if (schemaVersion < 3) this.migrateToV3();
    if (schemaVersion < 4) this.migrateToV4();
    if (schemaVersion < 5) this.migrateToV5();
    if (schemaVersion < 6) this.migrateToV6();
    this.db.pragma("user_version = 6");
  }



  private migrateToV2(): void {
    const columns = this.db.prepare("PRAGMA table_info(upstream_definitions)").all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === "definition")) {
      const legacyRows = this.db.prepare("SELECT id,source_kind,channel,name,description,url,method,format,enabled,definition,updated_at FROM upstream_definitions").all() as Array<Record<string, unknown>>;
      this.db.transaction(() => {
        for (const name of ["trg_upstreams_revision_insert", "trg_upstreams_revision_update", "trg_upstreams_revision_delete"]) {
          this.db.exec(`DROP TRIGGER IF EXISTS ${name}`);
        }
        this.db.exec("ALTER TABLE upstream_definitions RENAME TO upstream_definitions_legacy");
        this.db.exec(UPSTREAM_TABLE_V2);
        const insert = this.db.prepare("INSERT INTO upstream_definitions(id,source_kind,channel,name,description,url,method,format,enabled,request_json,transform,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
        for (const row of legacyRows) {
          let definition: any = {};
          try { definition = JSON.parse(String(row.definition || "{}")); } catch { /* invalid legacy row is discarded */ }
          const requestJson = definition.request && typeof definition.request === "object" && !Array.isArray(definition.request) ? JSON.stringify(definition.request) : null;
          const transform = typeof definition.transform === "string" ? definition.transform : "";
          if (!String(row.id || "") || !transform.trim()) continue;
          insert.run(row.id, row.source_kind, row.channel, row.name, row.description, row.url, row.method, row.format, row.enabled, requestJson, transform, row.updated_at);
        }
        this.db.exec("DROP TABLE upstream_definitions_legacy");
        this.db.exec(UPSTREAM_TRIGGERS);
      })();
    }
  }

  private migrateToV3(): void {
    const columns = this.db.prepare("PRAGMA table_info(tg_channel_health)").all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === "channel") && columns.some((column) => column.name === "checked_at")) {
      const legacyRows = this.db.prepare("SELECT channel,checked_at,ok,elapsed_ms,results_count,source,failure_kind,message FROM tg_channel_health ORDER BY channel,checked_at").all() as Array<Record<string, unknown>>;
      this.db.transaction(() => {
        this.db.exec("DROP INDEX IF EXISTS idx_tg_channel_health_recent");
        this.db.exec("ALTER TABLE tg_channel_health RENAME TO tg_channel_health_legacy");
        this.db.exec(TG_HEALTH_TABLE_V3);
        const insert = this.db.prepare("INSERT INTO tg_channel_health(channel,checked_at,ok,elapsed_ms,results_count,source,failure_kind,message) VALUES(?,?,?,?,?,?,?,?)");
        for (const row of legacyRows) insert.run(row.channel, row.checked_at, row.ok, row.elapsed_ms, row.results_count, row.source, row.failure_kind, row.message);
        this.db.exec("DROP TABLE tg_channel_health_legacy");
      })();
    }
  }

  private migrateToV4(): void {
    this.db.exec("UPDATE upstream_definitions SET request_json=json_remove(request_json, '$.timeoutMs') WHERE request_json IS NOT NULL AND json_valid(request_json) AND json_type(request_json, '$.timeoutMs') IS NOT NULL");
  }

  /** Give the single global timeout an explicit request-oriented name. */
  private migrateToV6(): void {
    const columns = this.db.prepare("PRAGMA table_info(system_settings)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "plugin_timeout_ms")) return;
    this.db.transaction(() => {
      this.db.exec("ALTER TABLE system_settings RENAME TO system_settings_legacy_v6");
      this.db.exec("CREATE TABLE system_settings(id INTEGER PRIMARY KEY CHECK(id=1),default_concurrency INTEGER NOT NULL,request_timeout_ms INTEGER NOT NULL,cache_ttl_minutes INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
      this.db.exec("INSERT INTO system_settings(id,default_concurrency,request_timeout_ms,cache_ttl_minutes,updated_at) SELECT id,default_concurrency,plugin_timeout_ms,cache_ttl_minutes,updated_at FROM system_settings_legacy_v6");
      this.db.exec("DROP TABLE system_settings_legacy_v6");
    })();
  }

  /** Collapse all request/transform timeout overrides into system_settings. */
  private migrateToV5(): void {
    const searchColumns = this.db.prepare("PRAGMA table_info(search_settings)").all() as Array<{ name: string }>;
    const policyColumns = this.db.prepare("PRAGMA table_info(tg_channel_policies)").all() as Array<{ name: string }>;
    this.db.transaction(() => {
      // The former search-level override was the effective value in practice;
      // promote it to the one and only persisted timeout before dropping it.
      if (searchColumns.some((column) => column.name === "plugin_timeout_ms")) {
        this.db.exec("UPDATE system_settings SET plugin_timeout_ms=(SELECT plugin_timeout_ms FROM search_settings WHERE id=1) WHERE id=1 AND (SELECT plugin_timeout_ms FROM search_settings WHERE id=1) IS NOT NULL");
        this.db.exec("ALTER TABLE search_settings RENAME TO search_settings_legacy_v5");
        this.db.exec("CREATE TABLE search_settings(id INTEGER PRIMARY KEY CHECK(id=1),concurrency INTEGER,plugins_configured INTEGER NOT NULL DEFAULT 0,channels_configured INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL)");
        this.db.exec("INSERT INTO search_settings(id,concurrency,plugins_configured,channels_configured,updated_at) SELECT id,concurrency,plugins_configured,channels_configured,updated_at FROM search_settings_legacy_v5");
        this.db.exec("DROP TABLE search_settings_legacy_v5");
      }
      if (policyColumns.some((column) => column.name === "timeout_ms")) {
        this.db.exec("ALTER TABLE tg_channel_policies RENAME TO tg_channel_policies_legacy_v5");
        this.db.exec("CREATE TABLE tg_channel_policies(channel TEXT PRIMARY KEY,max_pages INTEGER,max_results INTEGER,max_retries INTEGER,retry_delay_ms INTEGER,fallback TEXT,fallback_urls TEXT,updated_at INTEGER NOT NULL)");
        this.db.exec("INSERT INTO tg_channel_policies(channel,max_pages,max_results,max_retries,retry_delay_ms,fallback,fallback_urls,updated_at) SELECT channel,max_pages,max_results,max_retries,retry_delay_ms,fallback,fallback_urls,updated_at FROM tg_channel_policies_legacy_v5");
        this.db.exec("DROP TABLE tg_channel_policies_legacy_v5");
      }
    })();
  }

  private statement(sql: string): Database.Statement {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
  exec(sql: string): void { this.db.exec(sql); }
  run(sql: string, ...params: unknown[]): Database.RunResult { return this.statement(sql).run(...params); }
  getRow<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined { return this.statement(sql).get(...params) as T | undefined; }
  allRows<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] { return this.statement(sql).all(...params) as T[]; }
  transaction<T>(callback: () => T): T { return this.db.transaction(callback)(); }
  close(): void { this.statements.clear(); this.db.close(); }
}

const UPSTREAM_TABLE_V2 = `CREATE TABLE upstream_definitions(id TEXT PRIMARY KEY,source_kind TEXT NOT NULL,channel TEXT,name TEXT NOT NULL,description TEXT NOT NULL,url TEXT NOT NULL,method TEXT NOT NULL,format TEXT NOT NULL,enabled INTEGER NOT NULL,request_json TEXT,transform TEXT NOT NULL,updated_at INTEGER NOT NULL);`;
const UPSTREAM_TRIGGERS = `CREATE TRIGGER trg_upstreams_revision_insert AFTER INSERT ON upstream_definitions BEGIN UPDATE config_revisions SET revision=revision+1 WHERE scope='upstreams'; END;
CREATE TRIGGER trg_upstreams_revision_update AFTER UPDATE ON upstream_definitions BEGIN UPDATE config_revisions SET revision=revision+1 WHERE scope='upstreams'; END;
CREATE TRIGGER trg_upstreams_revision_delete AFTER DELETE ON upstream_definitions BEGIN UPDATE config_revisions SET revision=revision+1 WHERE scope='upstreams'; END;`;

const TG_HEALTH_TABLE_V3 = `CREATE TABLE tg_channel_health(id INTEGER PRIMARY KEY,channel TEXT NOT NULL,checked_at INTEGER NOT NULL,ok INTEGER NOT NULL,elapsed_ms INTEGER NOT NULL,results_count INTEGER NOT NULL,source TEXT NOT NULL,failure_kind TEXT,message TEXT);
CREATE INDEX idx_tg_channel_health_recent ON tg_channel_health(channel,checked_at DESC);`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS config_revisions(scope TEXT PRIMARY KEY,revision INTEGER NOT NULL CHECK(revision >= 0));
CREATE TABLE IF NOT EXISTS system_settings(id INTEGER PRIMARY KEY CHECK(id=1),default_concurrency INTEGER NOT NULL,request_timeout_ms INTEGER NOT NULL,cache_ttl_minutes INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS system_channels(kind TEXT NOT NULL,name TEXT NOT NULL,position INTEGER NOT NULL,PRIMARY KEY(kind,name));
CREATE INDEX IF NOT EXISTS idx_system_channels_order ON system_channels(kind,position,name);
CREATE TABLE IF NOT EXISTS tg_source_settings(id INTEGER PRIMARY KEY CHECK(id=1),direct_template TEXT NOT NULL,jina_template TEXT NOT NULL,user_agent TEXT NOT NULL,headers TEXT NOT NULL,fallback_urls TEXT NOT NULL,max_retries INTEGER NOT NULL,delay_ms INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS search_settings(id INTEGER PRIMARY KEY CHECK(id=1),concurrency INTEGER,plugins_configured INTEGER NOT NULL DEFAULT 0,channels_configured INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS search_setting_plugins(plugin_id TEXT PRIMARY KEY,trashed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS search_setting_channels(channel TEXT PRIMARY KEY,position INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_search_setting_channels_position ON search_setting_channels(position,channel);
CREATE TABLE IF NOT EXISTS tg_channel_policies(channel TEXT PRIMARY KEY,max_pages INTEGER,max_results INTEGER,max_retries INTEGER,retry_delay_ms INTEGER,fallback TEXT,fallback_urls TEXT,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tg_channel_states(channel TEXT PRIMARY KEY,enabled INTEGER NOT NULL,deleted INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_tg_channel_states_deleted ON tg_channel_states(deleted,channel);
CREATE TABLE IF NOT EXISTS tg_accounts(id TEXT PRIMARY KEY,name TEXT NOT NULL,phone TEXT,api_id INTEGER NOT NULL,api_hash TEXT,session_string TEXT,enabled INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS hot_searches(term TEXT PRIMARY KEY,score INTEGER NOT NULL CHECK(score >= 0),last_searched INTEGER NOT NULL,created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_hot_searches_rank ON hot_searches(score DESC,last_searched DESC);
CREATE TABLE IF NOT EXISTS tg_channel_health(id INTEGER PRIMARY KEY,channel TEXT NOT NULL,checked_at INTEGER NOT NULL,ok INTEGER NOT NULL,elapsed_ms INTEGER NOT NULL,results_count INTEGER NOT NULL,source TEXT NOT NULL,failure_kind TEXT,message TEXT);
CREATE INDEX IF NOT EXISTS idx_tg_channel_health_recent ON tg_channel_health(channel,checked_at DESC);
CREATE TABLE IF NOT EXISTS plugin_health_events(plugin_id TEXT NOT NULL,seq INTEGER NOT NULL,checked_at INTEGER NOT NULL,ok INTEGER NOT NULL,response_time_ms INTEGER NOT NULL,result_count INTEGER NOT NULL,error_category TEXT,message TEXT,PRIMARY KEY(plugin_id,seq));
CREATE INDEX IF NOT EXISTS idx_plugin_health_events_recent ON plugin_health_events(plugin_id,seq DESC);
CREATE TABLE IF NOT EXISTS plugin_health(plugin_id TEXT PRIMARY KEY,is_healthy INTEGER NOT NULL,circuit_state TEXT NOT NULL,avg_response_time REAL NOT NULL,p50_response_time REAL NOT NULL,p95_response_time REAL NOT NULL,failure_count INTEGER NOT NULL,total_failure_count INTEGER NOT NULL,success_count INTEGER NOT NULL,request_count INTEGER NOT NULL,last_success_time INTEGER,last_failure_time INTEGER,last_error TEXT,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS plugin_health_errors(plugin_id TEXT NOT NULL,category TEXT NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(plugin_id,category));
CREATE TABLE IF NOT EXISTS plugin_health_dimensions(plugin_id TEXT NOT NULL,dimension TEXT NOT NULL,state TEXT NOT NULL,pass_rate REAL NOT NULL,pass_count INTEGER NOT NULL,fail_count INTEGER NOT NULL,empty_count INTEGER NOT NULL,recent TEXT NOT NULL,last_pass_time INTEGER,last_fail_time INTEGER,last_message TEXT,PRIMARY KEY(plugin_id,dimension));
CREATE TABLE IF NOT EXISTS plugin_health_history(plugin_id TEXT NOT NULL,bucket_time INTEGER NOT NULL,total_count INTEGER NOT NULL,success_count INTEGER NOT NULL,failure_count INTEGER NOT NULL,empty_count INTEGER NOT NULL,error_counts TEXT,PRIMARY KEY(plugin_id,bucket_time));
CREATE TABLE IF NOT EXISTS upstream_definitions(id TEXT PRIMARY KEY,source_kind TEXT NOT NULL,channel TEXT,name TEXT NOT NULL,description TEXT NOT NULL,url TEXT NOT NULL,method TEXT NOT NULL,format TEXT NOT NULL,enabled INTEGER NOT NULL,request_json TEXT,transform TEXT NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS deleted_upstreams(id TEXT PRIMARY KEY,deleted_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_upstream_definitions_lookup ON upstream_definitions(source_kind,enabled,id);
CREATE TRIGGER IF NOT EXISTS trg_upstreams_revision_insert AFTER INSERT ON upstream_definitions BEGIN UPDATE config_revisions SET revision=revision+1 WHERE scope='upstreams'; END;
CREATE TRIGGER IF NOT EXISTS trg_upstreams_revision_update AFTER UPDATE ON upstream_definitions BEGIN UPDATE config_revisions SET revision=revision+1 WHERE scope='upstreams'; END;
CREATE TRIGGER IF NOT EXISTS trg_upstreams_revision_delete AFTER DELETE ON upstream_definitions BEGIN UPDATE config_revisions SET revision=revision+1 WHERE scope='upstreams'; END;
CREATE TRIGGER IF NOT EXISTS trg_deleted_upstreams_revision_insert AFTER INSERT ON deleted_upstreams BEGIN UPDATE config_revisions SET revision=revision+1 WHERE scope='upstreams'; END;
CREATE TRIGGER IF NOT EXISTS trg_deleted_upstreams_revision_update AFTER UPDATE ON deleted_upstreams BEGIN UPDATE config_revisions SET revision=revision+1 WHERE scope='upstreams'; END;
CREATE TRIGGER IF NOT EXISTS trg_deleted_upstreams_revision_delete AFTER DELETE ON deleted_upstreams BEGIN UPDATE config_revisions SET revision=revision+1 WHERE scope='upstreams'; END;
`;

export function getSqliteDatabase(path?: string): SqliteDatabase {
  const resolved = normalizePath(path || DEFAULT_PATH);
  const existing = connections.get(resolved);
  if (existing) return existing;
  const created = new SqliteDatabase(resolved);
  connections.set(resolved, created);
  return created;
}
