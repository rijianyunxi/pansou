import { getSqliteDatabase } from "../storage/sqlite";
import type { ProxyNode } from "./proxyPoolService";

export type ProxyRouteAction = "direct" | "group";

export interface ProxyGroup {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  fallbackAction: "error" | "direct";
  nodes: Array<{ nodeId: string; weight: number; node?: ProxyNode }>;
}

export interface ProxyRoute {
  id: string;
  name: string;
  priority: number;
  enabled: boolean;
  sourceIds: string[];
  action: ProxyRouteAction;
  groupId: string | null;
}

export interface ProxyRouteDecision {
  routeId: string;
  routeName: string;
  action: ProxyRouteAction;
  groupId: string | null;
  fallbackAction: "error" | "direct";
}

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;

function text(value: unknown, label: string, max = 100): string {
  const result = String(value ?? "").trim();
  if (!result || result.length > max) throw new Error(`${label}不能为空且不能超过 ${max} 个字符`);
  return result;
}

function id(value: unknown, label: string): string {
  const result = text(value, label, 64).toLowerCase();
  if (!ID_PATTERN.test(result)) throw new Error(`${label}格式不正确，只能使用小写字母、数字、下划线和短横线`);
  return result;
}

function toGroup(row: any, nodeMap: Map<string, ProxyNode>): ProxyGroup {
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    enabled: Boolean(row.enabled),
    fallbackAction: row.fallback_action === "direct" ? "direct" : "error",
    nodes: (row.nodes || []).map((item: any) => ({ nodeId: item.node_id, weight: item.weight, node: nodeMap.get(item.node_id) })),
  };
}

export function listProxyGroups(nodes: ProxyNode[] = []): ProxyGroup[] {
  const db = getSqliteDatabase();
  const rows = db.allRows<any>("SELECT * FROM proxy_groups ORDER BY name ASC,id ASC");
  const nodeRows = db.allRows<any>("SELECT group_id,node_id,weight FROM proxy_group_nodes ORDER BY group_id,node_id");
  const byGroup = new Map<string, any[]>();
  for (const item of nodeRows) (byGroup.get(item.group_id) || (byGroup.set(item.group_id, []), byGroup.get(item.group_id)!)).push(item);
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  return rows.map((row) => toGroup({ ...row, nodes: byGroup.get(row.id) || [] }, nodeMap));
}

export function listProxyRoutes(): ProxyRoute[] {
  const rows = getSqliteDatabase().allRows<any>("SELECT * FROM proxy_routes ORDER BY priority ASC,id ASC");
  return rows.map((row) => {
    let parsedSources: unknown;
    try { parsedSources = JSON.parse(row.source_ids_json || "[]"); } catch { parsedSources = []; }
    const sourceIds = Array.isArray(parsedSources) ? parsedSources.map((item) => String(item).trim()).filter(Boolean) : [];
    return {
      id: row.id,
      name: row.name,
      priority: row.priority,
      enabled: Boolean(row.enabled),
      sourceIds,
      action: row.action,
      groupId: row.group_id || null,
    };
  });
}

export function createProxyGroup(raw: unknown): ProxyGroup {
  const value = (raw || {}) as Record<string, unknown>;
  const groupId = id(value.id, "组 ID");
  const name = text(value.name, "组名称");
  const description = String(value.description ?? "").trim().slice(0, 300);
  const fallbackAction = value.fallbackAction === "direct" ? "direct" : "error";
  const members = normalizeMembers(value.nodes);
  const now = Date.now();
  const db = getSqliteDatabase();
  db.transaction(() => {
    db.run("INSERT INTO proxy_groups(id,name,description,enabled,fallback_action,created_at,updated_at) VALUES(?,?,?,1,?,?,?)", groupId, name, description, fallbackAction, now, now);
    for (const item of members) db.run("INSERT INTO proxy_group_nodes(group_id,node_id,weight) VALUES(?,?,?)", groupId, item.nodeId, item.weight);
  });
  return listProxyGroups().find((item) => item.id === groupId)!;
}

export function updateProxyGroup(groupId: string, raw: unknown): ProxyGroup {
  const value = (raw || {}) as Record<string, unknown>;
  const name = text(value.name, "组名称");
  const description = String(value.description ?? "").trim().slice(0, 300);
  const fallbackAction = value.fallbackAction === "direct" ? "direct" : "error";
  const members = normalizeMembers(value.nodes);
  const db = getSqliteDatabase();
  if (!db.getRow("SELECT id FROM proxy_groups WHERE id=?", groupId)) throw new Error("节点组不存在");
  db.transaction(() => {
    db.run("UPDATE proxy_groups SET name=?,description=?,enabled=?,fallback_action=?,updated_at=? WHERE id=?", name, description, value.enabled === false ? 0 : 1, fallbackAction, Date.now(), groupId);
    db.run("DELETE FROM proxy_group_nodes WHERE group_id=?", groupId);
    for (const item of members) db.run("INSERT INTO proxy_group_nodes(group_id,node_id,weight) VALUES(?,?,?)", groupId, item.nodeId, item.weight);
  });
  return listProxyGroups().find((item) => item.id === groupId)!;
}

export function deleteProxyGroup(groupId: string): void {
  const result = getSqliteDatabase().run("DELETE FROM proxy_groups WHERE id=?", groupId);
  if (!result.changes) throw new Error("节点组不存在");
}

