import { defineEventHandler } from "h3";
import { getOrCreateSearchService } from "../core/services";
import {
  DIMENSION_KEYS,
  MAX_HISTORY_BUCKETS,
  sanitizeHistoryBuckets,
  type PluginDimensionKey,
  type PluginDimensionState,
  type PluginHealthHourlyBucket,
  type PluginHealthStatus,
} from "../core/plugins/pluginHealth";

/** 跨插件聚合的每小时趋势：复用有界归并逻辑，桶数与分类数不会超出上限。 */
function aggregateTrend(plugins: PluginHealthStatus[]): {
  windowHours: number;
  buckets: PluginHealthHourlyBucket[];
} {
  return {
    windowHours: MAX_HISTORY_BUCKETS,
    buckets: sanitizeHistoryBuckets(
      plugins.flatMap((plugin) => plugin.history?.buckets ?? [])
    ),
  };
}

/** 各维度处于每种状态的插件数，供概览快速定位薄弱层。 */
function dimensionSummary(plugins: PluginHealthStatus[]): Record<
  PluginDimensionKey,
  Record<PluginDimensionState, number>
> {
  const summary = Object.fromEntries(
    DIMENSION_KEYS.map((key) => [
      key,
      { pass: 0, fail: 0, empty: 0, unknown: 0 },
    ])
  ) as Record<PluginDimensionKey, Record<PluginDimensionState, number>>;
  for (const plugin of plugins) {
    for (const key of DIMENSION_KEYS) {
      const state = plugin.dimensions?.[key]?.state ?? "unknown";
      summary[key][state]++;
    }
  }
  return summary;
}

export default defineEventHandler(() => {
  try {
    const service = getOrCreateSearchService(useRuntimeConfig());
    const healthStatus = service.getPluginHealthStatus();
    return {
      code: 0,
      message: "success",
      data: {
        registryVersion: service.getPluginManager().snapshot().version,
        total: healthStatus.length,
        healthy: healthStatus.filter((plugin) => plugin.isHealthy).length,
        unhealthy: healthStatus.filter((plugin) => !plugin.isHealthy).length,
        plugins: healthStatus,
        trend: aggregateTrend(healthStatus),
        dimensionSummary: dimensionSummary(healthStatus),
        cache: service.getCacheStats(),
      },
    };
  } catch {
    return {
      code: -1,
      message: "获取插件健康状态失败",
      data: null,
    };
  }
});
