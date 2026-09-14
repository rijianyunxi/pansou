import pLimit from "p-limit";
import { UnifiedCache, CacheNamespace } from "../cache/unifiedCache";
import { createAbortScope, runWithSignal } from "../utils/abort";
import { getSearchSettings } from "./searchSettingsService";
import { getConfiguredUpstreamVersion, listConfiguredUpstreams } from "./upstreamCatalog";
import {
  filterEffectiveTgChannels,
  getTgChannelSettingsVersion,
  getTgChannelPolicy,
} from "./tgChannelSettings";
import { recordTgChannelHealth, flushTgChannelHealth } from "./tgChannelHealthStore";
import { getTgSourceSettingsVersion } from "./tgSourceSettings";
import type { MergedLink, SearchResponse, SearchResult, SearchSourceUpdate } from "../types/models";
import {
  PluginManager,
  type SearchPlugin,
  type PluginSearchContext,
} from "../plugins/manager";
import {
  PluginHealthChecker,
  createPluginHealthChecker,
} from "../plugins/pluginHealth";
import type { PluginHealthStore } from "../plugins/healthStore";
import {
  ErrorCollector,
  classifyError,
  type WarningInfo,
} from "../utils/errors";
import { buildSearchKeywordVariants } from "../utils/searchKeyword";

interface PluginSearchExecution {
  results: SearchResult[];
  registryVersion: number;
  pluginVersions: Record<string, string>;
}

export interface SearchExecutionOptions {
  signal?: AbortSignal;
  onSourceSuccess?: (update: SearchSourceUpdate) => void;
}

interface SearchExecution {
  signal: AbortSignal;
  schedule: ReturnType<typeof pLimit>;
  onSourceSuccess?: (update: SearchSourceUpdate) => void;
}

interface PluginRunContext {
  searchId: string;
  keyword: string;
  variants: string[];
  defaultTimeout: number;
  ext: Record<string, any>;
  registryVersion: number;
  errorCollector: ErrorCollector;
  execution: SearchExecution;
}

export interface SearchServiceOptions {
  priorityChannels: string[];
  defaultChannels: string[];
  defaultConcurrency: number;
  pluginTimeoutMs: number;
  cacheEnabled: boolean;
  cacheTtlMinutes: number;
  /** Wall-clock budget for the entire search, including queues and variants. */
  searchTimeoutMs?: number;
  dynamicPluginLoader?: () => Promise<SearchPlugin[]>;
  /** Persists health snapshots across restarts (best-effort, local instance). */
  healthStore?: PluginHealthStore;
  healthSaveIntervalMs?: number;
}

