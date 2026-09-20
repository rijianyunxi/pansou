import { validateOutboundUrl } from "../security/outboundUrl";
import { getSqliteDatabase } from "../storage/sqlite";
import { getUserPolicy } from "./policyService";

export type ProxyCircuitState = "closed" | "open" | "half-open" | "quota_exhausted";
export const DIRECT_PROXY_NODE_ID = "direct";

export interface ProxyNode {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  dailyLimit: number;
  quotaDay: string;
  quotaUsed: number;
  circuitState: ProxyCircuitState;
  failureCount: number;
  openedUntil: number | null;
  lastStatus: number | null;
  lastError: string | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  available: boolean;
}

export interface ProxyLease {
  nodeId: string;
  /** Display name captured at selection time for request diagnostics. */
  nodeName: string;
  targetUrl: string;
  requestUrl: string;
}

export class ProxyPoolError extends Error {
  readonly code: "no_available_node" | "invalid_node";

  constructor(code: ProxyPoolError["code"], message: string) {
    super(message);
    this.name = "ProxyPoolError";
    this.code = code;
  }
}

const MAX_ERROR_LENGTH = 500;
const SHANGHAI_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

interface ProxyNodeRow {
  id: string;
  name: string;
  base_url: string;
  enabled: number;
  daily_limit: number;
  quota_day: string;
  quota_used: number;
  circuit_state: ProxyCircuitState;
  failure_count: number;
  probe_in_flight: number;
  opened_until: number | null;
  last_status: number | null;
  last_error: string | null;
  last_success_at: number | null;
  last_failure_at: number | null;
  created_at: number;
  updated_at: number;
}

function today(): string {
  return SHANGHAI_DAY.format(new Date());
}

function normalizeBaseUrl(value: unknown): string {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) throw new ProxyPoolError("invalid_node", "代理地址不能为空");
  const url = validateOutboundUrl(raw, { allowHttp: false });
  if (url.search || url.hash || url.username || url.password) {
    throw new ProxyPoolError("invalid_node", "代理地址不能包含查询参数、片段或凭据");
  }
  return url.toString().replace(/\/+$/, "");
}

function normalizeDailyLimit(value: unknown): number {
  const limit = Number(value ?? 0);
  if (!Number.isInteger(limit) || limit < 0 || limit > 10_000_000) {
    throw new ProxyPoolError("invalid_node", "每日额度必须是 0 到 10000000 的整数，0 表示不限额");
  }
  return limit;
}

function resetDailyCounters(): void {
  const db = getSqliteDatabase();
  const day = today();
  db.run(
    "UPDATE proxy_nodes SET quota_day=?,quota_used=0,circuit_state=CASE WHEN circuit_state='quota_exhausted' THEN 'closed' ELSE circuit_state END,probe_in_flight=0,updated_at=? WHERE quota_day<>?",
    day,
    Date.now(),
    day,
  );
}

function toNode(row: ProxyNodeRow, now = Date.now()): ProxyNode {
  const quotaAvailable = row.daily_limit <= 0 || row.quota_used < row.daily_limit;
  const circuitAvailable = row.circuit_state === "closed"
    || (row.circuit_state === "open" && (row.opened_until || 0) <= now && row.probe_in_flight === 0)
    || (row.circuit_state === "half-open" && row.probe_in_flight === 0);
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    enabled: Boolean(row.enabled),
    dailyLimit: row.daily_limit,
    quotaDay: row.quota_day,
    quotaUsed: row.quota_used,
    circuitState: row.circuit_state,
    failureCount: row.failure_count,
    openedUntil: row.opened_until,
    lastStatus: row.last_status,
    lastError: row.last_error,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    available: Boolean(row.enabled) && quotaAvailable && circuitAvailable,
  };
}

function getRow(id: string): ProxyNodeRow | undefined {
  return getSqliteDatabase().getRow<ProxyNodeRow>("SELECT * FROM proxy_nodes WHERE id=?", id);
}

interface WeightedProxyCandidate {
  node: ProxyNode;
  weight: number;
}

function weightedPick(nodes: WeightedProxyCandidate[]): WeightedProxyCandidate {
  const total = nodes.reduce((sum, item) => sum + item.weight, 0);
  let cursor = Math.random() * total;
  for (const item of nodes) {
    cursor -= item.weight;
    if (cursor < 0) return item;
  }
  return nodes[nodes.length - 1]!;
}

function errorText(error: unknown): string {
  return String(error instanceof Error ? error.message : error).slice(0, MAX_ERROR_LENGTH);
}

