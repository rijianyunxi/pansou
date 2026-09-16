import { defineEventHandler, getQuery, setResponseHeader } from "h3";
import { requireAdminAuth } from "../utils/requireAdminAuth";
import { getOrCreateSearchService } from "../core/services";
import { getSystemSettings } from "../core/services/systemSettingsService";
import {
  DIMENSION_KEYS,
  type SourceDimensionKey,
  type SourceHealthHourlyBucket,
  type SourceHealthStatus,
} from "../core/services/sourceHealth";
import { getSearchSettings } from "../core/services/searchSettingsService";
import { getTgChannelStates } from "../core/services/tgChannelSettings"
import { upstreamToSourceDefinition } from "../core/services/configuredSource";
import { listUnifiedUpstreams } from "../core/services/upstreamCatalog";
import {
  getAllTgChannelHealthSummaries,
  type TgChannelHealthSummary,
} from "../core/services/tgChannelHealthStore";
import { tgChannelOrigin } from "../utils/telegramSettings"
import { normalizeTelegramChannels, TG_CHANNEL_PATTERN } from "../../utils/telegramChannels";

/** /api/monitor 来源行：统一来源目录，附五维健康快照。 */
export interface MonitorUpstreamEntry {
  id: string;
  name: string;
  kind: "code" | "source";
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
  /** 累计失败次数（区别于 SourceHealthStatus.failureCount 的连续失败数）。 */
  failureCount: number;
  recent?: string;
  zeroResultCount: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastErrorMessage: string;
  dimensions: Record<
    SourceDimensionKey,
    { state: string; passRate: number; recent: string; lastMessage: string }
  > | null;
  history: {
    windowHours: number;
    buckets: SourceHealthHourlyBucket[];
  } | null;
}

/** /api/monitor 频道行：内置默认 ∪ 自定义清单 ∪ 覆盖状态/策略/健康数据。 */
export interface MonitorChannelEntry {
  channel: string;
  origin: "builtin" | "custom";
  enabled: boolean;
  deleted: boolean;
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

function mapUpstreamHealth(status: SourceHealthStatus | undefined): MonitorUpstreamHealth | null {
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

/**
 * 监控和来源管理必须使用同一份统一来源目录。Telegram 频道已经是来源目录中的
 * ResourceSource，不能再把它们作为第二份 upstream 列表追加，否则同一个频道会出现两次。
 */
function monitorChannelNames(config: unknown, options: { includeDeleted?: boolean } = {}): Set<string> {
  const settings = getSearchSettings();
  const system = getSystemSettings(config);
  const states = getTgChannelStates();
  return new Set(
    [
      ...normalizeTelegramChannels(settings.channels ?? []),
      ...normalizeTelegramChannels(system.defaultChannels),
      ...Object.keys(states),
    ].filter((name) => TG_CHANNEL_PATTERN.test(name) && (options.includeDeleted === true || !states[name]?.deleted)),
  );
}

function buildUpstreams(
  healthById: Record<string, SourceHealthStatus>,
  channelNames: Set<string>,
): MonitorUpstreamEntry[] {
  return listUnifiedUpstreams()
    .filter((source) => !channelNames.has(source.id))
    .map((source) => ({
      id: source.id,
      name: source.name,
      kind: "source" as const,
      enabled: source.enabled !== false,
      trashed: false,
      version: upstreamToSourceDefinition(source).manifest.version,
      health: mapUpstreamHealth(healthById[source.id]),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function buildChannels(config: unknown, options: { includeDeleted?: boolean } = {}): MonitorChannelEntry[] {
  const settings = getSearchSettings();
  const system = getSystemSettings(config);
  const states = getTgChannelStates();
  const healthSummaries = getAllTgChannelHealthSummaries();
  const names = monitorChannelNames(config, options);

  // 频道清单以统一来源目录对应的当前配置 + 显式覆盖/策略为准，健康记录只负责叠加状态。
  // 不能把 healthSummaries 反向当成频道清单，否则历史健康数据会制造重复或幽灵来源。
  return [...names]
    .sort()
    .map((channel) => {
      const state = states[channel];
      return {
        channel,
        origin: tgChannelOrigin(channel, settings.channels, system.defaultChannels),
        enabled: state ? state.enabled : true,
        deleted: state ? state.deleted : false,
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
      service.getSourceHealthStatus().map((status) => [status.id || status.name, status]),
    );

    return {
      code: 0,
      message: "success",
      data: {
        generatedAt: new Date().toISOString(),
        upstreams: buildUpstreams(healthById, monitorChannelNames(config)),
        channels: buildChannels(config, { includeDeleted }),
      },
    };
  } catch {
    return { code: -1, message: "获取监控数据失败", data: null };
  }
});
