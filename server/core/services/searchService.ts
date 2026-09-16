import pLimit from "p-limit";
import { UnifiedCache, CacheNamespace } from "../cache/unifiedCache";
import { createAbortScope, runWithSignal } from "../utils/abort";
import { getSystemSettings } from "./systemSettingsService";
import { getUnifiedUpstreamVersion, listUnifiedUpstreams } from "./upstreamCatalog";
import { upstreamToSourceDefinition } from "./configuredSource";
import { executeSource } from "../source-runtime/executor";
import type { UpstreamDefinition } from "../../../types/source";
import type { CloudType, SearchExecutionResponse, SearchResult, SearchSourceMeta, SearchSourceUpdate } from "../types/models";
import { ErrorCollector, classifyError, ErrorType, type WarningInfo } from "../utils/errors";
import { inferDriveType, normalizeCloudType } from "../../../utils/upstreamAdapter";
import { createSourceHealthChecker, type SourceHealthStatus } from "./sourceHealth";
import {
  clearSourceHealthStatuses,
  deleteSourceHealthStatus,
  loadSourceHealthSnapshot,
  saveSourceHealthStatus,
} from "./sourceHealthStore";

export interface SearchExecutionOptions {
  signal?: AbortSignal;
  onSourceSuccess?: (update: SearchSourceUpdate) => void;
}

export interface SearchServiceOptions {
  defaultSourceIds: string[];
  defaultConcurrency: number;
  cacheEnabled: boolean;
  cacheTtlMinutes: number;
  searchTimeoutMs?: number;
  sourceLoader?: () => Promise<UpstreamDefinition[]>;
}

function canonical(value: string): string { return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase(); }
function sourceKey(source: UpstreamDefinition): string { return source.id.trim().toLowerCase(); }
function clone<T>(value: T): T { return structuredClone(value); }

interface CachedSourceState {
  id: string;
  name: string;
  status: "success" | "failed";
  results: SearchResult[];
  warning?: WarningInfo;
}

interface SearchCacheEntry {
  sources: Record<string, CachedSourceState>;
}

function buildCacheKey(keyword: string, sources: UpstreamDefinition[], cloudTypes: string[] | undefined, ext: Record<string, any> | undefined): string {
  const cloudKey = (cloudTypes || []).map((value) => normalizeCloudType(value) || value.trim().toLowerCase()).sort().join(",");
  let extKey = "";
  try {
    extKey = JSON.stringify(ext || {});
  } catch {
    extKey = "[unserializable]";
  }
  return `keyword:${canonical(keyword)}:sources:${sources.map(sourceKey).sort().join(",")}:cloud:${cloudKey}:ext:${extKey}:config:${getUnifiedUpstreamVersion()}`;
}

export class SearchService {
  private readonly options: SearchServiceOptions;
  private readonly cache: UnifiedCache<SearchCacheEntry>;
  /** The source health checker is also the circuit-breaker gate for searches. */
  private readonly health = createSourceHealthChecker();
  /** SourceHealthChecker keys by stable source id; keep the display name separately. */
  private readonly sourceNames = new Map<string, string>();
  private inFlight = new Map<string, Promise<{ response: SearchExecutionResponse; warnings: WarningInfo[] }>>();

  constructor(options: SearchServiceOptions) {
    this.options = options;
    this.cache = new UnifiedCache<SearchCacheEntry>(
      { enabled: options.cacheEnabled, ttlMinutes: options.cacheTtlMinutes },
      "search",
    );
    // Restore circuit state/counters before the first request so an unhealthy
    // source cannot bypass the breaker merely because the process restarted.
    try {
      this.health.importSnapshot(loadSourceHealthSnapshot());
    } catch {
      // Corrupt or unavailable health data must not prevent searching.
    }
  }

  private syncCacheTtl(): void {
    this.cache.setTtlMinutes(getSystemSettings().cacheTtlMinutes);
  }

  private resolveSources(sources: UpstreamDefinition[] | undefined, ephemeral: UpstreamDefinition[] = []): UpstreamDefinition[] {
    const selected = sources?.length ? sources : [];
    const seen = new Set<string>();
    return [...selected, ...ephemeral].filter((source) => {
      const key = sourceKey(source);
      if (!key || seen.has(key) || source.enabled === false) return false;
      seen.add(key);
      return true;
    }).map(clone);
  }

