import { createHash } from "node:crypto";
import type { InstructionPluginDefinition } from "../instructions/types";
import { validateInstructionDefinition } from "../instructions/validator";
import { getSqliteDatabase } from "../storage/sqlite";

export type PluginRecordStatus =
  | "draft"
  | "validated"
  | "published"
  | "disabled"
  | "archived";

export interface PluginVersion {
  version: string;
  definition: InstructionPluginDefinition;
  createdAt: string;
  createdBy: string;
  changelog?: string;
}

export interface PluginValidationReport {
  valid: boolean;
  version: string;
  checkedAt: string;
  errors: string[];
  sampleParsed: boolean;
  sampleResultCount?: number;
}

export type PluginAuditAction =
  | "draft_saved"
  | "validated"
  | "validation_failed"
  | "debugged"
  | "debug_failed"
  | "published"
  | "disabled"
  | "enabled"
  | "rolled_back"
  | "archived"
  | "restored"
  | "secret_set"
  | "secret_deleted";

export interface PluginAuditEntry {
  action: PluginAuditAction;
  actor: string;
  createdAt: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface PluginRecord {
  id: string;
  /** Lifecycle state of the latest editable definition. */
  status: PluginRecordStatus;
  /** Latest draft/working definition; never used as the live definition directly. */
  definition: InstructionPluginDefinition;
  /** Immutable version currently serving traffic, even while a newer draft exists. */
  publishedVersion?: string;
  versions: PluginVersion[];
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  validation?: PluginValidationReport;
  auditTrail: PluginAuditEntry[];
}

export interface PluginValidationInput {
  sampleParsed?: boolean;
  sampleResultCount?: number;
  errors?: string[];
}

/** Capability for configuration-version checks used by PluginManager. */
export interface RepositoryVersionCheck {
  /** Current version signature of the persisted configuration. */
  getConfigVersion(): Promise<string | null>;
  /** Whether the persisted configuration changed since the last check. */
  refreshIfChanged(): Promise<boolean>;
}

/** Narrows a repository to the version-check capability when available. */
export function asVersionCheckable(
  repository: PluginRepository
): RepositoryVersionCheck | undefined {
  const candidate = repository as PluginRepository & Partial<RepositoryVersionCheck>;
  return typeof candidate.getConfigVersion === "function" &&
    typeof candidate.refreshIfChanged === "function"
    ? (candidate as RepositoryVersionCheck)
    : undefined;
}

export interface PluginRepository {
  list(options?: { includeArchived?: boolean }): Promise<PluginRecord[]>;
  get(id: string): Promise<PluginRecord | undefined>;
  saveDraft(
    definition: InstructionPluginDefinition,
    actor?: string,
    changelog?: string
  ): Promise<PluginRecord>;
  validate(
    id: string,
    actor?: string,
    input?: PluginValidationInput
  ): Promise<PluginRecord>;
  publish(id: string, actor?: string): Promise<PluginRecord>;
  disable(id: string, actor?: string): Promise<PluginRecord>;
  enable(id: string, actor?: string): Promise<PluginRecord>;
  rollback(id: string, version: string, actor?: string): Promise<PluginRecord>;
  archive(id: string, actor?: string): Promise<PluginRecord>;
  restore(id: string, actor?: string): Promise<PluginRecord>;
  purge(id: string, actor?: string): Promise<void>;
  audit(
    id: string,
    action: PluginAuditAction,
    actor?: string,
    metadata?: PluginAuditEntry["metadata"]
  ): Promise<PluginRecord>;
}

type RepositoryFile = { records: Record<string, PluginRecord> };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sameDefinition(
  left: InstructionPluginDefinition,
  right: InstructionPluginDefinition
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Resolves the immutable definition serving traffic for a record. */
export function resolvePublishedDefinition(
  record: PluginRecord
): InstructionPluginDefinition | undefined {
  if (!record.publishedVersion || ["disabled", "archived"].includes(record.status)) {
    return undefined;
  }
  return clone(
    record.versions.find((item) => item.version === record.publishedVersion)
      ?.definition
  );
}

/** SQLite-backed repository used by the application. */
export class SqlitePluginRepository implements PluginRepository, RepositoryVersionCheck {
  private read(): RepositoryFile {
    const db = getSqliteDatabase();
    const parse = <T>(value: string | null | undefined, fallback: T): T => {
      try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
    };
    const records: Record<string, PluginRecord> = {};
    for (const row of db.allRows<any>("SELECT * FROM plugin_records ORDER BY id")) {
      const versions = db.allRows<any>("SELECT * FROM plugin_versions WHERE plugin_id=? ORDER BY created_at, version", row.id)
        .map(version => ({ version: version.version, definition: parse(version.definition, {} as InstructionPluginDefinition), createdAt: version.created_at, createdBy: version.created_by, ...(version.changelog ? { changelog: version.changelog } : {}) }));
      const auditTrail = db.allRows<any>("SELECT * FROM plugin_audit WHERE plugin_id=? ORDER BY seq", row.id)
        .map(entry => ({ action: entry.action, actor: entry.actor, createdAt: entry.created_at, ...(entry.metadata ? { metadata: parse(entry.metadata, {}) } : {}) })) as PluginAuditEntry[];
      records[row.id] = {
        id: row.id,
        status: row.status,
        definition: parse(row.definition, {} as InstructionPluginDefinition),
        ...(row.published_version ? { publishedVersion: row.published_version } : {}),
        versions,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
        ...(row.validation ? { validation: parse(row.validation, undefined) } : {}),
        auditTrail,
      };
    }
    return { records };
  }

  private write(state: RepositoryFile): void {
    const db = getSqliteDatabase();
    db.transaction(() => {
      db.run("DELETE FROM plugin_audit");
      db.run("DELETE FROM plugin_versions");
      db.run("DELETE FROM plugin_records");
      for (const record of Object.values(state.records)) {
        db.run("INSERT INTO plugin_records(id,status,published_version,definition,created_at,updated_at,updated_by,validation,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?)",
          record.id, record.status, record.publishedVersion || null, JSON.stringify(record.definition), record.createdAt, record.updatedAt, record.updatedBy, record.validation ? JSON.stringify(record.validation) : null, Date.now());
        for (const version of record.versions || []) db.run("INSERT INTO plugin_versions(plugin_id,version,definition,created_at,created_by,changelog) VALUES(?,?,?,?,?,?)", record.id, version.version, JSON.stringify(version.definition), version.createdAt, version.createdBy, version.changelog || null);
        for (const [index, entry] of (record.auditTrail || []).entries()) db.run("INSERT INTO plugin_audit(plugin_id,seq,action,actor,created_at,metadata) VALUES(?,?,?,?,?,?)", record.id, index + 1, entry.action, entry.actor, entry.createdAt, entry.metadata ? JSON.stringify(entry.metadata) : null);
      }
    });
  }

  async getConfigVersion(): Promise<string> {
    const state = this.read();
    const digest = createHash("sha256").update(JSON.stringify(state)).digest("hex");
    const row = getSqliteDatabase().getRow<{ updated_at_ms: number }>("SELECT MAX(updated_at_ms) AS updated_at_ms FROM plugin_records");
    return `${row?.updated_at_ms ?? 0}:${digest}`;
  }

  async refreshIfChanged(): Promise<boolean> {
    return false;
  }

  async list(options: { includeArchived?: boolean } = {}): Promise<PluginRecord[]> {
    const records = Object.values(this.read().records)
      .filter((record) => options.includeArchived || record.status !== "archived")
      .map(clone);
    return records;
  }

  async get(id: string): Promise<PluginRecord | undefined> {
    const record = this.read().records[id];
    return record ? clone(record) : undefined;
  }

  async saveDraft(
    rawDefinition: InstructionPluginDefinition,
    actor = "system",
    changelog?: string,
  ): Promise<PluginRecord> {
    const definition = validateInstructionDefinition(rawDefinition);
    const state = this.read();
    const now = new Date().toISOString();
    const old = state.records[definition.manifest.id];
    const existingVersion = old?.versions.find(
      (item) => item.version === definition.manifest.version,
    );
    if (existingVersion && !sameDefinition(existingVersion.definition, definition)) {
      throw new Error(`版本 ${definition.manifest.version} 已存在且不可修改，请提升 manifest.version`);
    }
    const versions = old?.versions ? [...old.versions] : [];
    if (!existingVersion) {
      versions.push({
        version: definition.manifest.version,
        definition: clone(definition),
        createdAt: now,
        createdBy: actor,
        changelog,
      });
    }
    const record: PluginRecord = old
      ? { ...old, definition: clone(definition), versions, updatedAt: now, updatedBy: actor, status: old.status === "archived" ? "draft" : old.status }
      : {
          id: definition.manifest.id,
          status: "draft",
          definition: clone(definition),
          versions,
          createdAt: now,
          updatedAt: now,
          updatedBy: actor,
          auditTrail: [],
        };
    this.appendAudit(record, "draft_saved", actor, {
      version: definition.manifest.version,
      created: !old,
    });
    state.records[record.id] = record;
    this.write(state);
    return clone(record);
  }

  async validate(id: string, actor = "system", input: PluginValidationInput = {}): Promise<PluginRecord> {
    const state = this.read();
    const record = state.records[id];
    if (!record) throw new Error(`插件不存在: ${id}`);
    const errors = [...(input.errors || [])];
    try { validateInstructionDefinition(record.definition); }
    catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    const sampleParsed = input.sampleParsed === true;
    if (!sampleParsed && errors.length === 0) errors.push("发布前必须完成一次样本解析测试");
    record.validation = {
      valid: errors.length === 0 && sampleParsed,
      version: record.definition.manifest.version,
      checkedAt: new Date().toISOString(),
      errors,
      sampleParsed,
      sampleResultCount: input.sampleResultCount,
    };
    record.status = record.validation.valid ? "validated" : "draft";
    record.updatedAt = new Date().toISOString();
    record.updatedBy = actor;
    this.appendAudit(record, record.validation.valid ? "validated" : "validation_failed", actor, {
      version: record.definition.manifest.version,
      sampleParsed,
      sampleResultCount: input.sampleResultCount ?? null,
      errorCount: errors.length,
    });
    state.records[id] = record;
    this.write(state);
    if (!record.validation.valid) throw new Error(errors.join("; "));
    return clone(record);
  }

  async publish(id: string, actor = "system"): Promise<PluginRecord> {
    const state = this.read();
    const record = state.records[id];
    if (!record) throw new Error(`插件不存在: ${id}`);
    validateInstructionDefinition(record.definition);
    const version = record.definition.manifest.version;
    if (!record.validation?.valid || !record.validation.sampleParsed || record.validation.version !== version) {
      throw new Error(`版本 ${version} 发布前必须通过 schema、安全和样本解析验证`);
    }
    record.status = "published";
    record.publishedVersion = version;
    record.updatedAt = new Date().toISOString();
    record.updatedBy = actor;
    this.appendAudit(record, "published", actor, { version });
    state.records[id] = record;
    this.write(state);
    return clone(record);
  }

  async disable(id: string, actor = "system"): Promise<PluginRecord> {
    const state = this.read();
    const record = state.records[id];
    if (!record) throw new Error(`插件不存在: ${id}`);
    record.status = "disabled";
    record.updatedAt = new Date().toISOString();
    record.updatedBy = actor;
    this.appendAudit(record, "disabled", actor, { version: record.publishedVersion || record.definition.manifest.version });
    state.records[id] = record;
    this.write(state);
    return clone(record);
  }

  async enable(id: string, actor = "system"): Promise<PluginRecord> {
    const state = this.read();
    const record = state.records[id];
    if (!record) throw new Error(`插件不存在: ${id}`);
    if (!record.publishedVersion) throw new Error("插件从未发布过，无法启用");
    record.status = "published";
    record.updatedAt = new Date().toISOString();
    record.updatedBy = actor;
    this.appendAudit(record, "enabled", actor, { version: record.publishedVersion });
    state.records[id] = record;
    this.write(state);
    return clone(record);
  }

  async rollback(id: string, version: string, actor = "system"): Promise<PluginRecord> {
    const state = this.read();
    const record = state.records[id];
    if (!record) throw new Error(`插件不存在: ${id}`);
    const target = record.versions.find((item) => item.version === version);
    if (!target) throw new Error(`找不到插件版本: ${version}`);
    validateInstructionDefinition(target.definition);
    record.definition = clone(target.definition);
    record.status = "published";
    record.publishedVersion = version;
    record.validation = { valid: true, version, checkedAt: new Date().toISOString(), errors: [], sampleParsed: true };
    record.updatedAt = new Date().toISOString();
    record.updatedBy = actor;
    this.appendAudit(record, "rolled_back", actor, { version });
    state.records[id] = record;
    this.write(state);
    return clone(record);
  }

  async archive(id: string, actor = "system"): Promise<PluginRecord> {
    const state = this.read();
    const record = state.records[id];
    if (!record) throw new Error(`插件不存在: ${id}`);
    record.status = "archived";
    record.updatedAt = new Date().toISOString();
    record.updatedBy = actor;
    this.appendAudit(record, "archived", actor, { version: record.definition.manifest.version });
    state.records[id] = record;
    this.write(state);
    return clone(record);
  }

  async restore(id: string, actor = "system"): Promise<PluginRecord> {
    const state = this.read();
    const record = state.records[id];
    if (!record) throw new Error(`插件不存在: ${id}`);
    if (record.status !== "archived") throw new Error("只有已归档插件可以恢复");
    record.status = record.publishedVersion ? "disabled" : "draft";
    record.updatedAt = new Date().toISOString();
    record.updatedBy = actor;
    this.appendAudit(record, "restored", actor, { version: record.definition.manifest.version });
    state.records[id] = record;
    this.write(state);
    return clone(record);
  }

  async purge(id: string, _actor = "system"): Promise<void> {
    const state = this.read();
    const record = state.records[id];
    if (!record) throw new Error(`插件不存在: ${id}`);
    if (record.status !== "archived") throw new Error("永久删除前必须先归档插件");
    delete state.records[id];
    this.write(state);
  }

  async audit(id: string, action: PluginAuditAction, actor = "system", metadata?: PluginAuditEntry["metadata"]): Promise<PluginRecord> {
    const state = this.read();
    const record = state.records[id];
    if (!record) throw new Error(`插件不存在: ${id}`);
    this.appendAudit(record, action, actor, metadata);
    state.records[id] = record;
    this.write(state);
    return clone(record);
  }

  private appendAudit(record: PluginRecord, action: PluginAuditAction, actor: string, metadata?: PluginAuditEntry["metadata"]): void {
    record.auditTrail ||= [];
    record.auditTrail.push({ action, actor: actor.slice(0, 100), createdAt: new Date().toISOString(), metadata: metadata ? { ...metadata } : undefined });
    if (record.auditTrail.length > 200) record.auditTrail.splice(0, record.auditTrail.length - 200);
  }
}

let repository: PluginRepository | undefined;
export function getPluginRepository(): PluginRepository {
  return repository || (repository = new SqlitePluginRepository());
}
