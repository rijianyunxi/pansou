import pLimit from "p-limit";
import { UnifiedCache, CacheNamespace } from "../cache/unifiedCache";
import { awaitWithAbort, createAbortScope, throwIfAborted } from "../utils/abort";
import { getUserPolicy } from "./policyService";
import { getUnifiedSourceVersion, listUnifiedSources } from "./sourceCatalog";
import { toSourceDefinition } from "./configuredSource";
import { executeSource } from "../source-runtime/executor";
import type { SourceDefinition } from "../../../types/source";
import type { SearchExecutionResponse, SearchResult, SearchSourceMeta, SearchSourceUpdate } from "../types/models";
import { ErrorCollector, classifyError, ErrorType, type WarningInfo } from "../utils/errors";
import { mergeResultsByIdentity } from "../utils/resultMerge";
import { createSourceHealthChecker, type SourceHealthStatus } from "./sourceHealth";
import {
  clearSourceHealthStatuses,
  deleteSourceHealthStatus,
  flushSourceHealthStatuses,
  loadSourceHealthSnapshot,
  pruneSourceHealthStatuses,
  queueSourceHealthStatus,
} from "./sourceHealthStore";

export interface SearchExecutionOptions {
  signal?: AbortSignal;
  onSourceSuccess?: (update: SearchSourceUpdate) => void | Promise<void>;
}

export interface SearchServiceOptions {
  defaultConcurrency: number;
  cacheTtlMinutes: number;
  cacheMaxMemoryBytes: number;
}

function canonical(value: string): string { return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase(); }
function sourceKey(source: SourceDefinition): string { return source.id.trim().toLowerCase(); }
/** Queue position: a smaller priority value is scheduled earlier. */
function sourcePriority(source: SourceDefinition): number {
  const priority = Number(source.priority);
  return Number.isFinite(priority) ? priority : 0;
}
function clone<T>(value: T): T { return structuredClone(value); }

interface CachedSourceState {
  id: string;
  name: string;
  status: "success" | "failed";
  results: SearchResult[];
  proxyNode?: string;
  warning?: WarningInfo;
}

interface SearchCacheEntry {
  sources: Record<string, CachedSourceState>;
}

interface InFlightSubscriber {
  callback: (update: SearchSourceUpdate) => void | Promise<void>;
  queue: Promise<void>;
  active: boolean;
}

interface InFlightSearch {
  promise: Promise<{ response: SearchExecutionResponse; warnings: WarningInfo[] }>;
  updates: SearchSourceUpdate[];
  subscribers: Set<InFlightSubscriber>;
}

function buildCacheKey(keyword: string, sourceIds: string[]): string {
  return `keyword:${canonical(keyword)}:sources:${sourceIds.map((id) => id.trim().toLowerCase()).sort().join(",")}:config:${getUnifiedSourceVersion()}`;
}

export class SearchService {
  private readonly options: SearchServiceOptions;
  private readonly cache: UnifiedCache<SearchCacheEntry>;
  /** The source health checker is also the circuit-breaker gate for searches. */
  private readonly health = createSourceHealthChecker();
  /** SourceHealthChecker keys by stable source id; keep the display name separately. */
  private readonly sourceNames = new Map<string, string>();
  /**
   * Signature of the last pruned source set. `pruneStaleHealth` runs on every
   * search, but the DELETE it issues is only meaningful when the catalog itself
   * changed, so an unchanged signature skips the write entirely.
   */
  private prunedSourceSignature: string | null = null;
  private inFlight = new Map<string, InFlightSearch>();

  constructor(options: SearchServiceOptions) {
    this.options = options;
    this.cache = new UnifiedCache<SearchCacheEntry>(
      { enabled: true, ttlMinutes: options.cacheTtlMinutes, maxMemoryBytes: options.cacheMaxMemoryBytes },
      "search",
    );
    this.pruneStaleHealth();
    // Restore circuit state/counters before the first request so an unhealthy
    // source cannot bypass the breaker merely because the process restarted.
    try {
      this.health.importSnapshot(loadSourceHealthSnapshot());
    } catch {
      // Corrupt or unavailable health data must not prevent searching.
    }
  }