function shortNameHash(value: string): string {
  let hash = 2166136261;
  for (const character of value.normalize("NFKC")) {
    hash ^= character.codePointAt(0) || 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function createNodeId(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  const root = /^[\x00-\x7F]*$/.test(name) && slug.length >= 2
    ? slug
    : `proxy-${shortNameHash(name)}`;
  const db = getSqliteDatabase();
  let candidate = root;
  let suffix = 2;
  while (candidate === DIRECT_PROXY_NODE_ID || db.getRow("SELECT 1 FROM proxy_nodes WHERE id=?", candidate)) {
    const suffixText = `-${suffix++}`;
    candidate = `${root.slice(0, 64 - suffixText.length)}${suffixText}`;
  }
  return candidate;
}

export function listProxyNodes(): ProxyNode[] {
  resetDailyCounters();
  const now = Date.now();
  return getSqliteDatabase()
    .allRows<ProxyNodeRow>("SELECT * FROM proxy_nodes ORDER BY CASE WHEN id='direct' THEN 0 ELSE 1 END, name ASC, id ASC")
    .map((row) => toNode(row, now));
}

export function createProxyNode(raw: unknown): ProxyNode {
  const value = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const name = String(value.name || "").trim().slice(0, 100);
  if (!name) throw new ProxyPoolError("invalid_node", "节点名称不能为空");
  const id = createNodeId(name);
  const baseUrl = normalizeBaseUrl(value.baseUrl);
  const dailyLimit = normalizeDailyLimit(value.dailyLimit ?? 0);
  const enabled = value.enabled !== false;
  const now = Date.now();
  const db = getSqliteDatabase();
  try {
    db.run(
      "INSERT INTO proxy_nodes(id,name,base_url,enabled,daily_limit,quota_day,quota_used,circuit_state,failure_count,probe_in_flight,opened_until,last_status,last_error,last_success_at,last_failure_at,created_at,updated_at) VALUES(?,?,?, ?,?,?,0,'closed',0,0,NULL,NULL,NULL,NULL,NULL,?,?)",
      id,
      name,
      baseUrl,
      enabled ? 1 : 0,
      dailyLimit,
      today(),
      now,
      now,
    );
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw new ProxyPoolError("invalid_node", "节点 ID 已存在");
    throw error;
  }
  return toNode(getRow(id)!);
}

export function updateProxyNode(id: string, raw: unknown): ProxyNode {
  if (id === DIRECT_PROXY_NODE_ID) throw new ProxyPoolError("invalid_node", "直连节点由系统维护");
  const current = getRow(id);
  if (!current) throw new ProxyPoolError("invalid_node", "代理节点不存在");
  const value = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const name = value.name === undefined ? current.name : String(value.name).trim().slice(0, 100);
  if (!name) throw new ProxyPoolError("invalid_node", "节点名称不能为空");
  const baseUrl = normalizeBaseUrl(value.baseUrl === undefined ? current.base_url : value.baseUrl);
  const dailyLimit = normalizeDailyLimit(value.dailyLimit === undefined ? current.daily_limit : value.dailyLimit);
  const enabled = value.enabled === undefined ? Boolean(current.enabled) : value.enabled !== false;
  getSqliteDatabase().run(
    "UPDATE proxy_nodes SET name=?,base_url=?,enabled=?,daily_limit=?,updated_at=? WHERE id=?",
    name,
    baseUrl,
    enabled ? 1 : 0,
    dailyLimit,
    Date.now(),
    id,
  );
  return toNode(getRow(id)!);
}

export function deleteProxyNode(id: string): void {
  if (id === DIRECT_PROXY_NODE_ID) throw new ProxyPoolError("invalid_node", "直连节点由系统维护");
  const result = getSqliteDatabase().run("DELETE FROM proxy_nodes WHERE id=?", id);
  if (!result.changes) throw new ProxyPoolError("invalid_node", "代理节点不存在");
}

export function resetProxyNode(id: string): ProxyNode {
  const result = getSqliteDatabase().run(
    "UPDATE proxy_nodes SET circuit_state='closed',failure_count=0,probe_in_flight=0,opened_until=NULL,last_error=NULL,updated_at=? WHERE id=?",
    Date.now(),
    id,
  );
  if (!result.changes) throw new ProxyPoolError("invalid_node", "代理节点不存在");
  return toNode(getRow(id)!);
}

/** Clear persisted health state for every proxy node without touching quota or configuration. */
export function resetAllProxyNodeHealth(): number {
  const result = getSqliteDatabase().run(
    "UPDATE proxy_nodes SET circuit_state=CASE WHEN circuit_state='quota_exhausted' THEN 'quota_exhausted' ELSE 'closed' END,failure_count=0,probe_in_flight=0,opened_until=NULL,last_status=NULL,last_error=NULL,last_success_at=NULL,last_failure_at=NULL,updated_at=?",
    Date.now(),
  );
  return result.changes;
}

export function acquireProxyRequest(targetUrl: string, excludedNodeIds: ReadonlySet<string> = new Set(), groupId?: string): ProxyLease {
  resetDailyCounters();
  const db = getSqliteDatabase();
  const now = Date.now();
  let candidates = listProxyNodes().filter((node) => node.available && !excludedNodeIds.has(node.id)).map((node) => ({ node, weight: 1 }));
  if (groupId) {
    const group = db.getRow<{ enabled: number }>("SELECT enabled FROM proxy_groups WHERE id=?", groupId);
    const members = db.allRows<{ node_id: string; weight: number }>("SELECT node_id,weight FROM proxy_group_nodes WHERE group_id=?", groupId);
    if (!group?.enabled) candidates = [];
    else {
      const weights = new Map(members.map((item) => [item.node_id, item.weight]));
      candidates = candidates.filter((item) => weights.has(item.node.id)).map((item) => ({ ...item, weight: weights.get(item.node.id)! }));
    }
  }
  const pending = [...candidates];

  while (pending.length) {
    const picked = weightedPick(pending);
    const node = picked.node;
    const index = pending.findIndex((item) => item.node.id === node.id);
    pending.splice(index, 1);
    const result = db.run(
      `UPDATE proxy_nodes
       SET quota_used=quota_used+1,
           circuit_state=CASE WHEN circuit_state='open' THEN 'half-open' ELSE circuit_state END,
           probe_in_flight=CASE WHEN circuit_state IN ('open','half-open') THEN 1 ELSE 0 END,
           updated_at=?
       WHERE id=? AND enabled=1
         AND (daily_limit=0 OR quota_used<daily_limit)
         AND (circuit_state='closed' OR (circuit_state='open' AND (opened_until IS NULL OR opened_until<=?) AND probe_in_flight=0) OR (circuit_state='half-open' AND probe_in_flight=0))`,
      now,
      node.id,
      now,
    );
    if (!result.changes) continue;
    const requestUrl = node.baseUrl ? `${node.baseUrl}/${encodeURIComponent(targetUrl)}` : targetUrl;
    return { nodeId: node.id, nodeName: node.id === DIRECT_PROXY_NODE_ID ? "直连" : node.name, targetUrl, requestUrl };
  }

  throw new ProxyPoolError("no_available_node", "当前没有可用的代理节点");
}

export function reportProxySuccess(nodeId: string, status: number): void {
  getSqliteDatabase().run(
    "UPDATE proxy_nodes SET circuit_state='closed',failure_count=0,probe_in_flight=0,opened_until=NULL,last_status=?,last_error=NULL,last_success_at=?,updated_at=? WHERE id=?",
    status,
    Date.now(),
    Date.now(),
    nodeId,
  );
}

export function reportProxyFailure(
  nodeId: string,
  options: { status?: number | null; message?: string; quotaExhausted?: boolean } = {},
): void {
  const now = Date.now();
  const db = getSqliteDatabase();
  const current = getRow(nodeId);
  if (!current) return;
  if (options.quotaExhausted) {
    db.run(
      "UPDATE proxy_nodes SET circuit_state='quota_exhausted',failure_count=0,probe_in_flight=0,opened_until=NULL,last_status=?,last_error=?,last_failure_at=?,updated_at=? WHERE id=?",
      options.status ?? null,
      errorText(options.message || "每日额度已用完"),
      now,
      now,
      nodeId,
    );
    return;
  }
  const failures = current.failure_count + 1;
  const policy = getUserPolicy();
  // A failed half-open probe immediately re-opens the circuit; otherwise a
  // single probe could incorrectly make a previously unhealthy node normal.
  const opened = current.circuit_state === "half-open" || failures >= policy.proxyCircuitBreakerMaxFailures;
  db.run(
    "UPDATE proxy_nodes SET circuit_state=?,failure_count=?,probe_in_flight=0,opened_until=?,last_status=?,last_error=?,last_failure_at=?,updated_at=? WHERE id=?",
    opened ? "open" : "closed",
    failures,
    opened ? now + policy.proxyCircuitBreakerTimeoutSeconds * 1000 : null,
    options.status ?? null,
    errorText(options.message || "请求失败"),
    now,
    now,
    nodeId,
  );
}
