import type { SearchResult } from "../types/models";

export type PluginKind = "code" | "instructions" | "telegram";

export interface PluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly kind: PluginKind;
  readonly priority: number;
  readonly timeoutMs: number;
  readonly maxResults: number;
  readonly schemaVersion: number;
  readonly outputTypes: readonly string[];
  readonly capabilities?: Readonly<Record<string, boolean>>;
  /** Equivalent-upstream group: members share traffic with weighted failover. */
  readonly upstreamGroup?: string;
  /** Selection weight inside the group (1-100, default 10). */
  readonly upstreamWeight?: number;
}

export interface PluginSearchContext {
  readonly searchId: string;
  readonly keyword: string;
  readonly keywordVariants: readonly string[];
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly ext: Readonly<Record<string, unknown>>;
}

export interface SearchPlugin {
  readonly manifest: PluginManifest;
  search(context: PluginSearchContext): Promise<SearchResult[]>;
}

export type PluginManifestInput = Pick<PluginManifest, "id" | "name" | "priority"> &
  Partial<Omit<PluginManifest, "id" | "name" | "priority">>;

export function definePluginManifest(input: PluginManifestInput): PluginManifest {
  if (!input.id.trim()) throw new Error("Plugin manifest id is required");
  if (!input.name.trim()) throw new Error("Plugin manifest name is required");
  if (!Number.isFinite(input.priority)) throw new Error("Plugin manifest priority is required");
  if (input.upstreamWeight !== undefined && (!Number.isInteger(input.upstreamWeight) || input.upstreamWeight < 1 || input.upstreamWeight > 100)) {
    throw new Error("Plugin manifest upstreamWeight must be an integer from 1 to 100");
  }
  if (input.upstreamGroup !== undefined && !/^[a-zA-Z0-9_-]{1,64}$/.test(input.upstreamGroup)) {
    throw new Error("Plugin manifest upstreamGroup must match [a-zA-Z0-9_-]{1,64}");
  }
  return Object.freeze({
    id: input.id,
    name: input.name,
    version: input.version || "1.0.0",
    kind: input.kind || "code",
    priority: input.priority,
    timeoutMs: input.timeoutMs || 0,
    maxResults: input.maxResults || 200,
    schemaVersion: input.schemaVersion || 1,
    outputTypes: Object.freeze([...(input.outputTypes || [])]),
    capabilities: input.capabilities
      ? Object.freeze({ ...input.capabilities })
      : undefined,
    upstreamGroup: input.upstreamGroup,
    upstreamWeight: input.upstreamWeight,
  });
}

/** Base class for audited, in-repository code plugins. */
export abstract class CodeSearchPlugin implements SearchPlugin {
  readonly manifest: PluginManifest;

  constructor(manifest: PluginManifestInput) {
    this.manifest = definePluginManifest({ ...manifest, kind: "code" });
  }

  abstract search(context: PluginSearchContext): Promise<SearchResult[]>;
}

export interface PluginRegistrySnapshot {
  readonly version: number;
  readonly plugins: readonly SearchPlugin[];
}

/**
 * Configuration source polled by PluginManager.checkForUpdates() for
 * short-period version checks (multi-process consistency, todo 6.6 #3 / M3).
 * The caller decides the trigger policy (e.g. before each search or a timer).
 */
export interface PluginUpdateSource {
  /**
   * Opaque configuration version signature (e.g. repository file mtime+size).
   * Return null when the version cannot be determined (no filesystem, no
   * version capability); the manager then verifies the loaded set on every
   * check, matching the previous always-reload behaviour.
   */
  getRepositoryVersion(): Promise<string | null>;
  /**
   * Loads the desired dynamic plugin set. May throw; on failure the manager
   * keeps its last valid registry snapshot.
   */
  load(): Promise<SearchPlugin[]>;
}

/** Mutable writer facade with immutable read snapshots. */
export class PluginManager {
  private plugins = new Map<string, SearchPlugin>();
  private disabled = new Set<string>();
  private registryVersion = 0;
  private currentSnapshot: PluginRegistrySnapshot = Object.freeze({
    version: 0,
    plugins: Object.freeze([]),
  });
  private updateSource?: PluginUpdateSource;
  private updateSourceVersion: string | null = null;
  private updateSourceIds = new Set<string>();
  private updateSourceSignature = "";
  private updateCheckPromise?: Promise<boolean>;

  register(plugin: SearchPlugin): void {
    const id = plugin.manifest.id;
    if (this.plugins.has(id)) throw new Error(`Plugin already registered: ${id}`);
    this.plugins.set(id, plugin);
    this.disabled.delete(id);
    this.commitSnapshot();
  }

