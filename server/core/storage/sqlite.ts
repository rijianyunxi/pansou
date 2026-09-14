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

  constructor(path = DEFAULT_PATH) {
    this.path = normalizePath(path);
    if (this.path !== ":memory:") mkdirSync(dirname(this.path), { recursive: true });
    this.db = new Database(this.path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(SCHEMA);
    // These tables belonged to the removed JSON/KV compatibility layer.
    this.db.exec("DROP TABLE IF EXISTS json_store; DROP TABLE IF EXISTS legacy_kv; DROP TABLE IF EXISTS schema_meta;");
  }

  exec(sql: string): void { this.db.exec(sql); }
  run(sql: string, ...params: unknown[]): Database.RunResult { return this.db.prepare(sql).run(...params); }
  getRow<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined { return this.db.prepare(sql).get(...params) as T | undefined; }
  allRows<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] { return this.db.prepare(sql).all(...params) as T[]; }
  transaction<T>(callback: () => T): T { return this.db.transaction(callback)(); }
  close(): void { this.db.close(); }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS system_settings(id INTEGER PRIMARY KEY CHECK(id=1),default_concurrency INTEGER NOT NULL,plugin_timeout_ms INTEGER NOT NULL,cache_ttl_minutes INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS system_channels(kind TEXT NOT NULL,name TEXT NOT NULL,position INTEGER NOT NULL,PRIMARY KEY(kind,name));
CREATE TABLE IF NOT EXISTS tg_source_settings(id INTEGER PRIMARY KEY CHECK(id=1),direct_template TEXT NOT NULL,jina_template TEXT NOT NULL,user_agent TEXT NOT NULL,headers TEXT NOT NULL,transform TEXT NOT NULL,fallback_urls TEXT NOT NULL,max_retries INTEGER NOT NULL,delay_ms INTEGER NOT NULL,parser_version TEXT NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS search_settings(id INTEGER PRIMARY KEY CHECK(id=1),concurrency INTEGER,plugin_timeout_ms INTEGER,plugins_configured INTEGER NOT NULL DEFAULT 0,channels_configured INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS search_setting_plugins(plugin_id TEXT PRIMARY KEY,trashed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS search_setting_channels(channel TEXT PRIMARY KEY,position INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tg_channel_policies(channel TEXT PRIMARY KEY,timeout_ms INTEGER,max_pages INTEGER,max_results INTEGER,max_retries INTEGER,retry_delay_ms INTEGER,fallback TEXT,fallback_urls TEXT,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tg_channel_states(channel TEXT PRIMARY KEY,enabled INTEGER NOT NULL,deleted INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS parser_bindings(scope TEXT NOT NULL CHECK(scope IN ('telegram','upstream')),source_id TEXT NOT NULL,plugin_id TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(scope,source_id));
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

export function getSqliteDatabase(path?: string): SqliteDatabase {
  const resolved = normalizePath(path || DEFAULT_PATH);
  const existing = connections.get(resolved);
  if (existing) return existing;
  const created = new SqliteDatabase(resolved);
  connections.set(resolved, created);
  return created;
}

export function resetSqliteDatabase(path?: string): void {
  const resolved = normalizePath(path || DEFAULT_PATH);
  const existing = connections.get(resolved);
  if (!existing) return;
  existing.close();
  connections.delete(resolved);
}