function createSearchId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `search-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

/** TG 频道失败的机器可读分类：抓取错误自带 tgKind，其余按网络失败归类。 */
function tgChannelFailureKind(error: unknown): string {
  const kind = (error as { tgKind?: unknown } | null)?.tgKind;
  return typeof kind === "string" && kind ? kind : "network_error";
}

/** TG 频道失败的面向人原因短语（有界）。 */
function tgChannelFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.slice(0, 300);
}

export class SearchService {
  private static readonly TG_CHANNEL_LIMIT = 80;
  private static readonly TG_DEEP_CHANNEL_LIMIT = 160;
  private static readonly TG_DEEP_SEARCH_TRIGGER = 3;
  private static readonly PLUGIN_VARIANT_TRIGGER = 5;

  private options: SearchServiceOptions;
  private pluginManager: PluginManager;
  private cache: UnifiedCache;
  private healthChecker: PluginHealthChecker;
  private dynamicPluginIds = new Set<string>();
  private dynamicPluginSignature = "";
  private dynamicRefreshPromise?: Promise<void>;
  private healthSaveTimer?: ReturnType<typeof setInterval>;
  private groupCursors = new Map<string, number>();

  constructor(options: SearchServiceOptions, pluginManager: PluginManager) {
    this.options = options;
    this.pluginManager = pluginManager;
    this.cache = new UnifiedCache(
      {
        enabled: options.cacheEnabled,
        ttlMinutes: options.cacheTtlMinutes,
      },
      "search"
    );

    this.healthChecker = createPluginHealthChecker();
    if (options.healthStore) {
      this.startHealthPersistence(options.healthStore, options.healthSaveIntervalMs);
    }
  }

  /** Restores the last snapshot once, then saves periodically (best-effort). */
  private startHealthPersistence(
    store: PluginHealthStore,
    intervalMs?: number
  ): void {
    const interval = Math.max(10_000, intervalMs || 60_000);
    store
      .load()
      .then((snapshot) => {
        if (snapshot && Object.keys(snapshot).length) {
          this.healthChecker.importSnapshot(snapshot);
        }
      })
      .catch(() => undefined);
    if (typeof setInterval !== "function") return;
    this.healthSaveTimer = setInterval(() => {
      this.flushHealthSnapshot(store).catch(() => undefined);
      // TG 频道健康与插件健康共用同一次落盘节奏（store 内只标脏，这里尽力写盘）。
      flushTgChannelHealth();
    }, interval);
    // Health snapshots must not keep the process alive on shutdown.
    (this.healthSaveTimer as unknown as { unref?: () => void })?.unref?.();
  }

  async flushHealthSnapshot(store?: PluginHealthStore): Promise<void> {
    const target = store || this.options.healthStore;
    if (!target) return;
    await target.save(this.healthChecker.exportSnapshot());
  }

  getPluginManager() {
    return this.pluginManager;
  }

  async search(
    keyword: string,
    channels: string[] | undefined,
    concurrency: number | undefined,
    forceRefresh: boolean | undefined,
    resultType: string | undefined,
    sourceType: "all" | "tg" | "plugin" | undefined,
    plugins: string[] | undefined,
    cloudTypes: string[] | undefined,
    ext: Record<string, any> | undefined,
    executionOptions: SearchExecutionOptions = {}
  ): Promise<SearchResponse> {
    const { response } = await this.searchWithWarnings(
      keyword,
      channels,
      concurrency,
      forceRefresh,
      resultType,
      sourceType,
      plugins,
      cloudTypes,
      ext,
      executionOptions
    );

    return response;
  }

  async searchWithWarnings(
    keyword: string,
    channels: string[] | undefined,
    concurrency: number | undefined,
    forceRefresh: boolean | undefined,
    resultType: string | undefined,
    sourceType: "all" | "tg" | "plugin" | undefined,
    plugins: string[] | undefined,
    cloudTypes: string[] | undefined,
    ext: Record<string, any> | undefined,
    executionOptions: SearchExecutionOptions = {}
  ): Promise<{ response: SearchResponse; warnings: WarningInfo[] }> {
    executionOptions.signal?.throwIfAborted();
    const configuredBudget = Number(this.options.searchTimeoutMs);
    const timeoutMs = Number.isFinite(configuredBudget) && configuredBudget > 0
      ? Math.min(configuredBudget, 120_000) : 30_000;
    const configuredConcurrency = Number(concurrency ?? this.options.defaultConcurrency);
    const limit = Number.isFinite(configuredConcurrency)
      ? Math.min(16, Math.max(1, Math.floor(configuredConcurrency))) : 4;
    const scope = createAbortScope(timeoutMs, `整次搜索超时 (${timeoutMs}ms)，已返回完成的来源`, executionOptions.signal);
    const execution = {
      signal: scope.signal,
      schedule: pLimit(limit),
      onSourceSuccess: executionOptions.onSourceSuccess,
    };
    try {
      const result = await this.performSearch(
        keyword, channels, limit, forceRefresh, resultType, sourceType,
        plugins, cloudTypes, ext, execution,
      );
      executionOptions.signal?.throwIfAborted();
      if (scope.signal.aborted) {
        const { type, message, source } = classifyError(scope.signal.reason, "search");
        result.warnings.push({ type, message, source, count: 1 });
      }
      return result;
    } catch (error) {
      scope.abort(error);
      throw error;
    } finally {
      scope.dispose();
    }
  }

  private async performSearch(
    keyword: string,
    channels: string[] | undefined,
    concurrency: number | undefined,
    forceRefresh: boolean | undefined,
    resultType: string | undefined,
    sourceType: "all" | "tg" | "plugin" | undefined,
    plugins: string[] | undefined,
    cloudTypes: string[] | undefined,
    ext: Record<string, any> | undefined,
    execution: SearchExecution
  ): Promise<{ response: SearchResponse; warnings: WarningInfo[] }> {
    const errorCollector = new ErrorCollector();
    const searchId = createSearchId();
    const effChannels =
      channels ?? this.options.defaultChannels;
    const effConcurrency =
      concurrency && concurrency > 0
        ? concurrency
        : this.options.defaultConcurrency;
    const effResultType = resultType || "links";
    const effSourceType = sourceType ?? "all";

    let tgResults: SearchResult[] = [];
    let pluginResults: SearchResult[] = [];
    let registryVersion = this.pluginManager.snapshot().version;
    let pluginVersions: Record<string, string> = {};

    const tasks: Array<() => Promise<void>> = [];

    if (effSourceType === "all" || effSourceType === "tg") {
      tasks.push(async () => {
        const concOverride =
          typeof concurrency === "number" && concurrency > 0
            ? concurrency
            : undefined;
        tgResults = this.annotateTelegramResults(await this.searchTG(
          keyword,
          effChannels,
          !!forceRefresh,
          concOverride,
          ext,
          errorCollector,
          execution
        ));
      });
    }
    if (effSourceType === "all" || effSourceType === "plugin") {
      tasks.push(async () => {
        const pluginExecution = await this.searchPlugins(
          searchId,
          keyword,
          plugins,
          !!forceRefresh,
          effConcurrency,
          ext ?? {},
          errorCollector,
          execution
        );
        pluginResults = pluginExecution.results;
        registryVersion = pluginExecution.registryVersion;
        pluginVersions = pluginExecution.pluginVersions;
      });
    }

    await Promise.all(tasks.map((task) => task()));

    const allResults = this.mergeSearchResults(tgResults, pluginResults);
    this.sortResultsByTimeDesc(allResults);

    const filteredForResults: SearchResult[] = [];
    for (const result of allResults) {
      const hasTime = !!result.datetime;
      const hasLinks = Array.isArray(result.links) && result.links.length > 0;
      const keywordPriority = this.getKeywordPriority(result.title);
      const pluginLevel = this.getPluginLevelBySource(
        this.getResultSource(result)
      );
      if (hasTime || hasLinks || keywordPriority > 0 || pluginLevel <= 2) {
        filteredForResults.push(result);
      }
    }

    const mergedLinks = this.mergeResults(
      allResults,
      cloudTypes
    );

    let total = 0;
    const meta = { registryVersion, pluginVersions };
    let response: SearchResponse = { total: 0, meta };
    if (effResultType === "links") {
      // 默认响应统一为扁平数组，避免消费者依赖按平台嵌套结构。
      total = mergedLinks.length;
      response = { total, results: mergedLinks, meta };
    } else if (effResultType === "results") {
      total = filteredForResults.length;
      response = { total, results: filteredForResults, meta };
    } else {
      total = filteredForResults.length;
      response = {
        total,
        results: filteredForResults,
        items: mergedLinks,
        meta,
      };
    }

    return {
      response,
      warnings: errorCollector.getWarnings(),
    };
  }

  private async searchTG(
    keyword: string,
    channels: string[] | undefined,
    forceRefresh: boolean,
    concurrencyOverride?: number,
    ext?: Record<string, any>,
    errorCollector = new ErrorCollector(),
    execution?: SearchExecution
  ): Promise<SearchResult[]> {
    if (execution?.signal.aborted) return [];
    // 频道生效清单过滤：已停用（enabled=false）或已删除（deleted=true）的频道
    // 不参与正式搜索；入参同时做归一与非法用户名过滤。
    const chList = filterEffectiveTgChannels(Array.isArray(channels) ? channels : []);
    // 频道配置热更新：每频道策略/启停状态版本参与缓存 key，保存后下一次搜索立即重算。
    const cacheKey = `tg:${keyword}:${[...chList].sort().join(",")}:${getTgChannelSettingsVersion()}:${getTgSourceSettingsVersion()}`;
    const { cacheEnabled, priorityChannels } = this.options;

    if (!forceRefresh && cacheEnabled) {
      const cached = this.cache.get(CacheNamespace.TG_SEARCH, cacheKey);
      if (cached.hit && cached.value) {
        const annotated = this.annotateTelegramResults(cached.value);
        for (const channel of chList) {
          const channelResults = annotated.filter(
            (result) => result.channel.replace(/^@/, "").toLowerCase() === channel.toLowerCase()
          );
          if (channelResults.length) {
            this.emitSourceSuccess(execution, {
              source: { kind: "telegram", id: channel, cached: true },
              request: { keyword, phase: "cache" },
              results: channelResults,
            });
          }
        }
        return cached.value;
      }
    }

    const { fetchTgChannelPosts } = await import("./tg");
    const requestedTimeout = Number((ext as any)?.__plugin_timeout_ms) || 0;
    const timeoutMs = Math.max(
      3000,
      requestedTimeout > 0
        ? requestedTimeout
        : this.options.pluginTimeoutMs || 0
    );
    const concurrency = Math.max(
      1,
      Math.min(concurrencyOverride ?? this.options.defaultConcurrency, 12)
    );

    const prioritySet = new Set((priorityChannels || []).map((name) => name.toLowerCase()));
    const priorityList = chList.filter((channel) => prioritySet.has(channel.toLowerCase()));
    const normalList = chList.filter((channel) => !prioritySet.has(channel.toLowerCase()));

    const failedChannels = new Set<string>();
    const recordFailure = (channel: string, error: unknown) => {
      failedChannels.add(channel);
      if (!execution?.signal.aborted) {
        errorCollector.record(classifyError(error, `tg:${channel}`), "tg_search");
      }
    };
    const createChannelTask =
      (channel: string, limitPerChannel: number, phase: "shallow" | "deep") => async () => {
        // 每频道超时策略：显式配置时覆盖全局默认（外层 searchTimeoutMs 预算仍然生效）。
        const channelTimeoutMs = getTgChannelPolicy(channel)?.timeoutMs ?? timeoutMs;
        const scope = createAbortScope(channelTimeoutMs, `TG 频道 ${channel} 请求超时 (${channelTimeoutMs}ms)`, execution?.signal);
        const startedAt = Date.now();
        // 页面级告警（前几页成功、后续页失败）：任务仍会带部分结果返回，
        // 但频道健康要按失败记录，避免"整页抓不到"的频道显示为可用。
        let warning: unknown;
        const recordChannelHealth = (ok: boolean, resultsCount: number, error?: unknown) => {
          // 调用方/整次搜索取消不是频道故障，不记录为频道失败。
          if (execution?.signal.aborted) return;
          recordTgChannelHealth({
            channel,
            at: Date.now(),
            ok,
            elapsedMs: Date.now() - startedAt,
            resultsCount,
            ...(ok
              ? {}
              : {
                  failureKind: tgChannelFailureKind(error),
                  message: tgChannelFailureMessage(error),
                }),
            source: "search",
          });
        };
        try {
          const results = await runWithSignal(() => fetchTgChannelPosts(channel, keyword, {
            limitPerChannel, signal: scope.signal, timeoutMs,
            onWarning: (error) => {
              warning = error;
              recordFailure(channel, error);
            },
          }), scope.signal);
          if (!results.length && warning !== undefined) {
            recordChannelHealth(false, 0, warning);
          } else {
            recordChannelHealth(true, results.length);
            this.emitSourceSuccess(execution, {
              source: { kind: "telegram", id: channel },
              request: { keyword, phase },
              results: this.annotateTelegramResults(results),
            });
          }
          return results;
        } catch (error) {
          recordChannelHealth(false, 0, error);
          recordFailure(channel, error);
          return [];
        } finally {
          scope.dispose();
        }
      };

    const flattenResults = (items: SearchResult[][]) => {
      const flattened: SearchResult[] = [];
      for (const arr of items) {
        if (Array.isArray(arr)) {
          flattened.push(...arr);
        }
      }
      return flattened;
    };

    const shallowTasks = [...priorityList, ...normalList].map((channel) =>
      createChannelTask(channel, SearchService.TG_CHANNEL_LIMIT, "shallow")
    );
    const shallowResults = flattenResults(
      await this.runWithConcurrency(shallowTasks, concurrency, execution)
    );

    let results = shallowResults;
    if (
      !execution?.signal.aborted &&
      results.length < SearchService.TG_DEEP_SEARCH_TRIGGER &&
      keyword.trim().length > 1 &&
      chList.length > 0
    ) {
      const deepTasks = [...priorityList, ...normalList]
        .filter((channel) => !failedChannels.has(channel))
        .map((channel) => createChannelTask(channel, SearchService.TG_DEEP_CHANNEL_LIMIT, "deep"));
      const deepResults = flattenResults(
        await this.runWithConcurrency(deepTasks, concurrency, execution)
      );
      results = this.mergeUniqueResults(results, deepResults);
    }

    if (cacheEnabled && results.length > 0 && !failedChannels.size && !execution?.signal.aborted) {
      this.cache.set(CacheNamespace.TG_SEARCH, cacheKey, results);
    }

    return results;
  }

  private async searchPlugins(
    searchId: string,
    keyword: string,
    plugins: string[] | undefined,
    forceRefresh: boolean,
    concurrency: number,
    ext: Record<string, any>,
    errorCollector: ErrorCollector,
    execution: SearchExecution
  ): Promise<PluginSearchExecution> {
    const empty = () => ({ results: [], registryVersion: this.pluginManager.version, pluginVersions: {} });
    try {
      await runWithSignal(() => this.refreshDynamicPlugins(), execution.signal);
    } catch (error) {
      if (execution.signal.aborted) return empty();
      throw error;
    }
    if (execution.signal.aborted) return empty();
    const wanted = new Set(
      (plugins ?? []).map((value) => value?.toLowerCase()).filter(Boolean)
    );
    // 已删除（垃圾箱）的上游不参与正式搜索
    const configuredIds = new Set(listConfiguredUpstreams().map((source) => source.id.toLowerCase()));
    const trashed = new Set(
      getSearchSettings().trashedPlugins
        .map((value) => value.toLowerCase())
        .filter((id) => !configuredIds.has(id))
    );
    const disabledConfigured = new Set(
      listConfiguredUpstreams()
        .filter((source) => source.enabled === false)
        .map((source) => source.id.toLowerCase())
    );
    const registrySnapshot = this.pluginManager.snapshot();
    const selected = [...registrySnapshot.plugins]
      .filter((plugin) => plugins === undefined || wanted.has(plugin.manifest.id.toLowerCase()))
      .filter((plugin) => !trashed.has(plugin.manifest.id.toLowerCase()))
      .filter((plugin) => !disabledConfigured.has(plugin.manifest.id.toLowerCase()))
      .sort((a, b) => {
        const priorityDiff = b.manifest.priority - a.manifest.priority;
        return priorityDiff || a.manifest.id.localeCompare(b.manifest.id);
      });

    const pluginVersions = Object.fromEntries(
      selected.map((plugin) => [plugin.manifest.id, plugin.manifest.version])
    );
    const versionedPluginKey = selected
      .map((plugin) => `${plugin.manifest.id.toLowerCase()}@${plugin.manifest.version}`)
      .sort()
      .join(",");
    // Endpoint/method/format edits are config changes, not plugin version
    // changes. Include the catalog version so the next request never serves a
    // result cached against the previous published endpoint.
    const cacheKey = `plugin:${keyword}:${getConfiguredUpstreamVersion()}:${getTgChannelSettingsVersion()}:${versionedPluginKey}`;
    const cacheEnabled = this.options.cacheEnabled &&
      Object.keys(ext).every((key) => key === "__plugin_timeout_ms");

    if (!forceRefresh && cacheEnabled) {
      const cached = this.cache.get(CacheNamespace.PLUGIN_SEARCH, cacheKey);
      if (cached.hit && cached.value) {
        const rebound = this.rebindRegistryVersion(cached.value, registrySnapshot.version);
        const resultsByPlugin = new Map<string, SearchResult[]>();
        for (const result of rebound) {
          const id = result.pluginId || "unknown";
          const results = resultsByPlugin.get(id) || [];
          results.push(result);
          resultsByPlugin.set(id, results);
        }
        for (const [id, results] of resultsByPlugin) {
          this.emitSourceSuccess(execution, {
            source: {
              kind: "plugin",
              id,
              version: results[0]?.pluginVersion,
              cached: true,
            },
            request: { keyword, phase: "cache" },
            results,
          });
        }
        return {
          results: rebound,
          registryVersion: registrySnapshot.version,
          pluginVersions,
        };
      }
    }

    const requestedTimeout = Number(ext?.__plugin_timeout_ms) || 0;
    const defaultTimeout = requestedTimeout > 0
      ? requestedTimeout
      : Math.max(3000, this.options.pluginTimeoutMs || 0);
    const variants =
      (keyword || "").trim().length <= 1
        ? [keyword, "电影", "movie", "1080p"]
        : buildSearchKeywordVariants(keyword).slice(0, 3);

    // Plugins sharing a priority run in one batch; lower priorities wait for
    // higher-priority batches, making priority an actual scheduling contract.
    const batches = new Map<number, SearchPlugin[]>();
    for (const plugin of selected) {
      const priority = plugin.manifest.priority;
      const batch = batches.get(priority) || [];
      batch.push(plugin);
      batches.set(priority, batch);
    }

    const merged: SearchResult[] = [];
    for (const [, batch] of [...batches.entries()].sort((a, b) => b[0] - a[0])) {
      if (execution.signal.aborted) break;
      const run: PluginRunContext = {
        searchId,
        keyword,
        variants,
        defaultTimeout,
        ext,
        registryVersion: registrySnapshot.version,
        errorCollector,
        execution,
      };
      const batchTasks: Array<() => Promise<SearchResult[]>> = [];
      const groups = new Map<string, SearchPlugin[]>();
      for (const plugin of batch) {
        const group = plugin.manifest.upstreamGroup;
        if (group) {
          const members = groups.get(group) || [];
          members.push(plugin);
          groups.set(group, members);
        } else {
          batchTasks.push(() => this.executePluginSearch(plugin, run).catch(() => []));
        }
      }
      for (const [, members] of groups) {
        if (members.length === 1) {
          batchTasks.push(() =>
            this.executePluginSearch(members[0]!, run).catch(() => [])
          );
        } else {
          // Equivalent upstreams: one weighted member per search, failing
          // over to the next member on an actual execution failure.
          batchTasks.push(() => this.executeGroupWithFailover(members, run));
        }
      }
      const resultsByTask = await this.runWithConcurrency(
        batchTasks,
        Math.max(1, concurrency),
        execution
      );
      for (const results of resultsByTask) {
        if (Array.isArray(results)) merged.push(...results);
      }
    }

    const sourceFailed = errorCollector.getErrors("plugin_search").length > 0;
    if (cacheEnabled && merged.length > 0 && !sourceFailed && !execution.signal.aborted) {
      this.cache.set(CacheNamespace.PLUGIN_SEARCH, cacheKey, merged);
    }
    return {
      results: merged,
      registryVersion: registrySnapshot.version,
      pluginVersions,
    };
  }

  /** Runs one plugin across keyword variants; rethrows after recording failure. */
  private async executePluginSearch(
    plugin: SearchPlugin,
    run: PluginRunContext
  ): Promise<SearchResult[]> {
    const name = plugin.manifest.id;
    run.execution.signal.throwIfAborted();
    // Reserve half-open probes only when the task actually gets a slot.
    if (!this.healthChecker.canExecute(name)) {
      const error = new Error(`插件 ${name} 熔断中或正在恢复探测，暂不可用`);
      run.errorCollector.record(classifyError(error, name), "plugin_search");
      throw error;
    }
    const timeoutMs = Math.max(
      1,
      Number(plugin.manifest.timeoutMs) || run.defaultTimeout
    );
    const startedAt = Date.now();
    const scope = createAbortScope(timeoutMs, `插件 ${name} 请求超时 (${timeoutMs}ms)`, run.execution.signal);
    let results: SearchResult[] = [];
    try {
      for (const [index, query] of run.variants.entries()) {
        scope.signal.throwIfAborted();
        const context: PluginSearchContext = {
          searchId: run.searchId,
          keyword: query,
          keywordVariants: run.variants,
          timeoutMs: Math.max(1, timeoutMs - (Date.now() - startedAt)),
          signal: scope.signal,
          ext: Object.freeze({ ...run.ext }),
        };
        const current = this.annotatePluginResults(
          await runWithSignal(() => plugin.search(context), scope.signal) || [],
          plugin,
          run.registryVersion,
        );
        this.emitSourceSuccess(run.execution, {
          source: { kind: "plugin", id: name, version: plugin.manifest.version },
          request: { keyword: query, phase: "variant" },
          results: current.slice(0, plugin.manifest.maxResults),
        });
        results = this.mergeUniqueResults(results, current);
        if (
          results.length >= SearchService.PLUGIN_VARIANT_TRIGGER ||
          index === run.variants.length - 1
        ) break;
      }
      const limitedResults = results.slice(0, plugin.manifest.maxResults);
      this.healthChecker.recordSuccess(name, Date.now() - startedAt, {
        resultCount: limitedResults.length,
      });
      return limitedResults;
    } catch (error) {
      // A caller/global deadline is not an upstream outage; do not trip its circuit.
      if (run.execution.signal.aborted) {
        this.healthChecker.releaseProbe(name);
      } else {
        const detail = classifyError(error, name);
        this.healthChecker.recordFailure(name, {
          responseTimeMs: Date.now() - startedAt,
          errorCategory: detail.type,
          errorMessage: detail.message,
        });
        run.errorCollector.record(detail, "plugin_search");
      }
      if (results.length) return results.slice(0, plugin.manifest.maxResults);
      throw error;
    } finally {
      scope.dispose();
    }
  }

  /**
   * Weighted round-robin ordering for a group of equivalent upstreams: the
   * cursor advances every search, heavy members rotate in more often, and the
   * deduplicated order doubles as the failover chain.
   */
  private orderGroupCandidates(members: SearchPlugin[]): SearchPlugin[] {
    const group = members[0]?.manifest.upstreamGroup || "";
    const weightOf = (plugin: SearchPlugin): number => {
      const weight = plugin.manifest.upstreamWeight;
      return Number.isInteger(weight) && weight! >= 1 && weight! <= 100
        ? weight!
        : 10;
    };
    const maxWeight = Math.max(...members.map(weightOf));
    const cycle: SearchPlugin[] = [];
    for (let round = 0; round < maxWeight; round++) {
      for (const member of members) {
        if (round < weightOf(member)) cycle.push(member);
      }
    }
    const cursor = this.groupCursors.get(group) ?? 0;
    this.groupCursors.set(group, cursor + 1);
    const ordered: SearchPlugin[] = [];
    for (let index = 0; index < cycle.length; index++) {
      const candidate = cycle[(cursor + index) % cycle.length];
      if (candidate && !ordered.includes(candidate)) ordered.push(candidate);
    }
    return ordered;
  }

  private async executeGroupWithFailover(
    members: SearchPlugin[],
    run: PluginRunContext
  ): Promise<SearchResult[]> {
    for (const plugin of this.orderGroupCandidates(members)) {
      if (run.execution.signal.aborted) break;
      try {
        // A legitimate zero-result answer ends the chain; only a real
        // failure (timeout, HTTP, parse) moves traffic to the next member.
        return await this.executePluginSearch(plugin, run);
      } catch {
        // Failure already recorded by executePluginSearch.
      }
    }
    return [];
  }

  private async refreshDynamicPlugins(): Promise<void> {
    if (!this.options.dynamicPluginLoader) return;
    if (this.dynamicRefreshPromise) return this.dynamicRefreshPromise;
    this.dynamicRefreshPromise = (async () => {
      if (this.pluginManager.hasUpdateSource) {
        // Stat-level version check; the manager reloads and atomically swaps
        // the snapshot only when the repository actually changed, so config
        // written by another process is picked up within one search.
        try {
          await this.pluginManager.checkForUpdates();
        } catch {
          // Keep the last valid registry snapshot on transient failures.
        }
        return;
      }
      const loaded = await this.options.dynamicPluginLoader!();
      const currentIds = new Set(loaded.map((plugin) => plugin.manifest.id));
      const signature = loaded
        .map((plugin) => `${plugin.manifest.id}@${plugin.manifest.version}`)
        .sort()
        .join(",");
      if (signature === this.dynamicPluginSignature) return;
      const removeIds = [...this.dynamicPluginIds].filter(
        (id) => !currentIds.has(id)
      );
      this.pluginManager.replaceMany(loaded, removeIds);
      this.dynamicPluginIds = currentIds;
      this.dynamicPluginSignature = signature;
    })();
    try {
      await this.dynamicRefreshPromise;
    } catch {
      // Keep the last valid registry snapshot when the repository is
      // temporarily unavailable; a config outage must not break search.
    } finally {
      this.dynamicRefreshPromise = undefined;
    }
  }

  private emitSourceSuccess(
    execution: SearchExecution | undefined,
    update: SearchSourceUpdate
  ): void {
    if (!execution?.onSourceSuccess || execution.signal.aborted) return;
    try {
      execution.onSourceSuccess({ ...update, results: [...update.results] });
    } catch {
      // Streaming observers must never turn a successful backend call into a source failure.
    }
  }

  private annotateTelegramResults(results: SearchResult[]): SearchResult[] {
    return results.map((result) => ({ ...result, source: "telegram" }));
  }

  private annotatePluginResults(
    results: SearchResult[],
    plugin: SearchPlugin,
    registryVersion: number
  ): SearchResult[] {
    return results.map((result) => ({
      ...result,
      source: "plugin",
      pluginId: plugin.manifest.id,
      pluginVersion: plugin.manifest.version,
      registryVersion,
    }));
  }

  private rebindRegistryVersion(
    results: SearchResult[],
    registryVersion: number
  ): SearchResult[] {
    return results.map((result) =>
      result.source === "plugin" ? { ...result, registryVersion } : result
    );
  }

  private mergeSearchResults(
    a: SearchResult[],
    b: SearchResult[]
  ): SearchResult[] {
    return this.mergeUniqueResults(a, b);
  }

  private mergeUniqueResults(
    a: SearchResult[],
    b: SearchResult[]
  ): SearchResult[] {
    const seen = new Set<string>();
    const out: SearchResult[] = [];
    const pushUnique = (result: SearchResult) => {
      const firstLink = Array.isArray(result.links) ? result.links[0]?.url : "";
      const key =
        result.unique_id ||
        result.message_id ||
        firstLink ||
        `${result.title}|${result.channel}|${result.datetime || ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(result);
    };

    for (const result of a) pushUnique(result);
    for (const result of b) pushUnique(result);
    return out;
  }

  private sortResultsByTimeDesc(arr: SearchResult[]) {
    arr.sort(
      (x, y) => new Date(y.datetime).getTime() - new Date(x.datetime).getTime()
    );
  }

  private getResultSource(_r: SearchResult): string {
    return "";
  }

  private getPluginLevelBySource(_source: string): number {
    return 3;
  }

  private getKeywordPriority(_title: string): number {
    return 0;
  }

  private mergeResults(
    results: SearchResult[],
    cloudTypes?: string[]
  ): MergedLink[] {
    const allow =
      cloudTypes && cloudTypes.length > 0
        ? new Set(cloudTypes.map((value) => value.toLowerCase()))
        : undefined;
    const out: MergedLink[] = [];
    for (const result of results) {
      for (const link of result.links || []) {
        const type = (link.type || "others").toLowerCase();
        if (allow && !allow.has(type)) continue;
        out.push({
          type,
          url: link.url,
          password: link.password || "",
          note: result.title,
          datetime: result.datetime,
          source: result.source === "plugin"
            ? `plugin:${result.pluginId}@${result.pluginVersion}`
            : `tg:${result.channel}`,
          pluginId: result.pluginId,
          pluginVersion: result.pluginVersion,
          registryVersion: result.registryVersion,
          images: result.images,
        });
      }
    }
    return out;
  }

  private async runWithConcurrency(
    tasks: Array<() => Promise<SearchResult[]>>,
    limit: number,
    execution?: SearchExecution
  ): Promise<SearchResult[][]> {
    const limitFn = pLimit(limit);
    const limitedTasks = tasks.map((task) => limitFn(() => {
      if (!execution) return task();
      return execution.schedule(() => execution.signal.aborted ? [] : task());
    }));
    return Promise.all(limitedTasks);
  }

  getCacheStats() {
    return this.cache.getStats();
  }

  clearCache(namespace?: CacheNamespace) {
    if (namespace) {
      this.cache.clearNamespace(namespace);
    } else {
      this.cache.clearAll();
    }
  }

  getPluginHealthStatus() {
    return this.healthChecker.getAllStatus();
  }

  resetPluginHealth(pluginName?: string) {
    if (pluginName) {
      this.healthChecker.reset(pluginName);
    } else {
      this.healthChecker.resetAll();
    }
  }
}
