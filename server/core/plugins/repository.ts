import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
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

/**
 * Additive capability for configuration-version checks (todo 6.6 #3 / M3):
 * lets the registry poll a cheap on-disk signature (mtime+size) and reload
 * in-memory state when another process rewrote the backing file. Environments
 * without a filesystem (e.g. Cloudflare Workers) return null and must treat
 * that as "version unknown", not "unchanged".
 */
export interface RepositoryVersionCheck {
  /**
   * Current version signature of the persisted config. Reloads in-memory
   * state from disk when the signature changed since the last read, so a
   * subsequent list()/get() observes the external write.
   */
  getConfigVersion(): Promise<string | null>;
  /**
   * True when the backing file changed since the last read (triggers the
   * same reload as getConfigVersion). Never true when the version is unknown.
   */
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

export class JsonPluginRepository implements PluginRepository, RepositoryVersionCheck {
  private state: RepositoryFile = { records: {} };
  private loaded = false;
  private loadPromise?: Promise<void>;
  private writeQueue: Promise<void> = Promise.resolve();
  /** On-disk signature (mtimeMs:size) captured at the last read/write. */
  private lastSignature: string | null = null;

  constructor(
    private readonly filePath =
      (typeof process !== "undefined" && process.env?.PANHUB_PLUGIN_STORE) ||
      "data/plugins.json"
  ) {}

