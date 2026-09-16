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
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("temp_store = MEMORY");
    this.db.exec(SCHEMA);
    this.db.prepare("INSERT OR IGNORE INTO config_revisions(scope, revision) VALUES('sources', 0)").run();
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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS config_revisions(scope TEXT PRIMARY KEY,revision INTEGER NOT NULL CHECK(revision >= 0));
CREATE TABLE IF NOT EXISTS system_settings(id INTEGER PRIMARY KEY CHECK(id=1),default_concurrency INTEGER NOT NULL,request_timeout_ms INTEGER NOT NULL,cache_ttl_minutes INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS system_channels(kind TEXT NOT NULL,name TEXT NOT NULL,position INTEGER NOT NULL,PRIMARY KEY(kind,name));
CREATE INDEX IF NOT EXISTS idx_system_channels_order ON system_channels(kind,position,name);
CREATE TABLE IF NOT EXISTS search_settings(id INTEGER PRIMARY KEY CHECK(id=1),concurrency INTEGER,sources_configured INTEGER NOT NULL DEFAULT 0,channels_configured INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS search_setting_sources(source_id TEXT PRIMARY KEY,trashed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS search_setting_channels(channel TEXT PRIMARY KEY,position INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_search_setting_channels_position ON search_setting_channels(position,channel);
CREATE TABLE IF NOT EXISTS resource_sources(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,url TEXT NOT NULL,method TEXT NOT NULL,format TEXT NOT NULL,enabled INTEGER NOT NULL,request_json TEXT,transform TEXT NOT NULL,updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_resource_sources_enabled ON resource_sources(enabled,id);
CREATE TABLE IF NOT EXISTS deleted_sources(id TEXT PRIMARY KEY,deleted_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS source_template_settings(id INTEGER PRIMARY KEY CHECK(id=1),url_template TEXT NOT NULL,method TEXT NOT NULL,format TEXT NOT NULL,request_json TEXT,transform TEXT NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tg_channel_states(channel TEXT PRIMARY KEY,enabled INTEGER NOT NULL,deleted INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_tg_channel_states_deleted ON tg_channel_states(deleted,channel);
CREATE TABLE IF NOT EXISTS hot_searches(term TEXT PRIMARY KEY,score INTEGER NOT NULL CHECK(score >= 0),last_searched INTEGER NOT NULL,created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_hot_searches_rank ON hot_searches(score DESC,last_searched DESC);
CREATE TABLE IF NOT EXISTS tg_channel_health(id INTEGER PRIMARY KEY,channel TEXT NOT NULL,checked_at INTEGER NOT NULL,ok INTEGER NOT NULL,elapsed_ms INTEGER NOT NULL,results_count INTEGER NOT NULL,source TEXT NOT NULL,failure_kind TEXT,message TEXT);
CREATE INDEX IF NOT EXISTS idx_tg_channel_health_recent ON tg_channel_health(channel,checked_at DESC);
CREATE TABLE IF NOT EXISTS source_health(source_id TEXT PRIMARY KEY,snapshot_json TEXT NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  username_normalized TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  nickname TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  must_change_password INTEGER NOT NULL DEFAULT 0,
  custom_channels_json TEXT NOT NULL DEFAULT '[]',
  custom_channels_updated_at INTEGER NOT NULL,
  last_login_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE TABLE IF NOT EXISTS sessions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK(kind IN ('anonymous','user')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS search_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER,
  user_id INTEGER,
  keyword TEXT NOT NULL,
  ip TEXT NOT NULL,
  search_scope TEXT NOT NULL,
  channels_json TEXT NOT NULL DEFAULT '[]',
  source_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE SET NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_search_logs_created_at ON search_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_search_logs_user_id ON search_logs(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_search_logs_session_id ON search_logs(session_id,created_at DESC);
CREATE TABLE IF NOT EXISTS policy_settings(
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
DROP TRIGGER IF EXISTS trg_resource_sources_revision_insert;
CREATE TRIGGER trg_resource_sources_revision_insert AFTER INSERT ON resource_sources BEGIN UPDATE config_revisions SET revision=revision+1 WHERE scope='sources'; END;
DROP TRIGGER IF EXISTS trg_resource_sources_revision_update;
CREATE TRIGGER trg_resource_sources_revision_update AFTER UPDATE ON resource_sources BEGIN UPDATE config_revisions SET revision=revision+1 WHERE scope='sources'; END;
DROP TRIGGER IF EXISTS trg_resource_sources_revision_delete;
CREATE TRIGGER trg_resource_sources_revision_delete AFTER DELETE ON resource_sources BEGIN UPDATE config_revisions SET revision=revision+1 WHERE scope='sources'; END;
`;

export function getSqliteDatabase(path?: string): SqliteDatabase {
  const resolved = normalizePath(path || DEFAULT_PATH);
  const existing = connections.get(resolved);
  if (existing) return existing;
  const created = new SqliteDatabase(resolved);
  connections.set(resolved, created);
  return created;
}
