import { defineEventHandler } from "h3";
import { getOrCreateSearchService } from "../core/services";
import { getSystemSettings } from "../core/services/systemSettingsService";

export default defineEventHandler(() => {
  const config = useRuntimeConfig();
  const service = getOrCreateSearchService(config);
  const system = getSystemSettings(config);
  const registry = service.getPluginManager().snapshot();
  const healthStatus = service.getPluginHealthStatus();
  const healthByPlugin = new Map(
    healthStatus.map((status) => [status.name, status])
  );
  const plugins = registry.plugins.map((plugin) => ({
    id: plugin.manifest.id,
    name: plugin.manifest.name,
    version: plugin.manifest.version,
    kind: plugin.manifest.kind,
    health: healthByPlugin.get(plugin.manifest.id),
  }));
  // 搜索实际来源：健康快照中有真实搜索流量的解析器（探测/测试不记入健康统计）。
  const searchSources = healthStatus
    .filter((status) => status.requestCount > 0)
    .map((status) => ({
      id: status.name,
      request_count: status.requestCount,
      success_count: status.successCount,
      failure_count: status.totalFailureCount,
      circuit_state: status.circuitState,
      last_used_at:
        Math.max(status.lastSuccessTime ?? 0, status.lastFailureTime ?? 0) ||
        undefined,
    }));
  return {
    // —— 向后兼容字段：status 保留“存活检查”语义 ——
    status: "ok",
    plugins_enabled: true,
    registry_version: registry.version,
    plugin_count: plugins.length,
    plugins,
    channels: system.defaultChannels,
    // —— 语义分层：存活 / 管理员有效来源 / 搜索实际来源 ——
    liveness: {
      status: "ok",
      checked_at: new Date().toISOString(),
    },
    admin_sources: {
      // Registry 快照即管理员生效配置：已开启解析器（关闭/归档的已被剔除）。
      count: plugins.length,
      ids: plugins.map((plugin) => plugin.id),
      registry_version: registry.version,
    },
    search_sources: {
      count: searchSources.length,
      sources: searchSources,
    },
  };
});