  async searchWithWarnings(
    keyword: string,
    sources: UpstreamDefinition[] | undefined,
    concurrency: number | undefined,
    forceRefresh: boolean,
    cloudTypes: string[] | undefined,
    ext: Record<string, any> | undefined,
    executionOptions: SearchExecutionOptions = {},
    ephemeralSources: UpstreamDefinition[] = [],
  ): Promise<{ response: SearchExecutionResponse; warnings: WarningInfo[] }> {
    executionOptions.signal?.throwIfAborted();
    this.syncCacheTtl();
    const resolved = this.resolveSources(sources, ephemeralSources);
    const cacheKey = buildCacheKey(keyword, resolved, cloudTypes, ext);
    const cacheAllowed = this.options.cacheEnabled && !ephemeralSources.length;
    const canUseCache = !forceRefresh && cacheAllowed;
    let cachedEntry: SearchCacheEntry | undefined;
    let sourcesToExecute = resolved;
    if (canUseCache) {
      const cached = this.cache.get(CacheNamespace.SEARCH, cacheKey);
      cachedEntry = cached.hit && cached.value ? clone(cached.value) : undefined;
      const running = this.inFlight.get(cacheKey);
      if (running) return await running;
      if (cachedEntry) {
        sourcesToExecute = resolved.filter((source) => cachedEntry!.sources[sourceKey(source)]?.status !== "success");
        if (!sourcesToExecute.length) {
          const response = this.buildResponseFromCache(resolved, cachedEntry);
          this.emitCachedResults(resolved, cachedEntry, executionOptions.onSourceSuccess, keyword);
          return { response, warnings: [] };
        }
      }
    }
    const run = this.executeSearchWithTimeout(keyword, resolved, sourcesToExecute, concurrency, cloudTypes, ext, executionOptions, canUseCache ? cachedEntry : undefined, cacheKey, cacheAllowed);
    if (canUseCache) this.inFlight.set(cacheKey, run);
    try { return await run; } finally { if (this.inFlight.get(cacheKey) === run) this.inFlight.delete(cacheKey); }
  }

  async search(keyword: string, sources: UpstreamDefinition[] | undefined, concurrency?: number, forceRefresh?: boolean, cloudTypes?: string[], ext?: Record<string, any>, executionOptions: SearchExecutionOptions = {}, ephemeralSources: UpstreamDefinition[] = []): Promise<SearchExecutionResponse> {
    return (await this.searchWithWarnings(keyword, sources, concurrency, !!forceRefresh, cloudTypes, ext, executionOptions, ephemeralSources)).response;
  }

  private async executeSearchWithTimeout(keyword: string, allSources: UpstreamDefinition[], sourcesToExecute: UpstreamDefinition[], concurrency: number | undefined, cloudTypes: string[] | undefined, ext: Record<string, any> | undefined, executionOptions: SearchExecutionOptions, cachedEntry: SearchCacheEntry | undefined, cacheKey: string, cacheAllowed: boolean): Promise<{ response: SearchExecutionResponse; warnings: WarningInfo[] }> {
    const configuredBudget = Number(this.options.searchTimeoutMs);
    const timeoutMs = Number.isFinite(configuredBudget) && configuredBudget > 0 ? Math.min(configuredBudget, 120_000) : 30_000;
    const limit = Math.min(16, Math.max(1, Math.floor(Number(concurrency || this.options.defaultConcurrency) || 1)));
    const scope = createAbortScope(timeoutMs, `整次搜索超时 (${timeoutMs}ms)，已返回完成的来源`, executionOptions.signal);
    const execution = { signal: scope.signal, schedule: pLimit(limit), onSourceSuccess: executionOptions.onSourceSuccess };
    try {
      const result = await this.performSearch(keyword, allSources, sourcesToExecute, limit, cloudTypes, ext || {}, execution, cachedEntry, cacheKey, cacheAllowed);
      if (scope.signal.aborted && !executionOptions.signal?.aborted) {
        const detail = classifyError(scope.signal.reason, "search");
        result.warnings.push({ type: detail.type, message: detail.message, source: detail.source, count: 1 });
        if (result.response.meta) result.response.meta.warnings = result.warnings;
      }
      return result;
    } finally { scope.dispose(); }
  }

