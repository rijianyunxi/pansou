import Database from "better-sqlite3";
import { randomBytes, randomInt, scryptSync } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { normalizeSearchKeyword } from "../utils/searchKeyword";

const DEFAULT_PATH = process.env.PANHUB_SQLITE_DB || "./data/panhub.sqlite";
const connections = new Map<string, SqliteDatabase>();
const normalizePath = (path: string): string => path === ":memory:" ? path : resolve(path);

/**
 * Upper bound on cached prepared statements. Several callers build SQL with a
 * variable-length `IN (?,?,…)` list, so distinct SQL texts can keep arriving;
 * the cap keeps the cache bounded and re-prepares the least recently used
 * statement instead of growing without limit.
 */
const MAX_CACHED_STATEMENTS = 256;

/** Thin typed-SQL wrapper around the application's normalized SQLite schema. */
export class SqliteDatabase {
  readonly path: string;
  private readonly db: Database.Database;
  /** Insertion-ordered, so the first key is the least recently used one. */
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
    this.migrateLegacySearchSources();
    this.retireSourceRecycleBin();
    this.ensureSessionChannelsColumn();
    this.ensureSessionTransportColumn();
    this.ensureResourceSourceColumns();
    this.ensureUserAccountColumns();
    this.ensureManagedResourceColumns();
    this.ensureProxyNodeSchema();
    this.ensureProxyNodeDefaults();
    this.ensureProxyRouteSchema();
    this.ensureProxyRoutingDefaults();
    this.ensureHotSearchColumns();
    this.ensureSearchAnalyticsColumns();
    this.ensureUserRolesAndDefaultAdmin();
    this.retireLegacyTables();
    this.retireRemovedPolicyKeys();
    this.db.prepare("INSERT OR IGNORE INTO config_revisions(scope, revision) VALUES('sources', 0)").run();
  }

  private ensureSessionTransportColumn(): void {
    const columns = this.db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "transport")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN transport TEXT NOT NULL DEFAULT 'cookie'");
    }
  }

  /** One-time upgrade from the removed global source/channel split. */
  private migrateLegacySearchSources(): void {
    const settingsColumns = this.db.prepare("PRAGMA table_info(search_settings)").all() as Array<{ name: string }>;
    if (!settingsColumns.some((column) => column.name === "channels_configured")) return;
    const legacyTable = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='search_setting_channels'").get();
    if (!legacyTable) return;
    const row = this.db.prepare("SELECT channels_configured FROM search_settings WHERE id=1").get() as { channels_configured?: number } | undefined;
    if (!row?.channels_configured) return;
    const legacySources = this.db.prepare("SELECT channel FROM search_setting_channels ORDER BY position").all() as Array<{ channel: string }>;
    this.db.transaction(() => {
      for (const item of legacySources) {
        this.db.prepare("INSERT INTO search_setting_sources(source_id) VALUES(?) ON CONFLICT(source_id) DO NOTHING").run(item.channel);
      }
      this.db.prepare("UPDATE search_settings SET sources_configured=1,channels_configured=0,updated_at=? WHERE id=1").run(Date.now());
      this.db.exec("DELETE FROM search_setting_channels");
    })();
  }

  /** Remove the retired resource-source recycle-bin state from old databases. */
  private retireSourceRecycleBin(): void {
    const columns = this.db.prepare("PRAGMA table_info(search_setting_sources)").all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === "trashed")) {
      this.db.transaction(() => {
        this.db.exec("CREATE TABLE search_setting_sources_new(source_id TEXT PRIMARY KEY)");
        this.db.exec("INSERT OR IGNORE INTO search_setting_sources_new(source_id) SELECT source_id FROM search_setting_sources WHERE trashed=0");
        this.db.exec("DROP TABLE search_setting_sources");
        this.db.exec("ALTER TABLE search_setting_sources_new RENAME TO search_setting_sources");
      })();
    }
    this.db.exec("DROP TABLE IF EXISTS deleted_sources");
  }

  private ensureSearchAnalyticsColumns(): void {
    // Click/copy telemetry is intentionally retired. It is no longer part of
    // the schema or any reporting path, so discard the old event table too.
    this.db.exec("DROP TABLE IF EXISTS search_events");
    const columns = this.db.prepare("PRAGMA table_info(search_logs)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "status")) {
      this.db.exec("ALTER TABLE search_logs ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'");
    }
    if (!columns.some((column) => column.name === "result_count")) {
      this.db.exec("ALTER TABLE search_logs ADD COLUMN result_count INTEGER NOT NULL DEFAULT 0");
    }
    if (!columns.some((column) => column.name === "has_results")) {
      this.db.exec("ALTER TABLE search_logs ADD COLUMN has_results INTEGER NOT NULL DEFAULT 0");
    }
    if (!columns.some((column) => column.name === "source_result_counts_json")) {
      this.db.exec("ALTER TABLE search_logs ADD COLUMN source_result_counts_json TEXT NOT NULL DEFAULT '{}'");
    }
    if (!columns.some((column) => column.name === "completed_at")) {
      this.db.exec("ALTER TABLE search_logs ADD COLUMN completed_at INTEGER");
    }
    if (!columns.some((column) => column.name === "outcome_recorded")) {
      this.db.exec("ALTER TABLE search_logs ADD COLUMN outcome_recorded INTEGER NOT NULL DEFAULT 0");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_search_logs_status_created_at ON search_logs(status,created_at DESC)");
  }

  private ensureSessionChannelsColumn(): void {
    const columns = this.db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "custom_channels_json")) {
      // Keep anonymous custom channels on the anonymous session rather than in
      // localStorage. This ALTER also upgrades databases created before this
      // column was introduced.
      this.db.exec("ALTER TABLE sessions ADD COLUMN custom_channels_json TEXT NOT NULL DEFAULT '[]'");
    }
  }

  private retireLegacyTables(): void {
    // Tables that no version of the runtime creates or reads any more: the
    // Telegram channel-health log (the Telegram feature is gone) and the WeChat
    // identity table that `auth_identities` replaced. Leaving them behind makes
    // the schema look like these concepts still exist.
    for (const table of ["tg_channel_health", "wechat_identities"]) {
      this.db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
  }

  private ensureResourceSourceColumns(): void {
    const columns = this.db.prepare("PRAGMA table_info(resource_sources)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "priority")) {
      // Older databases did not persist source ordering. Keep those sources at
      // the neutral priority while enabling priority-aware scheduling.
      this.db.exec("ALTER TABLE resource_sources ADD COLUMN priority INTEGER NOT NULL DEFAULT 0");
    }
    // Priority is a queue position, so the index is ascending to match the
    // catalog's ordering (a smaller value runs first).
    const priorityIndex = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_resource_sources_priority'").get() as { sql: string | null } | undefined;
    if (priorityIndex && /DESC/i.test(priorityIndex.sql || "")) this.db.exec("DROP INDEX idx_resource_sources_priority");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_resource_sources_priority ON resource_sources(priority,enabled,id)");
  }

  private ensureUserAccountColumns(): void {
    const columns = this.db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "last_login_ip")) {
      this.db.exec("ALTER TABLE users ADD COLUMN last_login_ip TEXT");
    }
    if (!columns.some((column) => column.name === "deleted_at")) {
      // Keep deleted accounts for audit/history while preventing them from
      // authenticating or appearing in the active user management list.
      this.db.exec("ALTER TABLE users ADD COLUMN deleted_at INTEGER");
    }
    // Accounts now authenticate through an external provider and the change-
    // password screen is gone, so nothing could ever clear this flag. Dropping
    // it removes the only way an account could be locked out permanently.
    if (columns.some((column) => column.name === "must_change_password")) {
      this.db.exec("ALTER TABLE users DROP COLUMN must_change_password");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON users(deleted_at)");
  }

  private retireRemovedPolicyKeys(): void {
    // Keys that no version of the runtime reads any more. `showLoginButton` lost
    // its only consumer when the homepage login button was removed; the others
    // belong to a superseded policy surface. Leaving them behind makes the
    // stored configuration look like it still controls something.
    const retired = [
      "showLoginButton",
      "registrationEnabled",
      "searchRateLimitWindowSeconds",
      "searchRateLimitPerSession",
      "searchRateLimitPerIp",
    ];
    const statement = this.db.prepare("DELETE FROM policy_settings WHERE key = ?");
    for (const key of retired) statement.run(key);
  }

  private randomUserId(): number {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const id = randomInt(100_000_000, 1_000_000_000);
      if (!this.db.prepare("SELECT 1 FROM users WHERE id = ?").get(id)) return id;
    }
    throw new Error("无法生成唯一用户 ID");
  }

  private ensureManagedResourceColumns(): void {
    const columns = this.db.prepare("PRAGMA table_info(managed_resources)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "search_text")) {
      this.db.exec("ALTER TABLE managed_resources ADD COLUMN search_text TEXT NOT NULL DEFAULT ''");
    }
    // The search projection is queried with `instr()`, which cannot use a
    // B-tree index, so the former idx_managed_resources_search_text only ever
    // added write cost. Drop it on existing databases too.
    this.db.exec("DROP INDEX IF EXISTS idx_managed_resources_search_text");

    // Disabling a resource has to be reversible without losing its id, links or
    // creation time, which a hard delete cannot offer. Search only returns
    // enabled rows; the console lists both states.
    if (!columns.some((column) => column.name === "enabled")) {
      this.db.exec("ALTER TABLE managed_resources ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1");
    }
    if (!columns.some((column) => column.name === "approval_status")) {
      this.db.exec("ALTER TABLE managed_resources ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'approved'");
    }
    if (!columns.some((column) => column.name === "check_status")) {
      this.db.exec("ALTER TABLE managed_resources ADD COLUMN check_status TEXT NOT NULL DEFAULT 'unchecked'");
    }
    if (!columns.some((column) => column.name === "check_message")) {
      this.db.exec("ALTER TABLE managed_resources ADD COLUMN check_message TEXT");
    }
    if (!columns.some((column) => column.name === "checked_at")) {
      this.db.exec("ALTER TABLE managed_resources ADD COLUMN checked_at INTEGER");
    }

    // The console now matches the same normalized projection as the search path,
    // so nothing queries `name` directly any more and this index only added write
    // cost. Drop it on existing databases too.
    this.db.exec("DROP INDEX IF EXISTS idx_managed_resources_name");

    // Backfill the normalized search projection once for databases created
    // before the projection existed. The projection is maintained by the
    // managed-resource service for all subsequent writes.
    const rows = this.db.prepare("SELECT id,name,description,tags_json FROM managed_resources WHERE search_text = '' OR search_text IS NULL").all() as Array<{ id: string; name: string; description: string | null; tags_json: string | null }>;
    if (!rows.length) return;
    const update = this.db.prepare("UPDATE managed_resources SET search_text = ? WHERE id = ?");
    const backfill = this.db.transaction(() => {
      for (const row of rows) {
        let tags: string[] = [];
        try {
          const parsed = JSON.parse(row.tags_json || "[]");
          tags = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
        } catch {
          tags = [];
        }
        update.run(normalizeSearchKeyword([row.name, row.description || "", ...tags].join(" ")), row.id);
      }
    });
    backfill();
  }

  private ensureProxyNodeSchema(): void {
    const columns = this.db.prepare("PRAGMA table_info(proxy_nodes)").all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === "kind")) {
      // Preserve the legacy direct row as the new system-managed node before
      // dropping its discriminator column. The empty address is its marker.
      this.db.prepare("UPDATE proxy_nodes SET base_url='' WHERE kind='direct'").run();
      this.db.exec("ALTER TABLE proxy_nodes DROP COLUMN kind");
    }
    if (columns.some((column) => column.name === "weight")) {
      this.db.exec("DROP INDEX IF EXISTS idx_proxy_nodes_selection");
      this.db.exec("ALTER TABLE proxy_nodes DROP COLUMN weight");
    }
  }

  private ensureProxyNodeDefaults(): void {
    const now = Date.now();
    this.db.prepare(
      "INSERT OR IGNORE INTO proxy_nodes(id,name,base_url,enabled,daily_limit,quota_day,quota_used,circuit_state,failure_count,probe_in_flight,opened_until,last_status,last_error,last_success_at,last_failure_at,created_at,updated_at) VALUES('direct','直连目标站点','',1,0,'',0,'closed',0,0,NULL,NULL,NULL,NULL,NULL,?,?)",
    ).run(now, now);
    const legacyDirectNodes = this.db.prepare("SELECT id FROM proxy_nodes WHERE base_url='' AND id<>'direct'").all() as Array<{ id: string }>;
    for (const legacy of legacyDirectNodes) {
      this.db.prepare("INSERT OR IGNORE INTO proxy_group_nodes(group_id,node_id,weight) SELECT group_id,'direct',weight FROM proxy_group_nodes WHERE node_id=?").run(legacy.id);
      this.db.prepare("DELETE FROM proxy_nodes WHERE id=?").run(legacy.id);
    }
    if (this.db.prepare("SELECT 1 FROM proxy_nodes WHERE id<>'direct' LIMIT 1").get()) return;
    const defaults = [
      {
        id: "worker-frosty-mouse",
        name: "Worker · frosty-mouse",
        baseUrl: "https://frosty-mouse-58c9.691736657.workers.dev",
      },
      {
        id: "worker-wild-glade",
        name: "Worker · wild-glade",
        baseUrl: "https://wild-glade-8d69.mr-songjintao.workers.dev",
      },
    ];
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO proxy_nodes(id,name,base_url,enabled,daily_limit,quota_day,quota_used,circuit_state,failure_count,probe_in_flight,opened_until,last_status,last_error,last_success_at,last_failure_at,created_at,updated_at) VALUES(?,?,?,1,0,'',0,'closed',0,0,NULL,NULL,NULL,NULL,NULL,?,?)",
    );
    const seed = this.db.transaction(() => {
      for (const item of defaults) insert.run(item.id, item.name, item.baseUrl, now, now);
    });
    seed();
  }

  private ensureProxyRouteSchema(): void {
    const columns = this.db.prepare("PRAGMA table_info(proxy_routes)").all() as Array<{ name: string }>;
    const hasSourceIds = columns.some((column) => column.name === "source_ids_json");
    const hasDomainFields = columns.some((column) => column.name === "match_type") || columns.some((column) => column.name === "domains_json");
    if (!hasDomainFields && hasSourceIds) return;

    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE proxy_routes_new(
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 100,
          enabled INTEGER NOT NULL DEFAULT 1,
          source_ids_json TEXT NOT NULL DEFAULT '[]',
          action TEXT NOT NULL CHECK(action IN ('direct','group')),
          group_id TEXT REFERENCES proxy_groups(id) ON DELETE SET NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      const insert = this.db.prepare("INSERT INTO proxy_routes_new(id,name,priority,enabled,source_ids_json,action,group_id,created_at,updated_at) SELECT id,name,priority,enabled,'[]',action,group_id,created_at,updated_at FROM proxy_routes");
      insert.run();
      this.db.exec("DROP TABLE proxy_routes");
      this.db.exec("ALTER TABLE proxy_routes_new RENAME TO proxy_routes");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_proxy_routes_order ON proxy_routes(enabled,priority,id)");
    })();
  }

  private ensureProxyRoutingDefaults(): void {
    const now = Date.now();
    const shouldSeedMembers = !this.db.prepare("SELECT 1 FROM proxy_groups LIMIT 1").get();
    const insertGroup = this.db.prepare(
      "INSERT OR IGNORE INTO proxy_groups(id,name,description,enabled,fallback_action,created_at,updated_at) VALUES(?,?,?,1,'error',?,?)",
    );
    this.db.prepare("INSERT OR IGNORE INTO proxy_groups(id,name,description,enabled,fallback_action,created_at,updated_at) VALUES(?,?,?,1,?,?,?)").run("telegram", "Telegram 组", "用于 Telegram 资源源", "direct", now, now);
    insertGroup.run("general", "通用代理组", "用于其他资源源", now, now);

    if (shouldSeedMembers) {
      const nodes = this.db.prepare("SELECT id,name,base_url FROM proxy_nodes").all() as Array<{ id: string; name: string; base_url: string }>;
      const add = this.db.prepare("INSERT OR IGNORE INTO proxy_group_nodes(group_id,node_id,weight) VALUES(?,?,?)");
      for (const node of nodes) {
        const text = `${node.name} ${node.base_url}`.toLowerCase();
        const isTencent = /腾讯|tencent|edgeone|edge\.one|qcloud/.test(text);
        if (!isTencent && node.id !== "direct") add.run("telegram", node.id, 1);
        if (isTencent) add.run("general", node.id, 1);
      }
    }
    // Every strategy uses a node group. Convert any stale direct action while
    // the route table is being upgraded so the direct node remains selectable.
    const directRoutes = this.db.prepare("SELECT id,name FROM proxy_routes WHERE action='direct'").all() as Array<{ id: string; name: string }>;
    for (const route of directRoutes) {
      const groupId = `${route.id}-direct`.slice(0, 64);
      this.db.prepare("INSERT OR IGNORE INTO proxy_groups(id,name,description,enabled,fallback_action,created_at,updated_at) VALUES(?,?,?,1,'error',?,?)").run(groupId, `${route.name} 节点`, "由旧版直连策略迁移", now, now);
      this.db.prepare("INSERT OR IGNORE INTO proxy_group_nodes(group_id,node_id,weight) VALUES(?,?,1)").run(groupId, "direct");
      this.db.prepare("UPDATE proxy_routes SET action='group',group_id=?,updated_at=? WHERE id=?").run(groupId, now, route.id);
    }
    const routeCount = this.db.prepare("SELECT COUNT(*) AS count FROM proxy_routes").get() as { count: number };
    if (!routeCount.count) {
      const addRoute = this.db.prepare("INSERT OR IGNORE INTO proxy_routes(id,name,priority,enabled,source_ids_json,action,group_id,created_at,updated_at) VALUES(?,?,?,1,?,?,?,?,?)");
      addRoute.run("telegram", "Telegram 资源源", 10, "[]", "group", "telegram", now, now);
      addRoute.run("general", "其他资源源", 1000, "[]", "group", "general", now, now);
    }
    // Bind the built-in policies to the current resource catalog once.
    const sources = this.db.prepare("SELECT id,url FROM resource_sources").all() as Array<{ id: string; url: string }>;
    const telegramIds = sources.filter((source) => {
      try { const host = new URL(source.url).hostname.toLowerCase(); return host === "t.me" || host === "www.t.me" || host === "telegram.me" || host.endsWith(".telegram.me"); } catch { return false; }
    }).map((source) => source.id);
    const generalIds = sources.filter((source) => !telegramIds.includes(source.id)).map((source) => source.id);
    const bindRoute = this.db.prepare("UPDATE proxy_routes SET source_ids_json=?,updated_at=? WHERE id=? AND (source_ids_json IS NULL OR source_ids_json='[]')");
    if (telegramIds.length) bindRoute.run(JSON.stringify(telegramIds), now, "telegram");
    if (generalIds.length) bindRoute.run(JSON.stringify(generalIds), now, "general");
  }

  private ensureHotSearchColumns(): void {
    const columns = this.db.prepare("PRAGMA table_info(hot_searches)").all() as Array<{ name: string }>;
    const add = (sql: string, name: string) => {
      if (!columns.some((column) => column.name === name)) this.db.exec(sql);
    };
    add("ALTER TABLE hot_searches ADD COLUMN normalized_term TEXT NOT NULL DEFAULT ''", "normalized_term");
    add("ALTER TABLE hot_searches ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'", "status");
    add("ALTER TABLE hot_searches ADD COLUMN source TEXT NOT NULL DEFAULT 'auto'", "source");
    add("ALTER TABLE hot_searches ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0", "pinned");
    add("ALTER TABLE hot_searches ADD COLUMN manual_weight INTEGER NOT NULL DEFAULT 0", "manual_weight");
    add("ALTER TABLE hot_searches ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0", "updated_at");
    this.db.exec("UPDATE hot_searches SET normalized_term = lower(trim(term)) WHERE normalized_term = '' OR normalized_term IS NULL");
    this.db.exec("UPDATE hot_searches SET updated_at = CASE WHEN updated_at = 0 THEN last_searched ELSE updated_at END");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_hot_searches_status_rank ON hot_searches(status,pinned DESC,manual_weight DESC,score DESC,last_searched DESC)");
    // The former hot-search blacklist table is intentionally retired. Existing
    // rules are discarded during startup; manual hot-search status management
    // remains available through hot_searches.status.
    this.db.exec("DROP TABLE IF EXISTS hot_search_rules");
  }

  private ensureUserRolesAndDefaultAdmin(): void {
    const columns = this.db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "role")) {
      this.db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)");

    const existingAdmin = this.db.prepare("SELECT id FROM users WHERE role = 'admin' AND deleted_at IS NULL ORDER BY id LIMIT 1").get() as { id: number } | undefined;
    if (existingAdmin) return;

    const legacyAdmin = this.db.prepare("SELECT id FROM users WHERE username_normalized = ? AND deleted_at IS NULL").get("admin") as { id: number } | undefined;
    if (legacyAdmin) {
      // A database that already carries an `admin` row keeps whatever password
      // it has. Rewriting it to a known value would silently weaken a credential
      // the operator may have chosen deliberately, and this is the only account
      // that can still sign in with a password.
      this.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(legacyAdmin.id);
      return;
    }

    const timestamp = Date.now();
    const { password, generated } = this.initialAdminPassword();
    this.db.prepare("INSERT INTO users(id,username,username_normalized,password_hash,nickname,role,status,custom_channels_json,custom_channels_updated_at,last_login_ip,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(
      this.randomUserId(), "admin", "admin", this.hashPassword(password), "系统管理员", "admin", "active", "[]", timestamp, null, timestamp, timestamp,
    );
    if (generated) {
      // Printed once, on the run that creates the account. Nothing else can
      // recover it — there is no password-reset path for administrators, only
      // the console's own "change credentials" screen — so it has to be
      // captured here and changed immediately.
      console.warn(`[PanHub][bootstrap] 已创建初始管理员账号 admin，口令：${password}（仅打印这一次，请登录后台后立即修改）`);
    }
  }

  /**
   * Password for a freshly created initial administrator.
   *
   * `PANHUB_ADMIN_INITIAL_PASSWORD` lets a deployment pin it (the test suite
   * does too). Without it a random value is generated, so the repository ships
   * no default credential that every installation would share.
   */
  private initialAdminPassword(): { password: string; generated: boolean } {
    const configured = process.env.PANHUB_ADMIN_INITIAL_PASSWORD?.trim();
    if (configured) return { password: configured, generated: false };
    return { password: randomBytes(18).toString("base64url"), generated: true };
  }

  private hashPassword(password: string): string {
    const salt = randomBytes(16);
    const derived = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return `scrypt$16384$8$1$${salt.toString("base64url")}$${derived.toString("base64url")}`;
  }

  private statement(sql: string): Database.Statement {
    const cached = this.statements.get(sql);
    if (cached) {
      // Re-insert to mark as most recently used.
      this.statements.delete(sql);
      this.statements.set(sql, cached);
      return cached;
    }
    const statement = this.db.prepare(sql);
    this.statements.set(sql, statement);
    if (this.statements.size > MAX_CACHED_STATEMENTS) {
      const oldest = this.statements.keys().next().value as string | undefined;
      // Dropping the reference is enough; the statement finalizes on collection
      // and an in-flight iterator keeps its own reference alive.
      if (oldest !== undefined) this.statements.delete(oldest);
    }
    return statement;
  }
  exec(sql: string): void { this.db.exec(sql); }
  run(sql: string, ...params: unknown[]): Database.RunResult { return this.statement(sql).run(...params); }
  getRow<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined { return this.statement(sql).get(...params) as T | undefined; }
  allRows<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] { return this.statement(sql).all(...params) as T[]; }
  /**
   * Stream rows instead of materializing them. Use for scans that stop early,
   * so a full table read is not paid once per page.
   */
  iterate<T = Record<string, unknown>>(sql: string, ...params: unknown[]): IterableIterator<T> {
    return this.statement(sql).iterate(...params) as IterableIterator<T>;
  }
  transaction<T>(callback: () => T): T { return this.db.transaction(callback)(); }
  close(): void { this.statements.clear(); this.db.close(); }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS config_revisions(scope TEXT PRIMARY KEY,revision INTEGER NOT NULL CHECK(revision >= 0));