  private syncRuntimePolicy(): void {
    const policy = getUserPolicy();
    this.options.defaultConcurrency = policy.defaultConcurrency;
    this.cache.setTtlMinutes(policy.cacheTtlMinutes);
    this.cache.setMaxMemoryBytes(policy.cacheMaxMemoryMb * 1024 * 1024);
    this.health.setMaxFailures(policy.circuitBreakerMaxFailures);
    this.pruneStaleHealth();
  }

  private configuredSourceIds(): Set<string> {
    return new Set(listUnifiedSources().map(sourceKey));
  }

  private pruneStaleHealth(): void {
    const configuredIds = this.configuredSourceIds();
    const signature = [...configuredIds].sort().join(",");
    if (signature !== this.prunedSourceSignature) {
      pruneSourceHealthStatuses(configuredIds);
      this.prunedSourceSignature = signature;
    }
    // In-memory cleanup is free and must follow every catalog change, so it is
    // not gated by the signature.
    for (const sourceId of this.sourceNames.keys()) {
      if (!configuredIds.has(sourceId)) this.sourceNames.delete(sourceId);
    }
    for (const status of this.health.getAllStatus()) {
      if (!configuredIds.has(status.name)) this.health.reset(status.name);
    }
  }

  private resolveSources(sources: SourceDefinition[] | undefined, ephemeral: SourceDefinition[] = []): SourceDefinition[] {
    const selected = sources?.length ? sources : [];
    const seen = new Set<string>();
    return [...selected, ...ephemeral].filter((source) => {
      const key = sourceKey(source);
      if (!key || seen.has(key) || source.enabled === false) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => sourcePriority(a) - sourcePriority(b)).map(clone);
  }

  async searchWithWarnings(
    keyword: string,
    sources: SourceDefinition[] | undefined,
    concurrency: number | undefined,
    forceRefresh: boolean,
    executionOptions: SearchExecutionOptions = {},
    ephemeralSources: SourceDefinition[] = [],
  ): Promise<{ response: SearchExecutionResponse; warnings: WarningInfo[] }> {
    executionOptions.signal?.throwIfAborted();
    this.syncRuntimePolicy();
    const resolved = this.resolveSources(sources, ephemeralSources);
    const cacheKey = buildCacheKey(keyword, resolved.map(sourceKey));
    const cacheAllowed = !ephemeralSources.length;
    const canUseCache = !forceRefresh && cacheAllowed;
    let cachedEntry: SearchCacheEntry | undefined;
    let sourcesToExecute = resolved;
    if (canUseCache) {
      const cached = this.cache.get(CacheNamespace.SEARCH, cacheKey);
      cachedEntry = cached.hit && cached.value ? clone(cached.value) : undefined;
      const running = this.inFlight.get(cacheKey);
      if (running) {
        const unsubscribe = this.subscribeInFlight(running, executionOptions.onSourceSuccess);
        try {
          return await running.promise;
        } finally {
          unsubscribe();
        }
      }
      if (cachedEntry) {
        sourcesToExecute = resolved.filter((source) => cachedEntry!.sources[sourceKey(source)]?.status !== "success");
        if (!sourcesToExecute.length) {
          const response = this.buildResponseFromCache(resolved, cachedEntry);
          await this.emitCachedResults(resolved, cachedEntry, executionOptions.onSourceSuccess, keyword);
          return { response, warnings: [] };
        }
      }
    }
    const ephemeralSourceIds = new Set(ephemeralSources.map(sourceKey));
    if (canUseCache) {
      const flight: InFlightSearch = {
        promise: Promise.resolve(null as never),
        updates: [],
        subscribers: new Set<InFlightSubscriber>(),
      };
      const unsubscribe = this.subscribeInFlight(flight, executionOptions.onSourceSuccess);
      this.inFlight.set(cacheKey, flight);
      flight.promise = this.executeSearchWithTimeout(
        keyword,
        resolved,
        sourcesToExecute,
        concurrency,
        {
          ...executionOptions,
          onSourceSuccess: (update) => this.publishInFlight(flight, update),
        },
        cachedEntry,
        cacheKey,
        cacheAllowed,
        ephemeralSourceIds,
      );
      try { return await flight.promise; }
      finally {
        unsubscribe();
        if (this.inFlight.get(cacheKey) === flight) this.inFlight.delete(cacheKey);
      }
    }

    return await this.executeSearchWithTimeout(keyword, resolved, sourcesToExecute, concurrency, executionOptions, cachedEntry, cacheKey, cacheAllowed, ephemeralSourceIds);
  }

  /**
   * Share source-level SSE updates while only one upstream execution is active.
   * A subscriber has its own promise chain so a late joiner receives the
   * already completed sources first and then future updates in order.
   */
  private subscribeInFlight(flight: InFlightSearch, callback: SearchExecutionOptions["onSourceSuccess"]): () => void {
    if (!callback) return () => undefined;
    const subscriber: InFlightSubscriber = { callback, queue: Promise.resolve(), active: true };
    flight.subscribers.add(subscriber);
    for (const update of flight.updates) this.enqueueInFlightUpdate(flight, subscriber, update);
    return () => {
      subscriber.active = false;
      flight.subscribers.delete(subscriber);
    };
  }

  private enqueueInFlightUpdate(flight: InFlightSearch, subscriber: InFlightSubscriber, update: SearchSourceUpdate): Promise<void> {
    subscriber.queue = subscriber.queue.then(async () => {
      if (!subscriber.active) return;
      await subscriber.callback(clone(update));
    }).catch(() => {
      // A disconnected SSE client must not fail the shared upstream search.
      subscriber.active = false;
      flight.subscribers.delete(subscriber);
    });
    return subscriber.queue;
  }

  private async publishInFlight(flight: InFlightSearch, update: SearchSourceUpdate): Promise<void> {
    const snapshot = clone(update);
    flight.updates.push(snapshot);
    await Promise.all([...flight.subscribers].map((subscriber) => this.enqueueInFlightUpdate(flight, subscriber, snapshot)));
  }

  async search(keyword: string, sources: SourceDefinition[] | undefined, concurrency?: number, forceRefresh?: boolean, executionOptions: SearchExecutionOptions = {}, ephemeralSources: SourceDefinition[] = []): Promise<SearchExecutionResponse> {
    return (await this.searchWithWarnings(keyword, sources, concurrency, !!forceRefresh, executionOptions, ephemeralSources)).response;
  }

  private async executeSearchWithTimeout(keyword: string, allSources: SourceDefinition[], sourcesToExecute: SourceDefinition[], concurrency: number | undefined, executionOptions: SearchExecutionOptions, cachedEntry: SearchCacheEntry | undefined, cacheKey: string, cacheAllowed: boolean, ephemeralSourceIds: ReadonlySet<string>): Promise<{ response: SearchExecutionResponse; warnings: WarningInfo[] }> {
    const configuredBudget = Number(getUserPolicy().searchTimeoutMs);
    const timeoutMs = Number.isFinite(configuredBudget) && configuredBudget > 0 ? Math.min(configuredBudget, 120_000) : 30_000;
    const limit = Math.min(16, Math.max(1, Math.floor(Number(concurrency || this.options.defaultConcurrency) || 1)));
    const timeoutError = new Error(`整次搜索超时 (${timeoutMs}ms)，已返回完成的来源`);
    timeoutError.name = "TimeoutError";
    const scope = createAbortScope(executionOptions.signal, timeoutMs, timeoutError);
    const execution = { signal: scope.signal, schedule: pLimit(limit), onSourceSuccess: executionOptions.onSourceSuccess };
    try {
      const result = await this.performSearch(keyword, allSources, sourcesToExecute, limit, execution, cachedEntry, cacheKey, cacheAllowed, ephemeralSourceIds);
      if (scope.signal.aborted && !executionOptions.signal?.aborted) {
        const detail = classifyError(scope.signal.reason, "search");
        result.warnings.push({ type: detail.type, message: detail.message, source: detail.source, count: 1 });
        if (result.response.meta) result.response.meta.warnings = result.warnings;
      }
      return result;
    } finally {
      scope.dispose();
      // Health snapshots are staged per source and written once here, so a
      // search costs one batched transaction instead of one write per source.
      flushSourceHealthStatuses();
    }
  }

  private async performSearch(keyword: string, allSources: SourceDefinition[], sourcesToExecute: SourceDefinition[], concurrency: number, execution: { signal: AbortSignal; schedule: ReturnType<typeof pLimit>; onSourceSuccess?: (update: SearchSourceUpdate) => void | Promise<void> }, cachedEntry: SearchCacheEntry | undefined, cacheKey: string, cacheAllowed: boolean, ephemeralSourceIds: ReadonlySet<string>): Promise<{ response: SearchExecutionResponse; warnings: WarningInfo[] }> {
    const collector = new ErrorCollector();
    const cachedWarnings: WarningInfo[] = [];
    const cachedStates = cachedEntry?.sources || {};
    const diagnostics: SearchSourceMeta[] = allSources.map((source) => {
      const cached = cachedStates[sourceKey(source)];
      return {
        id: source.id,
        name: source.name,
        priority: source.priority,
        status: cached?.status === "success" ? "success" : cached?.status === "failed" ? "failed" : "skipped",
        resultCount: cached?.status === "success" ? cached.results.length : 0,
        elapsedMs: 0,
        transformMs: null,
        proxyNode: cached?.proxyNode || (cached?.status === "success" ? "直连" : "未执行"),
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
    await this.emitCachedResults(allSources, cachedEntry, execution.onSourceSuccess, keyword);
    const tasks = sourcesToExecute.map((source) => async () => {
      const diagnostic = diagnosticById.get(source.id)!;
      const started = Date.now();
      const definition = toSourceDefinition(source);
      const trackHealth = !ephemeralSourceIds.has(sourceKey(source));
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
            const type = Object.values(ErrorType).includes(health?.lastErrorCategory as ErrorType)
              ? health!.lastErrorCategory as ErrorType
              : ErrorType.SOURCE_ERROR;
            const warning: WarningInfo = {
              type,
              code: "circuit_open",
              message: health?.lastErrorMessage
                ? `来源已熔断，已跳过本次请求（最近失败：${health.lastErrorMessage}）`
                : "来源已熔断，已跳过本次请求",
              source: source.id,
              count: 1,
            };
            nextStates[sourceKey(source)]!.warning = warning;
            cachedWarnings.push(warning);
          }
          return [];
        }
        const result = await awaitWithAbort(Promise.resolve().then(() => {
          throwIfAborted(execution.signal);
          return executeSource(definition, keyword, {
            signal: execution.signal,
            limit: definition.manifest.maxResults,
            onTransformTiming: (elapsedMs) => { diagnostic.transformMs = elapsedMs; },
          });
        }), execution.signal);
        throwIfAborted(execution.signal);
        const sourceResults = result.results;
        diagnostic.status = "success";
        diagnostic.resultCount = sourceResults.length;
        diagnostic.elapsedMs = Date.now() - started;
        diagnostic.proxyNode = result.proxyNodes.length ? result.proxyNodes.join(" → ") : "直连";
        if (trackHealth) this.recordHealth(source, true, diagnostic.elapsedMs, sourceResults.length);
        if (execution.onSourceSuccess && !execution.signal.aborted) {
          await execution.onSourceSuccess({ request: { keyword, phase: "source" }, sourceId: source.id, results: sourceResults });
        }
        nextStates[sourceKey(source)] = {
          id: source.id,
          name: source.name,
          status: "success",
          results: clone(sourceResults),
          proxyNode: diagnostic.proxyNode,
        };
        return sourceResults;
      } catch (error) {
        diagnostic.status = execution.signal.aborted ? "skipped" : "failed";
        diagnostic.elapsedMs = Date.now() - started;
        // A cancelled search is not evidence that the source is unhealthy.
        // If this was the half-open probe, release it so a later request can retry.
        if (execution.signal.aborted) {
          this.health.releaseProbe(source.id);
          return [];
        }
        const detail = classifyError(error, source.id);
        collector.record(detail, "source_search");
        if (trackHealth) this.recordHealth(source, false, diagnostic.elapsedMs, 0, detail.message, detail.type);
        nextStates[sourceKey(source)] = {
          id: source.id,
          name: source.name,
          status: "failed",
          results: [],
          warning: {
            type: detail.type,
            message: detail.message,
            source: detail.source,
            count: 1,
            ...(detail.code ? { code: detail.code } : {}),
          },
        };
        return [];
      }
    });
    const resultGroups = await Promise.all(tasks.map((task) => execution.schedule(() => task())));
    const cachedResults = allSources.flatMap((source) => {
      const cached = cachedStates[sourceKey(source)];
      return cached?.status === "success" ? cached.results : [];
    });
    const results = this.mergeUniqueResults([...cachedResults, ...resultGroups.flat()]);
    const warnings = Array.from(new Map([...collector.getWarnings(), ...cachedWarnings].map((warning) => [`${warning.type}:${warning.source || ""}`, warning])).values());
    const response: SearchExecutionResponse = { total: results.length, results, meta: { sources: diagnostics, warnings } };
    if (cacheAllowed && allSources.every((source) => source.enabled !== false) && Object.keys(nextStates).length) {
      this.cache.set(CacheNamespace.SEARCH, cacheKey, { sources: nextStates });
    }
    return { response, warnings };
  }

  private buildResponseFromCache(sources: SourceDefinition[], entry: SearchCacheEntry): SearchExecutionResponse {
    const results = this.mergeUniqueResults(sources.flatMap((source) => {
      const cached = entry.sources[sourceKey(source)];
      return cached?.status === "success" ? cached.results : [];
    }));
    return {
      total: results.length,
      results,
      meta: {
        sources: sources.map((source) => ({
          id: source.id,
          name: source.name,
          priority: source.priority,
          status: "success",
          resultCount: entry.sources[sourceKey(source)]?.results.length || 0,
          elapsedMs: 0,
          transformMs: null,
          proxyNode: entry.sources[sourceKey(source)]?.proxyNode || "直连",
        })),
        warnings: [],
      },
    };
  }

  private async emitCachedResults(sources: SourceDefinition[], entry: SearchCacheEntry | undefined, callback: ((update: SearchSourceUpdate) => void | Promise<void>) | undefined, keyword: string): Promise<void> {
    if (!entry || !callback) return;
    for (const source of sources) {
      const state = entry.sources[sourceKey(source)];
      if (state?.status === "success" && state.results.length) await callback({ request: { keyword, phase: "source" }, sourceId: source.id, results: clone(state.results) });
    }
  }

  /**
   * Deduplicate results gathered from several sources.
   *
   * This delegates to the shared pipeline definition instead of comparing raw
   * ids: the old `id || links[0].url || name|datetime` key never fell through to
   * the link branch because every source result carries an id, so the same share
   * link coming from two sources was emitted twice here while the streamed view
   * emitted it once.
   */
  private mergeUniqueResults(results: SearchResult[]): SearchResult[] {
    return mergeResultsByIdentity(results);
  }
  private recordHealth(source: SourceDefinition, ok: boolean, elapsedMs: number, resultCount: number, message?: string, category?: string): void {
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
    if (status) queueSourceHealthStatus(source.id, status);
  }

  getSourceHealthStatus(): Array<SourceHealthStatus & { id: string }> {
    this.pruneStaleHealth();
    const configuredNames = new Map(listUnifiedSources().map((source) => [source.id, source.name]));
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
      // The catalog did not change, so force the next prune to re-evaluate the
      // table it was just told to empty.
      this.prunedSourceSignature = null;
    }
  }
}
