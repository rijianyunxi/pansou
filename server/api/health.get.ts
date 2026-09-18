import { defineEventHandler } from "h3";
import { getOrCreateSearchService } from "../core/services";
import type { SourceHealthStatus } from "../core/services/sourceHealth";
import { listUnifiedSources } from "../core/services/sourceCatalog";
import { setNoStore } from "../utils/apiResponse";

/**
 * Public liveness plus a coarse per-source summary.
 *
 * This endpoint is unauthenticated, so the payload is a **whitelist**: only the
 * fields named here leave the process. The detailed view — recent outcomes with
 * their result counts, upstream error messages, per-dimension verdicts and the
 * hourly history — stays on the console API (`/api/monitor`), which requires an
 * admin session. Naming the fields explicitly is the point: a field added to
 * `SourceHealthStatus` later cannot start leaking just because it was added.
 *
 * Internal source-selection settings are deliberately not part of this
 * response either.
 */
function publicHealth(status: SourceHealthStatus) {
  return {
    name: status.name,
    isHealthy: status.isHealthy,
    circuitState: status.circuitState,
    avgResponseTime: status.avgResponseTime,
    p50ResponseTime: status.p50ResponseTime,
    p95ResponseTime: status.p95ResponseTime,
    failureCount: status.failureCount,
    successCount: status.successCount,
    requestCount: status.requestCount,
    lastSuccessTime: status.lastSuccessTime,
    lastFailureTime: status.lastFailureTime,
  };
}

export default defineEventHandler((event) => {
  setNoStore(event);
  const service = getOrCreateSearchService();
  const health = service.getSourceHealthStatus();
  const healthById = new Map(health.map((item) => [item.id || item.name, item]));
  const sources = listUnifiedSources().map((source) => {
    const status = healthById.get(source.id);
    return {
      id: source.id,
      name: source.name,
      priority: source.priority,
      enabled: source.enabled !== false,
      ...(status ? { health: publicHealth(status) } : {}),
    };
  });
  return {
    status: "ok",
    sources_enabled: sources.filter((source) => source.enabled).length,
    sources,
    liveness: { status: "ok", checked_at: new Date().toISOString() },
    // Count only; the per-source detail used to be duplicated here as well.
    resource_sources: { count: health.length },
  };
});
