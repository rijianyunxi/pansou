import { defineEventHandler, getQuery, setResponseHeader } from "h3";
import { requireAdminAuth } from "../utils/requireAdminAuth";
import { getOrCreateSearchService } from "../core/services";
import { getSystemSettings } from "../core/services/systemSettingsService";
import {
  DIMENSION_KEYS,
  type PluginDimensionKey,
  type PluginHealthHourlyBucket,
  type PluginHealthStatus,
} from "../core/plugins/pluginHealth";
import { getSearchSettings } from "../core/services/searchSettingsService";
import { getTgChannelPolicies, getTgChannelStates } from "../core/services/tgChannelSettings";
import { upstreamToInstructionDefinition } from "../core/services/configuredUpstreamPlugin";
import { listConfiguredUpstreams } from "../core/services/upstreamCatalog";
import {
  getAllTgChannelHealthSummaries,
  type TgChannelHealthSummary,
} from "../core/services/tgChannelHealthStore";
import { tgChannelOrigin, type TgChannelPolicy } from "../utils/telegramSettings";
import { normalizeTelegramChannels, TG_CHANNEL_PATTERN } from "../../utils/telegramChannels";

/** /api/monitor 来源行：统一来源目录，附五维健康快照。 */
export interface MonitorUpstreamEntry {
  id: string;
  name: string;
  kind: "code" | "instructions";
  /** 来源配置已启用。 */
  enabled: boolean;
  /** 来源目录不包含已删除项，此字段恒为 false。 */
  trashed: boolean;
  version: string;
  health: MonitorUpstreamHealth | null;
}

export interface MonitorUpstreamHealth {
  healthy: boolean | null;
  circuitState: "closed" | "open" | "half-open";
  requestCount: number;
  successCount: number;
  /** 累计失败次数（区别于 PluginHealthStatus.failureCount 的连续失败数）。 */
  failureCount: number;
  recent?: string;
  zeroResultCount: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastErrorMessage: string;
  dimensions: Record<
    PluginDimensionKey,
    { state: string; passRate: number; recent: string; lastMessage: string }
  > | null;
  history: {
    windowHours: number;
    buckets: PluginHealthHourlyBucket[];
  } | null;
}

/** /api/monitor 频道行：内置默认 ∪ 自定义清单 ∪ 覆盖状态/策略/健康数据。 */
export interface MonitorChannelEntry {
  channel: string;
  origin: "builtin" | "custom";
  enabled: boolean;
  deleted: boolean;
  policy: TgChannelPolicy | null;
  health: MonitorChannelHealth | null;
}

export interface MonitorChannelHealth {
  state: "available" | "warning" | "error" | "unknown";
  failureKind: string | null;
  lastCheckedAt: number | null;
  elapsedMs: number | null;
  resultsCount: number | null;
  message: string;
  successRate: number | null;
  recent: Array<{
    at: number;
    ok: boolean;
    elapsedMs: number;
    resultsCount: number;
    failureKind?: string;
    source: "probe" | "search";
  }>;
}

function mapUpstreamHealth(status: PluginHealthStatus | undefined): MonitorUpstreamHealth | null {
  if (!status) return null;
  const dimensions = status.dimensions
    ? (Object.fromEntries(
        DIMENSION_KEYS.map((key) => {
          const dim = status.dimensions?.[key];
          return [
            key,
            {
              state: dim?.state ?? "unknown",
              passRate: dim?.passRate ?? 0,
              recent: dim?.recent ?? "",
              lastMessage: dim?.lastMessage ?? "",
            },
          ];
        }),
      ) as MonitorUpstreamHealth["dimensions"])
    : null;
  return {
    healthy: typeof status.isHealthy === "boolean" ? status.isHealthy : null,
    circuitState: status.circuitState,
    requestCount: status.requestCount,
    successCount: status.successCount,
    failureCount: status.totalFailureCount,
    ...(status.recent || status.recentOutcomes?.length ? { recent: status.recent ?? status.recentOutcomes!.map((event) => event.ok ? "1" : "0").join("") } : {}),
    zeroResultCount: status.zeroResultCount,
    lastSuccessAt: status.lastSuccessTime ?? null,
    lastFailureAt: status.lastFailureTime ?? null,
    lastErrorMessage: status.lastErrorMessage ?? "",
    dimensions,
    history: status.history
      ? {
          windowHours: status.history.windowHours,
          buckets: status.history.buckets.map((bucket) => ({
            ...bucket,
            e: bucket.e ? { ...bucket.e } : undefined,
          })),
        }
      : null,
  };
}