  replace(plugin: SearchPlugin): void {
    this.plugins.set(plugin.manifest.id, plugin);
    this.commitSnapshot();
  }

  /** Atomically replaces a complete subset, used by dynamic plugin refresh. */
  replaceMany(plugins: readonly SearchPlugin[], removeIds: readonly string[] = []): void {
    const next = new Map(this.plugins);
    for (const id of removeIds) next.delete(id);
    for (const plugin of plugins) next.set(plugin.manifest.id, plugin);
    this.plugins = next;
    for (const id of removeIds) this.disabled.delete(id);
    this.commitSnapshot();
  }

  unregister(id: string): boolean {
    const deleted = this.plugins.delete(id);
    this.disabled.delete(id);
    if (deleted) this.commitSnapshot();
    return deleted;
  }

  enable(id: string): boolean {
    if (!this.plugins.has(id)) return false;
    if (this.disabled.delete(id)) this.commitSnapshot();
    return true;
  }

  disable(id: string): boolean {
    if (!this.plugins.has(id)) return false;
    if (!this.disabled.has(id)) {
      this.disabled.add(id);
      this.commitSnapshot();
    }
    return true;
  }

  get(id: string): SearchPlugin | undefined {
    return this.plugins.get(id);
  }

  list(options: { includeDisabled?: boolean } = {}): SearchPlugin[] {
    if (!options.includeDisabled) return [...this.currentSnapshot.plugins];
    return [...this.plugins.values()];
  }

  snapshot(): PluginRegistrySnapshot {
    return this.currentSnapshot;
  }

  get version(): number {
    return this.registryVersion;
  }

  /** Registers (or replaces) the configuration source used by checkForUpdates(). */
  setUpdateSource(source: PluginUpdateSource): void {
    this.updateSource = source;
    this.updateSourceVersion = null;
    this.updateSourceIds = new Set();
    this.updateSourceSignature = "";
    this.updateCheckPromise = undefined;
  }

  /** Whether an update source is configured; refresh callers use the fast path. */
  get hasUpdateSource(): boolean {
    return !!this.updateSource;
  }

  /**
   * Version signature of the update source currently applied to the registry;
   * null when no source is configured or the version is still unknown.
   */
  get configVersion(): string | null {
    return this.updateSourceVersion;
  }

  /**
   * Short-period version check against the configured update source. Returns
   * true when the registry snapshot was replaced via the existing atomic
   * refresh path (replaceMany). Never mutates the registry on failure: the
   * last valid snapshot keeps serving traffic. Concurrent checks share a
   * single in-flight promise; no timer is installed here — callers decide
   * when to poll (e.g. before each search, or on an interval).
   */
  checkForUpdates(): Promise<boolean> {
    if (!this.updateSource) return Promise.resolve(false);
    if (!this.updateCheckPromise) {
      this.updateCheckPromise = this.runUpdateCheck().finally(() => {
        this.updateCheckPromise = undefined;
      });
    }
    return this.updateCheckPromise;
  }

  private async runUpdateCheck(): Promise<boolean> {
    const source = this.updateSource;
    if (!source) return false;
    const version = await source.getRepositoryVersion();
    // Known version unchanged since the last applied check: skip the reload
    // entirely (cheap stat-only comparison).
    if (version !== null && version === this.updateSourceVersion) return false;
    const loaded = await source.load();
    const currentIds = new Set(loaded.map((plugin) => plugin.manifest.id));
    const removeIds = [...this.updateSourceIds].filter((id) => !currentIds.has(id));
    const signature = loaded
      .map((plugin) => `${plugin.manifest.id}@${plugin.manifest.version}`)
      .sort()
      .join(",");
    if (signature === this.updateSourceSignature && removeIds.length === 0) {
      // Content unchanged (e.g. file touched without semantic change):
      // record the version baseline without churning the snapshot.
      this.updateSourceVersion = version;
      return false;
    }
    this.replaceMany(loaded, removeIds);
    this.updateSourceIds = currentIds;
    this.updateSourceSignature = signature;
    this.updateSourceVersion = version;
    return true;
  }

  private commitSnapshot(): void {
    this.registryVersion++;
    const active = [...this.plugins.entries()]
      .filter(([id]) => !this.disabled.has(id))
      .map(([, plugin]) => plugin);
    this.currentSnapshot = Object.freeze({
      version: this.registryVersion,
      plugins: Object.freeze(active),
    });
  }
}