function normalizeMembers(value: unknown): Array<{ nodeId: string; weight: number }> {
  if (!Array.isArray(value)) return [];
  const result: Array<{ nodeId: string; weight: number }> = [];
  for (const item of value) {
    const object = (item || {}) as Record<string, unknown>;
    const nodeId = text(object.nodeId ?? object.id, "节点 ID", 64);
    const weight = Number(object.weight ?? 1);
    if (!Number.isInteger(weight) || weight < 1 || weight > 100) throw new Error("组内权重必须是 1 到 100 的整数");
    if (!getSqliteDatabase().getRow("SELECT id FROM proxy_nodes WHERE id=?", nodeId)) throw new Error(`节点不存在：${nodeId}`);
    if (result.some((entry) => entry.nodeId === nodeId)) throw new Error(`节点重复：${nodeId}`);
    result.push({ nodeId, weight });
  }
  return result;
}

function normalizeSourceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result = [...new Set(value.map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
  const db = getSqliteDatabase();
  for (const sourceId of result) {
    if (!db.getRow("SELECT id FROM resource_sources WHERE id=? AND NOT EXISTS (SELECT 1 FROM deleted_sources WHERE deleted_sources.id=resource_sources.id)", sourceId)) {
      throw new Error(`资源源不存在：${sourceId}`);
    }
  }
  return result;
}

function assertSourceBindingsAvailable(sourceIds: string[], routeId?: string): void {
  const db = getSqliteDatabase();
  const rows = db.allRows<{ id: string; name: string; source_ids_json: string }>("SELECT id,name,source_ids_json FROM proxy_routes WHERE id<>?", routeId || "");
  for (const row of rows) {
    let existing: unknown;
    try { existing = JSON.parse(row.source_ids_json || "[]"); } catch { existing = []; }
    const overlap = Array.isArray(existing) && sourceIds.find((sourceId) => existing.includes(sourceId));
    if (overlap) throw new Error(`资源源「${overlap}」已经绑定策略「${row.name}」`);
  }
}

export function createProxyRoute(raw: unknown): ProxyRoute {
  const value = (raw || {}) as Record<string, unknown>;
  const routeId = id(value.id, "规则 ID");
  const name = text(value.name, "规则名称");
  const sourceIds = normalizeSourceIds(value.sourceIds);
  if (!sourceIds.length) throw new Error("至少选择一个资源源");
  assertSourceBindingsAvailable(sourceIds);
  const action = value.action === "direct" ? "direct" : "group";
  const groupId = action === "group" ? text(value.groupId, "节点组", 64) : null;
  if (groupId && !getSqliteDatabase().getRow("SELECT id FROM proxy_groups WHERE id=?", groupId)) throw new Error("节点组不存在");
  const priority = normalizePriority(value.priority);
  const now = Date.now();
  getSqliteDatabase().run("INSERT INTO proxy_routes(id,name,priority,enabled,source_ids_json,action,group_id,created_at,updated_at) VALUES(?,?,?, ?,?,?,?,?,?)", routeId, name, priority, value.enabled === false ? 0 : 1, JSON.stringify(sourceIds), action, groupId, now, now);
  return listProxyRoutes().find((item) => item.id === routeId)!;
}

export function updateProxyRoute(routeId: string, raw: unknown): ProxyRoute {
  const value = (raw || {}) as Record<string, unknown>;
  const name = text(value.name, "规则名称");
  const sourceIds = normalizeSourceIds(value.sourceIds);
  if (!sourceIds.length) throw new Error("至少选择一个资源源");
  assertSourceBindingsAvailable(sourceIds, routeId);
  const action = value.action === "direct" ? "direct" : "group";
  const groupId = action === "group" ? text(value.groupId, "节点组", 64) : null;
  if (groupId && !getSqliteDatabase().getRow("SELECT id FROM proxy_groups WHERE id=?", groupId)) throw new Error("节点组不存在");
  const result = getSqliteDatabase().run("UPDATE proxy_routes SET name=?,priority=?,enabled=?,source_ids_json=?,action=?,group_id=?,updated_at=? WHERE id=?", name, normalizePriority(value.priority), value.enabled === false ? 0 : 1, JSON.stringify(sourceIds), action, groupId, Date.now(), routeId);
  if (!result.changes) throw new Error("路由规则不存在");
  return listProxyRoutes().find((item) => item.id === routeId)!;
}

export function deleteProxyRoute(routeId: string): void {
  const result = getSqliteDatabase().run("DELETE FROM proxy_routes WHERE id=?", routeId);
  if (!result.changes) throw new Error("路由规则不存在");
}

function normalizePriority(value: unknown): number {
  const result = Number(value ?? 100);
  if (!Number.isInteger(result) || result < 0 || result > 100000) throw new Error("优先级必须是 0 到 100000 的整数");
  return result;
}

export function resolveProxyRoute(sourceId?: string): ProxyRouteDecision | undefined {
  if (!sourceId) return undefined;
  const routes = listProxyRoutes();
  const sourceRoute = routes.find((route) => route.enabled && route.sourceIds.includes(sourceId));
  return sourceRoute ? buildDecision(sourceRoute) : undefined;
}

function buildDecision(route: ProxyRoute): ProxyRouteDecision {
  // Read fallback policy even when the group is disabled. A disabled group
  // should still honor its configured direct/error fallback behavior.
  const group = route.groupId ? getSqliteDatabase().getRow<any>("SELECT fallback_action FROM proxy_groups WHERE id=?", route.groupId) : undefined;
  return { routeId: route.id, routeName: route.name, action: route.action, groupId: route.groupId, fallbackAction: group?.fallback_action === "direct" ? "direct" : "error" };
}