  private async performSearch(keyword: string, allSources: UpstreamDefinition[], sourcesToExecute: UpstreamDefinition[], concurrency: number, cloudTypes: string[] | undefined, ext: Record<string, any>, execution: { signal: AbortSignal; schedule: ReturnType<typeof pLimit>; onSourceSuccess?: (update: SearchSourceUpdate) => void }, cachedEntry: SearchCacheEntry | undefined, cacheKey: string, cacheAllowed: boolean): Promise<{ response: SearchExecutionResponse; warnings: WarningInfo[] }> {
    const collector = new ErrorCollector();
    const cachedWarnings: WarningInfo[] = [];
    const cachedStates = cachedEntry?.sources || {};
    const diagnostics: SearchSourceMeta[] = allSources.map((source) => {
      const cached = cachedStates[sourceKey(source)];
      return {
        id: source.id,
        name: source.name,
        status: cached?.status === "success" ? "success" : cached?.status === "failed" ? "failed" : "skipped",
        resultCount: cached?.status === "success" ? cached.results.length : 0,
        elapsedMs: 0,
      };
    });
    const diagnosticById = new Map(diagnostics.map((item) => [item.id, item]));
    const nextStates: Record<string, CachedSourceState> = {};
    for (const source of allSources) {
      const key = sourceKey(source);
      const cached = cachedStates[key];
      nextStates[key] = cached
        ? clone(cached)
        : { id: source.id, name: source.name, status: "failed", results: [] };
    }
    this.emitCachedResults(allSources, cachedEntry, execution.onSourceSuccess, keyword);
    const tasks = sourcesToExecute.map((source) => async () => {
      const diagnostic = diagnosticById.get(source.id)!;
      const started = Date.now();
      const definition = upstreamToSourceDefinition(source);
      try {
        if (execution.signal.aborted) return [];
        // An open circuit is a real scheduling decision, not only a status label.
        // After the cooldown SourceHealthChecker permits one half-open probe.
        if (!this.health.canExecute(source.id)) {
          const cached = cachedStates[sourceKey(source)];
          if (cached?.status === "failed") {
            nextStates[sourceKey(source)] = clone(cached);
            if (cached.warning) cachedWarnings.push(clone(cached.warning));
          } else {
            const health = this.health.getStatus(source.id);
            if (health?.lastErrorMessage) {
              const type = Object.values(ErrorType).includes(health.lastErrorCategory as ErrorType)
                ? health.lastErrorCategory as ErrorType
                : ErrorType.UNKNOWN_ERROR;
              const warning: WarningInfo = {
                type,
                message: health.lastErrorMessage,
                source: source.id,
                count: 1,
              };
              nextStates[sourceKey(source)]!.warning = warning;
              cachedWarnings.push(warning);
            }
          }
          return [];
        }
        const result = await runWithSignal(() => executeSource(definition, keyword, { signal: execution.signal, limit: definition.manifest.maxResults, context: { ext } }), execution.signal);
        const annotated = result.results;
        diagnostic.status = "success";
        diagnostic.resultCount = annotated.length;
        diagnostic.elapsedMs = Date.now() - started;
        this.recordHealth(source, true, diagnostic.elapsedMs, annotated.length);
        if (execution.onSourceSuccess && !execution.signal.aborted) {
          execution.onSourceSuccess({ request: { keyword, phase: "source" }, results: annotated });
        }
        nextStates[sourceKey(source)] = { id: source.id, name: source.name, status: "success", results: clone(annotated) };
        return annotated;
      } catch (error) {
        diagnostic.status = execution.signal.aborted ? "skipped" : "failed";
        diagnostic.elapsedMs = Date.now() - started;
        // A cancelled search is not evidence that the upstream is unhealthy.
        // If this was the half-open probe, release it so a later request can retry.
        if (execution.signal.aborted) {
          this.health.releaseProbe(source.id);
          return [];
        }
        const detail = classifyError(error, source.id);
        collector.record(detail, "source_search");
        this.recordHealth(source, false, diagnostic.elapsedMs, 0, detail.message, detail.type);
        nextStates[sourceKey(source)] = { id: source.id, name: source.name, status: "failed", results: [], warning: { type: detail.type, message: detail.message, source: detail.source, count: 1 } };
        return [];
      }
    });
    const resultGroups = await Promise.all(tasks.map((task) => execution.schedule(() => task())));
    const cachedResults = allSources.flatMap((source) => {
      const cached = cachedStates[sourceKey(source)];
      return cached?.status === "success" ? cached.results : [];
    });
    const allResults = this.mergeUniqueResults([...cachedResults, ...resultGroups.flat()]);
    const allowed = cloudTypes?.length ? new Set(cloudTypes.map((value) => normalizeCloudType(value)).filter((value): value is CloudType => !!value)) : undefined;
    const filtered = allResults.map((result) => {
      if (!allowed) return result;
      const links = result.links.filter((link) => allowed.has(inferDriveType(link.url, link.type)));
      return links.length === result.links.length ? result : { ...result, links, cloud_types: [...new Set(links.map((link) => link.type))] };
    }).filter((result) => result.links.length > 0);
    this.sortResultsByTimeDesc(filtered);
    const warnings = Array.from(new Map([...collector.getWarnings(), ...cachedWarnings].map((warning) => [`${warning.type}:${warning.source || ""}`, warning])).values());
    const response: SearchExecutionResponse = { total: filtered.length, results: filtered, meta: { sources: diagnostics, warnings } };
    if (cacheAllowed && allSources.every((source) => source.enabled !== false) && Object.keys(nextStates).length) {
      this.cache.set(CacheNamespace.SEARCH, cacheKey, { sources: nextStates });
    }
    return { response, warnings };
  }

