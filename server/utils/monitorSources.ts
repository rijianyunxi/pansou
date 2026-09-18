import {
  DIMENSION_KEYS,
  type SourceDimensionKey,
  type SourceHealthHourlyBucket,
  type SourceHealthStatus,
} from "../core/services/sourceHealth";
import { getSourceConfigurationVersion } from "../core/services/configuredSource";
import { buildUserSource, listUnifiedSources } from "../core/services/sourceCatalog";
import { getSourceLifecycleStates } from "../core/services/sourceLifecycleStore";
import { getSearchSettings } from "../core/services/searchSettingsService";
import { getSystemSettings } from "../core/services/systemSettingsService";
import { CHANNEL_NAME_PATTERN } from "../../utils/customChannels";
import {
  createSourceOriginContext,
  sourceOrigin,
  type SourceOriginContext,
} from "./sourceLifecycle";
import type { SourceDefinition } from "../../types/source";

/** A single row of the monitor response. Channel sources are resource sources too. */
export interface MonitorSourceEntry {
  id: string;
  name: string;
  priority: number;
  kind: "source";
  /** Whether the source definition is enabled. */
  enabled: boolean;
  /** Whether the source sits in the recycle bin. Default requests never return trashed entries. */
  trashed: boolean;
  /** Only channel sources carry builtin/custom origin; every other source is "". */
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
  /** Total failures; the consecutive count only drives the circuit breaker and is not surfaced. */
  failureCount: number;
  recent?: string;
  zeroResultCount: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastErrorMessage: string;
  /** Up to 10 most recent failures, newest first. */
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

const MAX_RECENT_FAILURES = 10;

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
  const outcomes = status.recentOutcomes ?? [];
  const recentFailures = outcomes
    .filter((event) => event && event.ok === false)
    .slice(-MAX_RECENT_FAILURES)
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
  const recent = status.recent || (outcomes.length ? outcomes.map((event) => event.ok ? "1" : "0").join("") : undefined);
  return {
    healthy: typeof status.isHealthy === "boolean" ? status.isHealthy : null,
    circuitState: status.circuitState,
    requestCount: status.requestCount,
    successCount: status.successCount,
    failureCount: status.totalFailureCount,
    ...(recent ? { recent } : {}),
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

function mapSource(
  source: SourceDefinition,
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
    origin: sourceOrigin(source.id, origins),
    // The manifest version is a pure hash of the configuration, so reading it
    // directly avoids materializing (and validating) a full runtime definition
    // just to display a version, and cannot fail on an incomplete source.
    version: getSourceConfigurationVersion(source),
    health: mapSourceHealth(healthById[source.id]),
  };
}

/**
 * The unified source catalog is the single source of truth for the monitor.
 * `includeDeleted` additionally rehydrates archived channel sources for the
 * console recycle bin; health still comes only from the health checker.
 */
export function buildMonitorSources(
  healthById: Record<string, SourceHealthStatus>,
  config: unknown,
  includeDeleted: boolean,
): MonitorSourceEntry[] {
  const settings = getSearchSettings();
  const system = getSystemSettings(config);
  const origins = createSourceOriginContext(settings.channels, system.defaultChannels);
  const sources = new Map<string, MonitorSourceEntry>();
  for (const source of listUnifiedSources()) {
    sources.set(source.id, mapSource(source, healthById, origins));
  }

  if (includeDeleted) {
    for (const [id, state] of Object.entries(getSourceLifecycleStates())) {
      if (!state.deleted || sources.has(id) || !CHANNEL_NAME_PATTERN.test(id)) continue;
      sources.set(id, mapSource(buildUserSource(id), healthById, origins, true));
    }
  }

  return [...sources.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}