  private async statSignature(): Promise<string | null> {
    try {
      const stats = await stat(this.filePath);
      return `${Math.round(stats.mtimeMs)}:${stats.size}`;
    } catch {
      // Missing file or no stat capability (e.g. Cloudflare Workers):
      // the version is unknown rather than "unchanged".
      return null;
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        try {
          // Capture the stamp before reading so the stamp is never "newer"
          // than the content: a write landing in between is re-detected on
          // the next version check instead of being missed.
          const signature = await this.statSignature();
          const raw = await readFile(this.filePath, "utf8");
          const parsed = JSON.parse(raw) as Partial<RepositoryFile>;
          if (parsed.records && typeof parsed.records === "object") {
            this.state = {
              records: Object.fromEntries(
                Object.entries(parsed.records).map(([id, record]) => [
                  id,
                  {
                    ...(record as PluginRecord),
                    auditTrail: Array.isArray((record as PluginRecord).auditTrail)
                      ? (record as PluginRecord).auditTrail
                      : [],
                  },
                ])
              ),
            };
          }
          this.lastSignature = signature;
        } catch (error: any) {
          if (error?.code !== "ENOENT") throw error;
        } finally {
          this.loaded = true;
        }
      })();
    }
    await this.loadPromise;
  }

  /**
   * Re-reads the backing file into memory after an external write. Keeps the
   * last valid in-memory state when the reload fails (same semantics as the
   * registry refresh); on ENOENT the next version check starts from scratch.
   */
  private async reloadFromDisk(): Promise<void> {
    try {
      const signature = await this.statSignature();
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<RepositoryFile>;
      if (parsed.records && typeof parsed.records === "object") {
        this.state = {
          records: Object.fromEntries(
            Object.entries(parsed.records).map(([id, record]) => [
              id,
              {
                ...(record as PluginRecord),
                auditTrail: Array.isArray((record as PluginRecord).auditTrail)
                  ? (record as PluginRecord).auditTrail
                  : [],
              },
            ])
          ),
        };
      }
      this.lastSignature = signature;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      this.lastSignature = null;
    }
  }

  /** Loads once, then returns the up-to-date on-disk signature (reloading if changed). */
  private async syncWithDisk(): Promise<string | null> {
    await this.ensureLoaded();
    const signature = await this.statSignature();
    if (signature === null || signature === this.lastSignature) return signature;
    await this.reloadFromDisk();
    return this.lastSignature;
  }

  async getConfigVersion(): Promise<string | null> {
    return this.syncWithDisk();
  }

  async refreshIfChanged(): Promise<boolean> {
    const previous = this.lastSignature;
    const current = await this.syncWithDisk();
    return current !== null && current !== previous;
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2) + "\n";
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const pid = typeof process !== "undefined" ? process.pid : "runtime";
      const temp = `${this.filePath}.${pid}.${Date.now()}.${Math.random()
        .toString(36)
        .slice(2)}.tmp`;
      await writeFile(temp, snapshot, "utf8");
      await rename(temp, this.filePath);
      // Track our own write so subsequent version checks only detect
      // external changes. A write racing this stat belongs to another
      // process and will be picked up by its own signature change.
      this.lastSignature = await this.statSignature();
    });
    await this.writeQueue;
  }

  async list(
    options: { includeArchived?: boolean } = {}
  ): Promise<PluginRecord[]> {
    await this.ensureLoaded();
    return Object.values(this.state.records)
      .filter(
        (record) => options.includeArchived || record.status !== "archived"
      )
      .map(clone);
  }

  async get(id: string): Promise<PluginRecord | undefined> {
    await this.ensureLoaded();
    const record = this.state.records[id];
    return record ? clone(record) : undefined;
  }

  private appendAudit(
    record: PluginRecord,
    action: PluginAuditAction,
    actor: string,
    metadata?: PluginAuditEntry["metadata"]
  ): void {
    record.auditTrail ||= [];
    record.auditTrail.push({
      action,
      actor: actor.slice(0, 100),
      createdAt: new Date().toISOString(),
      metadata: metadata ? { ...metadata } : undefined,
    });
    if (record.auditTrail.length > 200) {
      record.auditTrail.splice(0, record.auditTrail.length - 200);
    }
  }

  async saveDraft(
    rawDefinition: InstructionPluginDefinition,
    actor = "system",
    changelog?: string
  ): Promise<PluginRecord> {
    const definition = validateInstructionDefinition(rawDefinition);
    await this.ensureLoaded();
    const now = new Date().toISOString();
    const old = this.state.records[definition.manifest.id];
    const existingVersion = old?.versions.find(
      (item) => item.version === definition.manifest.version
    );
    if (existingVersion && !sameDefinition(existingVersion.definition, definition)) {
      throw new Error(
        `版本 ${definition.manifest.version} 已存在且不可修改，请提升 manifest.version`
      );
    }

    const version: PluginVersion = existingVersion || {
      version: definition.manifest.version,
      definition: clone(definition),
      createdAt: now,
      createdBy: actor,
      changelog,
    };
    const record: PluginRecord = old
      ? {
          ...old,
          definition: clone(definition),
          status: "draft",
          versions: existingVersion ? old.versions : [...old.versions, version],
          validation:
            old.validation?.version === definition.manifest.version
              ? old.validation
              : undefined,
          updatedAt: now,
          updatedBy: actor,
          auditTrail: old.auditTrail || [],
        }
      : {
          id: definition.manifest.id,
          status: "draft",
          definition: clone(definition),
          versions: [version],
          createdAt: now,
          updatedAt: now,
          updatedBy: actor,
          auditTrail: [],
        };
    this.appendAudit(record, "draft_saved", actor, {
      version: definition.manifest.version,
      created: !old,
    });
    this.state.records[record.id] = record;
    await this.persist();
    return clone(record);
  }

  async validate(
    id: string,
    actor = "system",
    input: PluginValidationInput = {}
  ): Promise<PluginRecord> {
    const record = await this.require(id);
    const errors = [...(input.errors || [])];
    try {
      validateInstructionDefinition(record.definition);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    const sampleParsed = input.sampleParsed === true;
    if (!sampleParsed && errors.length === 0) {
      errors.push("发布前必须完成一次样本解析测试");
    }
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
    this.appendAudit(
      record,
      record.validation.valid ? "validated" : "validation_failed",
      actor,
      {
        version: record.definition.manifest.version,
        sampleParsed,
        sampleResultCount: input.sampleResultCount ?? null,
        errorCount: errors.length,
      }
    );
    this.state.records[id] = record;
    await this.persist();
    if (!record.validation.valid) throw new Error(errors.join("; "));
    return clone(record);
  }

  async publish(id: string, actor = "system"): Promise<PluginRecord> {
    const record = await this.require(id);
    validateInstructionDefinition(record.definition);
    const version = record.definition.manifest.version;
    if (
      !record.validation?.valid ||
      !record.validation.sampleParsed ||
      record.validation.version !== version
    ) {
      throw new Error(`版本 ${version} 发布前必须通过 schema、安全和样本解析验证`);
    }
    record.status = "published";
    record.publishedVersion = version;
    record.updatedAt = new Date().toISOString();
    record.updatedBy = actor;
    this.appendAudit(record, "published", actor, { version });
    this.state.records[id] = record;
    await this.persist();
    return clone(record);
  }

  async disable(id: string, actor = "system"): Promise<PluginRecord> {
    const record = await this.require(id);
    record.status = "disabled";
    record.updatedAt = new Date().toISOString();
    record.updatedBy = actor;
    this.appendAudit(record, "disabled", actor, {
      version: record.publishedVersion || record.definition.manifest.version,
    });
    this.state.records[id] = record;
    await this.persist();
    return clone(record);
  }

  /** 恢复停用的插件（enable）：回到 published 并继续使用原有已发布版本。 */
  async enable(id: string, actor = "system"): Promise<PluginRecord> {
    const record = await this.require(id);
    if (!record.publishedVersion) {
      throw new Error("插件从未发布过，无法启用");
    }
    record.status = "published";
    record.updatedAt = new Date().toISOString();
    record.updatedBy = actor;
    this.appendAudit(record, "enabled", actor, {
      version: record.publishedVersion,
    });
    this.state.records[id] = record;
    await this.persist();
    return clone(record);
  }

  async rollback(
    id: string,
    version: string,
    actor = "system"
  ): Promise<PluginRecord> {
    const record = await this.require(id);
    const target = record.versions.find((item) => item.version === version);
    if (!target) throw new Error(`找不到插件版本: ${version}`);
    validateInstructionDefinition(target.definition);
    record.definition = clone(target.definition);
    record.status = "published";
    record.publishedVersion = version;
    record.validation = {
      valid: true,
      version,
      checkedAt: new Date().toISOString(),
      errors: [],
      sampleParsed: true,
    };
    record.updatedAt = new Date().toISOString();
    record.updatedBy = actor;
    this.appendAudit(record, "rolled_back", actor, { version });
    this.state.records[id] = record;
    await this.persist();
    return clone(record);
  }

  async archive(id: string, actor = "system"): Promise<PluginRecord> {
    const record = await this.require(id);
    record.status = "archived";
    record.updatedAt = new Date().toISOString();
    record.updatedBy = actor;
    this.appendAudit(record, "archived", actor, {
      version: record.definition.manifest.version,
    });
    this.state.records[id] = record;
    await this.persist();
    return clone(record);
  }

  async restore(id: string, actor = "system"): Promise<PluginRecord> {
    const record = await this.require(id);
    if (record.status !== "archived") throw new Error("只有已归档插件可以恢复");
    record.status = record.publishedVersion ? "disabled" : "draft";
    record.updatedAt = new Date().toISOString();
    record.updatedBy = actor;
    this.appendAudit(record, "restored", actor, {
      version: record.definition.manifest.version,
    });
    this.state.records[id] = record;
    await this.persist();
    return clone(record);
  }

  async purge(id: string, _actor = "system"): Promise<void> {
    const record = await this.require(id);
    if (record.status !== "archived") {
      throw new Error("永久删除前必须先归档插件");
    }
    delete this.state.records[id];
    await this.persist();
  }

  async audit(
    id: string,
    action: PluginAuditAction,
    actor = "system",
    metadata?: PluginAuditEntry["metadata"]
  ): Promise<PluginRecord> {
    const record = await this.require(id);
    this.appendAudit(record, action, actor, metadata);
    this.state.records[id] = record;
    await this.persist();
    return clone(record);
  }

  private async require(id: string): Promise<PluginRecord> {
    await this.ensureLoaded();
    const record = this.state.records[id];
    if (!record) throw new Error(`插件不存在: ${id}`);
    return clone(record);
  }
}


