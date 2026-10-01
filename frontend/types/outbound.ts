export interface ProxyNode {
  id: string;
  kind: "proxy" | "direct";
  name: string;
  baseUrl: string;
  enabled: boolean;
  dailyLimit: number;
  quotaUsed: number;
  circuitState: string;
  lastStatus: number | null;
  lastError: string | null;
  referenceCount: number;
}
export interface NodeWeight {
  nodeId: string;
  weight: number;
}
export interface OutboundPolicy {
  nodes: NodeWeight[];
  version: number;
  inherit?: boolean;
}
export function directPolicy(): OutboundPolicy {
  return { nodes: [{ nodeId: "direct", weight: 10 }], version: 0 };
}
export function inheritedPolicy(): OutboundPolicy {
  return { nodes: [], version: 0, inherit: true };
}
export function sortedNodes(nodes: readonly NodeWeight[]): NodeWeight[] {
  // Display order only; the server selects randomly by positive weight.
  return [...nodes].sort(
    (a, b) =>
      b.weight - a.weight ||
      (a.nodeId < b.nodeId ? 1 : a.nodeId > b.nodeId ? -1 : 0),
  );
}
export function weightedShares(nodes: readonly NodeWeight[]) {
  const total = nodes.reduce((sum, n) => sum + Math.max(0, n.weight), 0);
  return sortedNodes(nodes).map((n) => ({
    ...n,
    percent: total > 0 ? (Math.max(0, n.weight) / total) * 100 : 0,
  }));
}
export function policyLabel(policy?: OutboundPolicy | null): string {
  return !policy
    ? "未配置节点"
    : policy.inherit
      ? "使用 TG 默认节点"
      : weightedShares(policy.nodes)
          .map(
            (n) => (n.nodeId === "direct" ? "直连" : "代理") + " " +
              (n.weight > 0 ? n.percent.toFixed(1) + "%" : "不参与"),
          )
          .join("、");
}
