import { SearchService, type SearchServiceOptions } from "./searchService";
import { PluginManager } from "../plugins/manager";
import { createConfiguredUpstreamPlugin } from "./configuredUpstreamPlugin";
import { getPluginSecretStore } from "../plugins/secretStore";
import { getPluginHealthStore } from "../plugins/healthStore";
import { getSystemSettings } from "./systemSettingsService";
import { getConfiguredUpstreamVersion, listConfiguredUpstreams } from "./upstreamCatalog";
import type { SearchPlugin } from "../plugins/manager";

const SERVICE_CONTEXT_KEY = "__panhub_search_service__";

function createConfiguredPlugin(
  source: ReturnType<typeof listConfiguredUpstreams>[number],
): SearchPlugin {
  // 所有来源都从数据库定义创建，运行时不再根据 id 选择内置处理器。
  return createConfiguredUpstreamPlugin(
    source,
    (pluginId, names) => getPluginSecretStore().getMany(pluginId, names),
  );
}

function loadConfiguredPlugins(): SearchPlugin[] {
  return listConfiguredUpstreams()
    .map(createConfiguredPlugin)
    .filter((plugin): plugin is SearchPlugin => !!plugin);
}

function createPluginManager(): PluginManager {
  const pm = new PluginManager();
  for (const plugin of loadConfiguredPlugins()) pm.register(plugin);
  return pm;
}

/**
 * 创建搜索服务选项
 */
function createServiceOptions(runtimeConfig: any): SearchServiceOptions {
  const system = getSystemSettings(runtimeConfig);
  return {
    priorityChannels: system.priorityChannels,
    defaultChannels: system.defaultChannels,
    defaultConcurrency: system.defaultConcurrency,
    pluginTimeoutMs: system.pluginTimeoutMs,
    searchTimeoutMs: runtimeConfig.searchTimeoutMs,
    cacheEnabled: !!runtimeConfig.cacheEnabled,
    cacheTtlMinutes: system.cacheTtlMinutes,
    dynamicPluginLoader: async () => loadConfiguredPlugins(),
    healthStore: getPluginHealthStore(),
  };
}

/**
 * 获取或创建搜索服务实例
 * 使用 Nitro 上下文存储，支持测试时重置
 */
export function getOrCreateSearchService(runtimeConfig: any): SearchService {
  // 尝试从 Nitro 上下文获取
  const context = (globalThis as any)[SERVICE_CONTEXT_KEY];
  if (context?.service) {
    return context.service;
  }

  // 创建新实例
  const pluginManager = createPluginManager();
  const options = createServiceOptions(runtimeConfig);
  const loader = options.dynamicPluginLoader;
  if (loader) {
    // 多进程/多副本一致性：Registry 刷新前先做 stat 级版本检查，
    // 配置未变化时跳过全量重载；变化时由 manager 原子替换快照。
    pluginManager.setUpdateSource({
      getRepositoryVersion: async () => getConfiguredUpstreamVersion(),
      load: loader,
    });
  }
  const service = new SearchService(options, pluginManager);

  // 存储到上下文
  (globalThis as any)[SERVICE_CONTEXT_KEY] = { service, options, pluginManager };
  return service;
}

/**
 * 重置搜索服务实例（仅用于测试）
 */
export function resetSearchService(): void {
  delete (globalThis as any)[SERVICE_CONTEXT_KEY];
}

/**
 * 获取搜索服务统计信息（用于监控）
 */
export function getSearchServiceStats(): { exists: boolean; options?: SearchServiceOptions } {
  const context = (globalThis as any)[SERVICE_CONTEXT_KEY];
  if (!context) {
    return { exists: false };
  }
  return {
    exists: true,
    options: context.options,
  };
}