/** SQLite-backed repository used by the application. The old JSON repository is
 * retained for explicit test/legacy construction, while all default runtime
 * operations use this transactional store. */
export class SqlitePluginRepository implements PluginRepository, RepositoryVersionCheck {
  private static readonly NAMESPACE = "plugin_repository";
  private static readonly KEY = "state";
  private revision = 0;

  private read(): RepositoryFile {
    const state = getSqliteDatabase().get<RepositoryFile>(
      SqlitePluginRepository.NAMESPACE,
      SqlitePluginRepository.KEY,
      { records: {} },
    );
    return { records: state?.records && typeof state.records === "object" ? state.records : {} };
  }

  private write(state: RepositoryFile): void {
    getSqliteDatabase().set(
      SqlitePluginRepository.NAMESPACE,
      SqlitePluginRepository.KEY,
      state,
    );
    this.revision++;
  }

  async getConfigVersion(): Promise<string> {
    const database = getSqliteDatabase();
    const state = this.read();
    const digest = createHash("sha256").update(JSON.stringify(state)).digest("hex");
    // updated_at detects writes by another process; the digest also catches
    // same-millisecond updates and makes the signature content-addressed.
    return `${database.getUpdatedAt(SqlitePluginRepository.NAMESPACE, SqlitePluginRepository.KEY) ?? 0}:${digest}`;
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
export function setPluginRepository(value: PluginRepository): void {
  repository = value;
}
