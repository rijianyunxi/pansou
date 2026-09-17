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
import { getTgChannelStates } from "../core/services/tgChannelSettings";
import { upstreamToSourceDefinition } from "../core/services/configuredSource";
import { buildUserSource, listUnifiedUpstreams } from "../core/services/upstreamCatalog";
import { tgChannelOrigin } from "../utils/telegramSettings";
import { normalizeTelegramChannels, TG_CHANNEL_PATTERN } from "../../utils/telegramChannels";
import type { UpstreamDefinition } from "../../types/source";

/** /api/monitor 的统一资源源行。Telegram 频道也是 ResourceSource，不再单独建模。 */
export interface MonitorSourceEntry {
  id: string;
  name: string;
  priority: number;
  kind: "source";
  /** 来源配置是否启用。 */
  enabled: boolean;
  /** 是否在回收站中。默认接口不会返回 trashed=true 的资源源。 */
  trashed: boolean;
  /** 仅 Telegram 资源源有 builtin/custom 来源信息，其他资源源为空。 */
  origin: "builtin" | "custom" | "";
  version: string;
  health: MonitorSourceHealth | null;
}

export interface MonitorFailureRecord {
  at: number;
  responseTimeMs: number | null;
  errorCategory: string;
  message: string;
}

export interface MonitorSourceHealth {
  healthy: boolean | null;
  circuitState: "closed" | "open" | "half-open";
  requestCount: number;
  successCount: number;
  /** 累计失败次数；连续失败数只用于熔断，不直接展示。 */
  failureCount: number;
  recent?: string;
  zeroResultCount: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastErrorMessage: string;
  /** 最近 10 条失败记录，按时间倒序返回。 */
  recentFailures: MonitorFailureRecord[];
  dimensions: Record<
    SourceDimensionKey,
    { state: string; passRate: number; recent: string; lastMessage: string }
  > | null;
  history: {
    windowHours: number;
    buckets: SourceHealthHourlyBucket[];
  } | null;
}

export interface MonitorData {
  generatedAt: string;
  sources: MonitorSourceEntry[];
}

function mapSourceHealth(status: SourceHealthStatus | undefined): MonitorSourceHealth | null {
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
      ) as MonitorSourceHealth["dimensions"])
    : null;
  const recentFailures = (status.recentOutcomes || [])
    .filter((event) => event && event.ok === false)
    .slice(-10)
    .reverse()
    .map((event) => ({
      at: event.at,
      responseTimeMs: typeof event.responseTimeMs === "number" ? event.responseTimeMs : null,
      errorCategory: event.errorCategory || "unknown_error",
      message: event.message || "",
    }));
  // Older snapshots may contain counters but no per-request outcomes. Keep one
  // useful compatibility record instead of making an existing failure invisible.
  if (!recentFailures.length && status.totalFailureCount > 0 && status.lastFailureTime) {
    recentFailures.push({
      at: status.lastFailureTime,
      responseTimeMs: null,
      errorCategory: status.lastErrorCategory || "unknown_error",
      message: status.lastErrorMessage || "",
    });
  }
  return {
    healthy: typeof status.isHealthy === "boolean" ? status.isHealthy : null,
    circuitState: status.circuitState,
    requestCount: status.requestCount,
    successCount: status.successCount,
    failureCount: status.totalFailureCount,
    ...(status.recent || status.recentOutcomes?.length
      ? { recent: status.recent ?? status.recentOutcomes!.map((event) => event.ok ? "1" : "0").join("") }
      : {}),
    zeroResultCount: status.zeroResultCount,
    lastSuccessAt: status.lastSuccessTime ?? null,
    lastFailureAt: status.lastFailureTime ?? null,
    lastErrorMessage: status.lastErrorMessage ?? "",
    recentFailures,
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

interface SourceOriginContext {
  custom: Set<string>;
  builtin: Set<string>;
}

function sourceOriginContext(config: unknown): SourceOriginContext {
  const settings = getSearchSettings();
  const system = getSystemSettings(config);
  return {
    custom: new Set(normalizeTelegramChannels(settings.channels ?? [])),
    builtin: new Set(normalizeTelegramChannels(system.defaultChannels)),
  };
}

function channelOrigin(id: string, origins: SourceOriginContext): "builtin" | "custom" | "" {
  if (!TG_CHANNEL_PATTERN.test(id)) return "";
  if (origins.custom.has(id)) return "custom";
  if (origins.builtin.has(id)) return "builtin";
  return "custom";
}

function mapSource(
  source: UpstreamDefinition,
  healthById: Record<string, SourceHealthStatus>,
  origins: SourceOriginContext,
  trashed = false,
): MonitorSourceEntry {
  return {
    id: source.id,
    name: source.name,
    priority: source.priority,
    kind: "source",
    enabled: source.enabled !== false && !trashed,
    trashed,
    origin: channelOrigin(source.id, origins),
    version: upstreamToSourceDefinition(source).manifest.version,
    health: mapSourceHealth(healthById[source.id]),
  };
}

/**
 * 统一来源目录是监控的唯一清单来源。includeDeleted=true 只额外补回被归档的
 * Telegram 资源源，供后台回收站读取；健康状态仍然只来自 SourceHealthChecker。
 */
function buildSources(
  healthById: Record<string, SourceHealthStatus>,
  config: unknown,
  includeDeleted: boolean,
): MonitorSourceEntry[] {
  const origins = sourceOriginContext(config);
  const sources = new Map<string, MonitorSourceEntry>();
  for (const source of listUnifiedUpstreams()) {
    sources.set(source.id, mapSource(source, healthById, origins));
  }

  if (includeDeleted) {
    const states = getTgChannelStates();
    for (const [id, state] of Object.entries(states)) {
      if (!state.deleted || sources.has(id) || !TG_CHANNEL_PATTERN.test(id)) continue;
      sources.set(id, mapSource(buildUserSource(id), healthById, origins, true));
    }
  }

  return [...sources.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** GET /api/monitor —— 所有可搜索对象统一按资源源返回。 */
export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  setResponseHeader(event, "Cache-Control", "no-store");
  try {
    const config = useRuntimeConfig();
    const includeDeleted = String(getQuery(event).includeDeleted || "") === "true";
    const service = getOrCreateSearchService();
    const healthById = Object.fromEntries(
      service.getSourceHealthStatus().map((status) => [status.id || status.name, status]),
    );

    return {
      code: 0,
      message: "success",
      data: {
        generatedAt: new Date().toISOString(),
        sources: buildSources(healthById, config, includeDeleted),
      } satisfies MonitorData,
    };
  } catch {
    return { code: -1, message: "获取监控数据失败", data: null };
  }
});