  private buildResponseFromCache(sources: UpstreamDefinition[], entry: SearchCacheEntry): SearchExecutionResponse {
    const results = this.mergeUniqueResults(sources.flatMap((source) => {
      const cached = entry.sources[sourceKey(source)];
      return cached?.status === "success" ? cached.results : [];
    }));
    this.sortResultsByTimeDesc(results);
    return {
      total: results.length,
      results,
      meta: {
        sources: sources.map((source) => ({ id: source.id, name: source.name, status: "success", resultCount: entry.sources[sourceKey(source)]?.results.length || 0, elapsedMs: 0 })),
        warnings: [],
      },
    };
  }

  private emitCachedResults(sources: UpstreamDefinition[], entry: SearchCacheEntry | undefined, callback: ((update: SearchSourceUpdate) => void) | undefined, keyword: string): void {
    if (!entry || !callback) return;
    for (const source of sources) {
      const state = entry.sources[sourceKey(source)];
      if (state?.status === "success" && state.results.length) callback({ request: { keyword, phase: "source" }, results: clone(state.results) });
    }
  }

  private mergeUniqueResults(results: SearchResult[]): SearchResult[] {
    const seen = new Set<string>();
    return results.filter((result) => {
      const key = result.id || result.links[0]?.url || `${result.name}|${result.datetime || ""}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  }
  private sortResultsByTimeDesc(results: SearchResult[]): void { results.sort((a, b) => new Date(b.datetime || 0).getTime() - new Date(a.datetime || 0).getTime()); }
  private recordHealth(source: UpstreamDefinition, ok: boolean, elapsedMs: number, resultCount: number, message?: string, category?: string): void {
    this.sourceNames.set(source.id, source.name);
    if (ok) {
      this.health.recordSuccess(source.id, elapsedMs, { resultCount });
    } else {
      this.health.recordFailure(source.id, {
        responseTimeMs: elapsedMs,
        errorCategory: category,
        errorMessage: message,
      });
    }
    const status = this.health.getStatus(source.id);
    if (status) saveSourceHealthStatus(source.id, status);
  }

  getCacheStats() { this.syncCacheTtl(); return this.cache.getStats(); }
  clearCache(namespace?: CacheNamespace) { namespace ? this.cache.clearNamespace(namespace) : this.cache.clearAll(); }
  getSourceHealthStatus(): Array<SourceHealthStatus & { id: string }> {
    const configuredNames = new Map(listUnifiedUpstreams().map((source) => [source.id, source.name]));
    return this.health.getAllStatus().map((status) => ({
      ...status,
      id: status.name,
      name: this.sourceNames.get(status.name) || configuredNames.get(status.name) || status.name,
    }));
  }
  resetSourceHealth(sourceId?: string) {
    if (sourceId) {
      this.health.reset(sourceId);
      this.sourceNames.delete(sourceId);
      deleteSourceHealthStatus(sourceId);
    } else {
      this.health.resetAll();
      this.sourceNames.clear();
      clearSourceHealthStatuses();
    }
  }
}