function mapChannelHealth(summary: TgChannelHealthSummary): MonitorChannelHealth {
  return {
    state: summary.lastState,
    failureKind: summary.failureKind,
    lastCheckedAt: summary.lastCheckedAt,
    elapsedMs: summary.elapsedMs,
    resultsCount: summary.resultsCount,
    message: summary.lastMessage,
    successRate: summary.successRate,
    recent: summary.recent.map((record) => ({
      at: record.at,
      ok: record.ok,
      elapsedMs: record.elapsedMs,
      resultsCount: record.resultsCount,
      ...(record.failureKind ? { failureKind: record.failureKind } : {}),
      source: record.source,
    })),
  };
}

/** Monitoring reads the same catalog as source management and search. */
function buildUpstreams(
  healthById: Record<string, PluginHealthStatus>,
): MonitorUpstreamEntry[] {
  return listConfiguredUpstreams().map((source) => ({
    id: source.id,
    name: source.name,
    kind: "instructions" as const,
    enabled: source.enabled !== false,
    trashed: false,
    version: upstreamToInstructionDefinition(source).manifest.version,
    health: mapUpstreamHealth(healthById[source.id]),
  })).sort((a, b) => a.id.localeCompare(b.id));
}

function buildChannels(config: unknown, options: { includeDeleted?: boolean } = {}): MonitorChannelEntry[] {
  const settings = getSearchSettings();
  const system = getSystemSettings(config);
  const builtinDefaults = normalizeTelegramChannels(system.defaultChannels);
  const states = getTgChannelStates();
  const policies = getTgChannelPolicies();
  const healthSummaries = getAllTgChannelHealthSummaries();

  // 频道清单以“当前配置 + 显式覆盖/策略”为准，健康记录只负责给已纳管频道叠加状态。
  // 不能把 healthSummaries 反向当成频道清单：健康数据是历史缓存，频道被删除/移除后
  // 仍可能保留一段时间；否则一次测试或旧配置留下的历史记录会把监控对象膨胀成几百个。
  // 默认不返回回收站频道，只有后台回收站通过 includeDeleted=true 查询它们。
  const names = new Set<string>([
    ...normalizeTelegramChannels(settings.channels ?? []),
    ...builtinDefaults,
    ...Object.keys(states),
    ...Object.keys(policies),
  ]);

  return [...names]
    .filter((name) => TG_CHANNEL_PATTERN.test(name) && (options.includeDeleted === true || !states[name]?.deleted))
    .sort()
    .map((channel) => {
      const state = states[channel];
      return {
        channel,
        origin: tgChannelOrigin(channel, settings.channels, system.defaultChannels),
        enabled: state ? state.enabled : true,
        deleted: state ? state.deleted : false,
        policy: policies[channel] ?? null,
        health: healthSummaries[channel] ? mapChannelHealth(healthSummaries[channel]!) : null,
      };
    });
}

/**
 * GET /api/monitor —— 统一监控聚合（来源解析器 + Telegram 频道）。
 * 管理员接口：requireAdminAuth；响应 no-store；默认排除回收站频道；includeDeleted=true 仅供回收站读取。
 */
export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  setResponseHeader(event, "Cache-Control", "no-store");
  try {
    const config = useRuntimeConfig();
    const includeDeleted = String(getQuery(event).includeDeleted || "") === "true";
    const service = getOrCreateSearchService(config);
    const healthById = Object.fromEntries(
      service.getPluginHealthStatus().map((status) => [status.name, status]),
    );

    return {
      code: 0,
      message: "success",
      data: {
        generatedAt: new Date().toISOString(),
        upstreams: buildUpstreams(healthById),
        channels: buildChannels(config, { includeDeleted }),
      },
    };
  } catch {
    return { code: -1, message: "获取监控数据失败", data: null };
  }
});
