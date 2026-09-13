import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface SqliteJsonStoreOptions {
  path?: string;
}

// Vitest may preserve the caller's NODE_ENV (for example when it is started
// from a development shell), so NODE_ENV alone is not enough to isolate tests.
// Never let unit tests mutate the developer runtime database.
const IS_TEST_RUNTIME = process.env.NODE_ENV === "test" ||
  process.env.VITEST === "true" ||
  Boolean(process.env.VITEST_WORKER_ID);
const DEFAULT_PATH = process.env.PANHUB_SQLITE_DB ||
  (IS_TEST_RUNTIME ? ":memory:" : "./data/panhub.sqlite");
const connections = new Map<string, SqliteDatabase>();

function clone<T>(value: T): T {
  return structuredClone(value);
}

function normalizePath(path: string): string {
  return path === ":memory:" ? path : resolve(path);
}

/**
 * Small synchronous SQLite persistence layer for the single Node process.
 * SQLite is intentionally used as a JSON document store here: configuration
 * records already have versioned JSON schemas, while transactions/WAL give us
 * atomic writes and one durable source of truth without scattering file stores.
 */
export class SqliteDatabase {
  readonly path: string;
  private readonly db: Database.Database;
  private readonly getStatement;
  private readonly setStatement;
  private readonly deleteStatement;

  constructor(path = DEFAULT_PATH) {
    this.path = normalizePath(path);
    if (this.path !== ":memory:") {
      mkdirSync(dirname(this.path), { recursive: true });
      this.migrateLegacyFiles();
    }
    this.db = new Database(this.path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS json_store (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (namespace, key)
      );
      CREATE INDEX IF NOT EXISTS idx_json_store_namespace
        ON json_store(namespace);
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.getStatement = this.db.prepare(
      "SELECT value FROM json_store WHERE namespace = ? AND key = ?",
    );
    this.setStatement = this.db.prepare(
      `INSERT INTO json_store(namespace, key, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(namespace, key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
    );
    this.deleteStatement = this.db.prepare(
      "DELETE FROM json_store WHERE namespace = ? AND key = ?",
    );
  }

  get<T>(namespace: string, key: string, fallback: T): T {
    const row = this.getStatement.get(namespace, key) as { value?: string } | undefined;
    if (!row?.value) return clone(fallback);
    try {
      return clone(JSON.parse(row.value) as T);
    } catch {
      return clone(fallback);
    }
  }

  set<T>(namespace: string, key: string, value: T): void {
    this.setStatement.run(namespace, key, JSON.stringify(value), Date.now());
  }

  getUpdatedAt(namespace: string, key: string): number | null {
    const row = this.db.prepare("SELECT updated_at FROM json_store WHERE namespace = ? AND key = ?")
      .get(namespace, key) as { updated_at?: number } | undefined;
    return typeof row?.updated_at === "number" ? row.updated_at : null;
  }

  delete(namespace: string, key: string): void {
    this.deleteStatement.run(namespace, key);
  }

  list<T>(namespace: string): Array<{ key: string; value: T }> {
    const rows = this.db
      .prepare("SELECT key, value FROM json_store WHERE namespace = ? ORDER BY key")
      .all(namespace) as Array<{ key: string; value: string }>;
    return rows.flatMap((row) => {
      try {
        return [{ key: row.key, value: clone(JSON.parse(row.value) as T) }];
      } catch {
        return [];
      }
    });
  }

  transaction<T>(callback: () => T): T {
    return this.db.transaction(callback)();
  }

  close(): void {
    this.db.close();
  }

  private migrateLegacyFiles(): void {
    // The database itself does not exist yet. Import the old JSON files once,
    // preserving them as a recovery copy instead of deleting user data.
    if (existsSync(this.path)) return;
    const baseDir = process.env.PANHUB_LEGACY_DATA_DIR?.trim()
      ? resolve(process.env.PANHUB_LEGACY_DATA_DIR)
      : dirname(this.path);
    const legacy = [
      ["search_settings", "state", "search-settings.json"],
      ["tg_channel_settings", "state", "tg-channel-settings.json"],
      ["tg_channel_health", "state", "tg-channel-health.json"],
      ["plugin_health", "state", "plugin-health.json"],
      ["hot_searches", "items", "hot-searches.json"],
      ["plugin_repository", "state", "plugins.json"],
      ["plugin_secrets", "state", "plugin-secrets.json"],
    ] as const;
    const pending: Array<[string, string, unknown]> = [];
    for (const [namespace, key, filename] of legacy) {
      const file = resolve(baseDir, filename);
      if (!existsSync(file)) continue;
      try {
        pending.push([namespace, key, JSON.parse(readFileSync(file, "utf8"))]);
      } catch {
        // A malformed legacy file is left untouched and will be reported by
        // the owning store's normal defaults/sanitization path.
      }
    }
    if (!pending.length) return;
    // Create the DB first, then write imports through a short-lived connection.
    const db = new Database(this.path);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS json_store (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (namespace, key)
      );
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const insert = db.prepare(
      `INSERT OR IGNORE INTO json_store(namespace, key, value, updated_at)
       VALUES (?, ?, ?, ?)`,
    );
    const migrate = db.transaction(() => {
      for (const [namespace, key, value] of pending) {
        insert.run(namespace, key, JSON.stringify(value), Date.now());
      }
      db.prepare(
        "INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('legacy_json_migrated', ?)",
      ).run(new Date().toISOString());
    });
    migrate();
    db.close();
  }
}

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
  if (existing) {
    existing.close();
    connections.delete(resolved);
  }
}