CREATE TABLE IF NOT EXISTS system_settings(id INTEGER PRIMARY KEY CHECK(id=1),default_concurrency INTEGER NOT NULL,request_timeout_ms INTEGER NOT NULL,cache_ttl_minutes INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS search_settings(id INTEGER PRIMARY KEY CHECK(id=1),concurrency INTEGER,sources_configured INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS search_setting_sources(source_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS resource_sources(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,url TEXT NOT NULL,method TEXT NOT NULL,format TEXT NOT NULL,priority INTEGER NOT NULL DEFAULT 0,enabled INTEGER NOT NULL,request_json TEXT,transform TEXT NOT NULL,updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_resource_sources_enabled ON resource_sources(enabled,id);
CREATE TABLE IF NOT EXISTS source_template_settings(id INTEGER PRIMARY KEY CHECK(id=1),url_template TEXT NOT NULL,method TEXT NOT NULL,format TEXT NOT NULL,request_json TEXT,transform TEXT NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS hot_searches(term TEXT PRIMARY KEY,normalized_term TEXT NOT NULL DEFAULT '',score INTEGER NOT NULL CHECK(score >= 0),last_searched INTEGER NOT NULL,created_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'approved',source TEXT NOT NULL DEFAULT 'auto',pinned INTEGER NOT NULL DEFAULT 0,manual_weight INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_hot_searches_rank ON hot_searches(score DESC,last_searched DESC);
CREATE TABLE IF NOT EXISTS source_health(source_id TEXT PRIMARY KEY,snapshot_json TEXT NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS proxy_nodes(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  daily_limit INTEGER NOT NULL DEFAULT 0 CHECK(daily_limit >= 0),
  quota_day TEXT NOT NULL DEFAULT '',
  quota_used INTEGER NOT NULL DEFAULT 0 CHECK(quota_used >= 0),
  circuit_state TEXT NOT NULL DEFAULT 'closed' CHECK(circuit_state IN ('closed','open','half-open','quota_exhausted')),
  failure_count INTEGER NOT NULL DEFAULT 0,
  probe_in_flight INTEGER NOT NULL DEFAULT 0,
  opened_until INTEGER,
  last_status INTEGER,
  last_error TEXT,
  last_success_at INTEGER,
  last_failure_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proxy_nodes_selection ON proxy_nodes(enabled,circuit_state);
CREATE TABLE IF NOT EXISTS proxy_groups(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  fallback_action TEXT NOT NULL DEFAULT 'error' CHECK(fallback_action IN ('error','direct')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS proxy_group_nodes(
  group_id TEXT NOT NULL REFERENCES proxy_groups(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES proxy_nodes(id) ON DELETE CASCADE,
  weight INTEGER NOT NULL DEFAULT 1 CHECK(weight >= 1 AND weight <= 100),
  PRIMARY KEY(group_id,node_id)
);
CREATE INDEX IF NOT EXISTS idx_proxy_group_nodes_group ON proxy_group_nodes(group_id,weight);
CREATE TABLE IF NOT EXISTS proxy_routes(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  enabled INTEGER NOT NULL DEFAULT 1,
  source_ids_json TEXT NOT NULL DEFAULT '[]',
  action TEXT NOT NULL CHECK(action IN ('direct','group')),
  group_id TEXT REFERENCES proxy_groups(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proxy_routes_order ON proxy_routes(enabled,priority,id);
CREATE TABLE IF NOT EXISTS managed_resources(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  datetime TEXT,
  cloud_types_json TEXT NOT NULL,
  links_json TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  images_json TEXT NOT NULL DEFAULT '[]',
  search_text TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  approval_status TEXT NOT NULL DEFAULT 'approved' CHECK(approval_status IN ('pending','approved','rejected')),
  check_status TEXT NOT NULL DEFAULT 'unchecked',
  check_message TEXT,
  checked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_managed_resources_updated_at ON managed_resources(updated_at DESC);
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL,
  username_normalized TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  nickname TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  custom_channels_json TEXT NOT NULL DEFAULT '[]',
  custom_channels_updated_at INTEGER NOT NULL,
  last_login_ip TEXT,
  last_login_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE TABLE IF NOT EXISTS auth_identities(
  provider TEXT NOT NULL,
  provider_app_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  provider_union_id TEXT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(provider, provider_app_id, subject),
  UNIQUE(provider, provider_app_id, user_id)
);
CREATE TABLE IF NOT EXISTS login_tickets(
  ticket TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('pending','confirmed','consumed')),
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  ip TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_login_tickets_expires_at ON login_tickets(expires_at);
CREATE TABLE IF NOT EXISTS wechat_mini_settings(id INTEGER PRIMARY KEY CHECK(id=1),app_id TEXT NOT NULL DEFAULT '',secret TEXT NOT NULL DEFAULT '',qr_page TEXT NOT NULL DEFAULT 'pages/login/index',env_version TEXT NOT NULL DEFAULT 'release',updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK(kind IN ('anonymous','user')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  custom_channels_json TEXT NOT NULL DEFAULT '[]'
);CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
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
  status TEXT NOT NULL DEFAULT 'started' CHECK(status IN ('started','completed','failed')),
  result_count INTEGER NOT NULL DEFAULT 0,
  has_results INTEGER NOT NULL DEFAULT 0,
  source_result_counts_json TEXT NOT NULL DEFAULT '{}',
  completed_at INTEGER,
  outcome_recorded INTEGER NOT NULL DEFAULT 0,
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
