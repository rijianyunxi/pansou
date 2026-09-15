import type { PluginHealthStatus, PluginHealthHistory } from "./pluginHealth";
import { getSqliteDatabase } from "../storage/sqlite";

export interface PluginHealthStore { load(): Promise<Record<string, PluginHealthStatus>>; save(snapshot: Record<string, PluginHealthStatus>): Promise<void>; }
const DIMENSIONS = ["network", "http", "business", "parsing", "results"] as const;
function parseJson<T>(value: string | null | undefined, fallback: T): T { try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; } }
function groupBy<T extends Record<string, any>>(rows: T[], key: keyof T): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) { const value = String(row[key]); const list = groups.get(value) || []; list.push(row); groups.set(value, list); }
  return groups;
}
function deleteExcept(db: ReturnType<typeof getSqliteDatabase>, table: string, key: string, values: unknown[], column: string): void {
  if (!values.length) { db.run(`DELETE FROM ${table} WHERE plugin_id=?`, key); return; }
  db.run(`DELETE FROM ${table} WHERE plugin_id=? AND ${column} NOT IN (${values.map(() => "?").join(",")})`, key, ...values);
}

export class SqlitePluginHealthStore implements PluginHealthStore {
  private readonly database;
  constructor(path?: string) { this.database = getSqliteDatabase(path); }
  async load(): Promise<Record<string, PluginHealthStatus>> {
    const out: Record<string, PluginHealthStatus> = {};
    const rows = this.database.allRows<any>("SELECT * FROM plugin_health");
    const dimensionsByPlugin = groupBy(this.database.allRows<any>("SELECT * FROM plugin_health_dimensions"), "plugin_id");
    const historyByPlugin = groupBy(this.database.allRows<any>("SELECT * FROM plugin_health_history ORDER BY bucket_time"), "plugin_id");
    const errorsByPlugin = groupBy(this.database.allRows<any>("SELECT plugin_id,category,count FROM plugin_health_errors"), "plugin_id");
    const eventsByPlugin = groupBy(this.database.allRows<any>("SELECT plugin_id,checked_at,ok,response_time_ms,result_count,error_category,message,seq FROM plugin_health_events ORDER BY plugin_id,seq DESC"), "plugin_id");
    for (const row of rows) {
      const dimensions = Object.fromEntries(DIMENSIONS.map(key => [key, { state: "unknown", passRate: 0, passCount: 0, failCount: 0, emptyCount: 0, recent: "" }])) as any;
      for (const item of dimensionsByPlugin.get(row.plugin_id) || []) dimensions[item.dimension] = { state: item.state, passRate: item.pass_rate, passCount: item.pass_count, failCount: item.fail_count, emptyCount: item.empty_count, recent: item.recent, ...(item.last_pass_time ? { lastPassTime: item.last_pass_time } : {}), ...(item.last_fail_time ? { lastFailTime: item.last_fail_time } : {}), ...(item.last_message ? { lastMessage: item.last_message } : {}) };
      const historyRows = historyByPlugin.get(row.plugin_id) || [];
      const history: PluginHealthHistory = { windowHours: 24, buckets: historyRows.map(item => ({ t: item.bucket_time, n: item.total_count, s: item.success_count, f: item.failure_count, z: item.empty_count, e: parseJson(item.error_counts, {}) })) };
      const errorCounts = Object.fromEntries((errorsByPlugin.get(row.plugin_id) || []).map(item => [item.category, item.count]));
      const recent = (eventsByPlugin.get(row.plugin_id) || []).slice(0, 100).reverse();
      out[row.plugin_id] = { name: row.plugin_id, isHealthy: !!row.is_healthy, circuitState: row.circuit_state, avgResponseTime: row.avg_response_time, p50ResponseTime: row.p50_response_time, p95ResponseTime: row.p95_response_time, failureCount: row.failure_count, totalFailureCount: row.total_failure_count, successCount: row.success_count, requestCount: row.request_count, zeroResultCount: recent.filter(event => event.ok && !event.result_count).length, resultCount: recent.reduce((sum, event) => sum + (event.result_count || 0), 0), parsingSuccessRate: row.request_count ? row.success_count / row.request_count : 0, slowRequestCount: 0, errorCounts, recent: recent.map(event => event.ok ? "1" : "0").join(""), ...(recent.at(-1)?.error_category ? { lastErrorCategory: recent.at(-1)!.error_category } : {}), ...(row.last_error ? { lastErrorMessage: row.last_error } : {}), ...(row.last_failure_time ? { lastFailureTime: row.last_failure_time } : {}), ...(row.last_success_time ? { lastSuccessTime: row.last_success_time } : {}), dimensions, history, recentOutcomes: recent.map(event => ({ at: event.checked_at, ok: !!event.ok, responseTimeMs: event.response_time_ms, resultCount: event.result_count, ...(event.error_category ? { errorCategory: event.error_category } : {}), ...(event.message ? { message: event.message } : {}) })) } as PluginHealthStatus;
    }
    return out;
  }
  async save(snapshot: Record<string, PluginHealthStatus>): Promise<void> {
    const db = this.database;
    db.transaction(() => {
      const now = Date.now();
      for (const [pluginId, status] of Object.entries(snapshot)) {
        db.run("INSERT INTO plugin_health(plugin_id,is_healthy,circuit_state,avg_response_time,p50_response_time,p95_response_time,failure_count,total_failure_count,success_count,request_count,last_success_time,last_failure_time,last_error,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(plugin_id) DO UPDATE SET is_healthy=excluded.is_healthy,circuit_state=excluded.circuit_state,avg_response_time=excluded.avg_response_time,p50_response_time=excluded.p50_response_time,p95_response_time=excluded.p95_response_time,failure_count=excluded.failure_count,total_failure_count=excluded.total_failure_count,success_count=excluded.success_count,request_count=excluded.request_count,last_success_time=excluded.last_success_time,last_failure_time=excluded.last_failure_time,last_error=excluded.last_error,updated_at=excluded.updated_at", pluginId, status.isHealthy ? 1 : 0, status.circuitState, status.avgResponseTime, status.p50ResponseTime, status.p95ResponseTime, status.failureCount, status.totalFailureCount, status.successCount, status.requestCount, status.lastSuccessTime || null, status.lastFailureTime || null, status.lastErrorMessage || null, now);
        const errors = Object.entries(status.errorCounts || {});
        deleteExcept(db, "plugin_health_errors", pluginId, errors.map(([category]) => category), "category");
        for (const [category, count] of errors) db.run("INSERT INTO plugin_health_errors(plugin_id,category,count) VALUES(?,?,?) ON CONFLICT(plugin_id,category) DO UPDATE SET count=excluded.count", pluginId, category, count);
        const dimensions = Object.entries(status.dimensions || {});
        deleteExcept(db, "plugin_health_dimensions", pluginId, dimensions.map(([dimension]) => dimension), "dimension");
        for (const [dimension, value] of dimensions) db.run("INSERT INTO plugin_health_dimensions(plugin_id,dimension,state,pass_rate,pass_count,fail_count,empty_count,recent,last_pass_time,last_fail_time,last_message) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(plugin_id,dimension) DO UPDATE SET state=excluded.state,pass_rate=excluded.pass_rate,pass_count=excluded.pass_count,fail_count=excluded.fail_count,empty_count=excluded.empty_count,recent=excluded.recent,last_pass_time=excluded.last_pass_time,last_fail_time=excluded.last_fail_time,last_message=excluded.last_message", pluginId, dimension, value.state, value.passRate, value.passCount, value.failCount, value.emptyCount, value.recent, value.lastPassTime || null, value.lastFailTime || null, value.lastMessage || null);
        const history = status.history?.buckets || [];
        deleteExcept(db, "plugin_health_history", pluginId, history.map(bucket => bucket.t), "bucket_time");
        for (const bucket of history) db.run("INSERT INTO plugin_health_history(plugin_id,bucket_time,total_count,success_count,failure_count,empty_count,error_counts) VALUES(?,?,?,?,?,?,?) ON CONFLICT(plugin_id,bucket_time) DO UPDATE SET total_count=excluded.total_count,success_count=excluded.success_count,failure_count=excluded.failure_count,empty_count=excluded.empty_count,error_counts=excluded.error_counts", pluginId, bucket.t, bucket.n, bucket.s, bucket.f, bucket.z, JSON.stringify(bucket.e || {}));
        const events = ((status as PluginHealthStatus & { recentOutcomes?: Array<any> }).recentOutcomes || []).slice(-100);
        db.run("DELETE FROM plugin_health_events WHERE plugin_id=? AND seq>?", pluginId, events.length);
        for (const [index, event] of events.entries()) db.run("INSERT INTO plugin_health_events(plugin_id,seq,checked_at,ok,response_time_ms,result_count,error_category,message) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(plugin_id,seq) DO UPDATE SET checked_at=excluded.checked_at,ok=excluded.ok,response_time_ms=excluded.response_time_ms,result_count=excluded.result_count,error_category=excluded.error_category,message=excluded.message", pluginId, index + 1, event.at || now, event.ok ? 1 : 0, event.responseTimeMs || 0, event.resultCount || 0, event.errorCategory || null, event.message || null);
      }
    });
  }
}
let healthStore: PluginHealthStore | undefined;
export function getPluginHealthStore(): PluginHealthStore { return healthStore || (healthStore = new SqlitePluginHealthStore()); }
