import { defineEventHandler, setResponseHeader } from "h3";
import { requireAdminAuth } from "../utils/requireAdminAuth";
import { getOrCreateSearchService } from "../core/services";
import { getSystemSettings } from "../core/services/systemSettingsService";
import { getPluginRepository, type PluginRecord } from "../core/plugins/repository";
import type { PluginManager } from "../core/plugins/manager";
import {
  DIMENSION_KEYS,
  type PluginDimensionKey,
  type PluginHealthHourlyBucket,
  type PluginHealthStatus,
} from "../core/plugins/pluginHealth";
import { getSearchSettings } from "../core/services/searchSettingsService";
import { getTgChannelPolicies, getTgChannelStates } from "../core/services/tgChannelSettings";
import { listConfiguredUpstreams } from "../core/services/upstreamCatalog";
import {
  getAllTgChannelHealthSummaries,
  type TgChannelHealthSummary,
} from "../core/services/tgChannelHealthStore";
import { tgChannelOrigin, type TgChannelPolicy } from "../utils/telegramSettings";
import { normalizeTelegramChannels, TG_CHANNEL_PATTERN } from "../../utils/telegramChannels";

/** /api/monitor 上游行：插件仓库 ∪ Registry，附五维健康快照。 */
export interface MonitorUpstreamEntry {
  id: string;
  name: string;
  kind: "code" | "instructions";
  /** 未停用（published 且未被放入垃圾箱）。 */
  enabled: boolean;
  /** 已删除/归档（垃圾箱内）。 */
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

/** Registry 插件与插件仓库记录按 id 归并（仓库记录是 instructions 插件的生命周期事实来源）。 */
function buildUpstreams(
  manager: PluginManager,
  records: PluginRecord[],
  healthById: Record<string, PluginHealthStatus>,
  trashedSet: Set<string>,
): MonitorUpstreamEntry[] {
  const byId = new Map<string, MonitorUpstreamEntry>();
  const recordById = new Map(records.map((record) => [record.id, record]));
  const activeIds = new Set(manager.snapshot().plugins.map((plugin) => plugin.manifest.id));
  const configuredById = new Map(listConfiguredUpstreams().map((source) => [source.id, source]));

  for (const plugin of manager.list({ includeDisabled: true })) {
    const { id, name, version, kind } = plugin.manifest;
    const record = recordById.get(id);
    const trashed = (record?.status === "archived") || trashedSet.has(id.toLowerCase());
    const configured = configuredById.get(id);
    const enabled = configured
      ? configured.enabled !== false && !trashed
      : record
        ? record.status === "published" && !trashedSet.has(id.toLowerCase())
        : activeIds.has(id) && !trashed;
    byId.set(id, {
      id,
      name: record?.definition.manifest.name || name,
      kind: kind === "instructions" ? "instructions" : "code",
      enabled,
      trashed,
      version: record
        ? record.publishedVersion || record.definition.manifest.version
        : version,
      health: mapUpstreamHealth(healthById[id]),
    });
  }

  for (const record of records) {
    if (byId.has(record.id)) continue;
    const trashed = record.status === "archived" || trashedSet.has(record.id.toLowerCase());
    byId.set(record.id, {
      id: record.id,
      name: record.definition.manifest.name,
      kind: "instructions",
      enabled: record.status === "published" && !trashedSet.has(record.id.toLowerCase()),
      trashed,
      version: record.publishedVersion || record.definition.manifest.version,
      health: mapUpstreamHealth(healthById[record.id]),
    });
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function buildChannels(config: { defaultChannels?: string[] }): MonitorChannelEntry[] {
  const settings = getSearchSettings();
  const system = getSystemSettings(config);
  const builtinDefaults = normalizeTelegramChannels(system.defaultChannels);
  const states = getTgChannelStates();
  const policies = getTgChannelPolicies();
  const healthSummaries = getAllTgChannelHealthSummaries();

  // 频道清单以“当前配置 + 显式覆盖/策略”为准，健康记录只负责给已纳管频道叠加状态。
  // 不能把 healthSummaries 反向当成频道清单：健康数据是历史缓存，频道被删除/移除后
  // 仍可能保留一段时间；否则一次测试或旧配置留下的历史记录会把监控对象膨胀成几百个。
  const names = new Set<string>([
    ...normalizeTelegramChannels(settings.channels ?? []),
    ...builtinDefaults,
    ...Object.keys(states),
    ...Object.keys(policies),
  ]);

  return [...names]
    .filter((name) => TG_CHANNEL_PATTERN.test(name))
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
 * GET /api/monitor —— 统一监控聚合（上游插件 + TG 频道）。
 * 管理员接口：requireAdminAuth；响应 no-store；出错时 { code: 非0, message }。
 */
export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  setResponseHeader(event, "Cache-Control", "no-store");
  try {
    const config = useRuntimeConfig();
    const service = getOrCreateSearchService(config);
    const records = await getPluginRepository().list({ includeArchived: true });
    const healthById = Object.fromEntries(
      service.getPluginHealthStatus().map((status) => [status.name, status]),
    );
    const trashedSet = new Set(
      getSearchSettings().trashedPlugins.map((value) => String(value).toLowerCase()),
    );

    return {
      code: 0,
      message: "success",
      data: {
        generatedAt: new Date().toISOString(),
        upstreams: buildUpstreams(service.getPluginManager(), records, healthById, trashedSet),
        channels: buildChannels(config),
      },
    };
  } catch {
    return { code: -1, message: "获取监控数据失败", data: null };
  }
});
