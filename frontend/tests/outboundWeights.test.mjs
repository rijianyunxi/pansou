import test from "node:test";
import assert from "node:assert/strict";
import { weightedShares, policyLabel } from "../types/outbound.ts";

test("20/20/10 distributes 40/40/20 and zero never participates", () => {
  const input = [
    { nodeId: "cf-1", weight: 20 },
    { nodeId: "cf-2", weight: 20 },
    { nodeId: "edge", weight: 10 },
    { nodeId: "direct", weight: 0 },
  ];
  const shares = new Map(weightedShares(input).map((n) => [n.nodeId, n.percent]));
  assert.equal(shares.get("cf-1"), 40);
  assert.equal(shares.get("cf-2"), 40);
  assert.equal(shares.get("edge"), 20);
  assert.equal(shares.get("direct"), 0);
  assert.equal(input[0].nodeId, "cf-1");
  const label = policyLabel({ nodes: input, version: 1 });
  assert.match(label, /40\.0%/);
  assert.match(label, /直连 不参与/);
  assert.ok(!label.includes("→"));
});

test("empty and all-zero previews have no allocation or NaN", () => {
  assert.deepEqual(weightedShares([]), []);
  const nodes = [{ nodeId: "direct", weight: 0 }];
  assert.equal(weightedShares(nodes)[0].percent, 0);
  assert.equal(policyLabel({ nodes, version: 0 }), "直连 不参与");
  assert.equal(policyLabel({ nodes: [], version: 0, inherit: true }), "使用 TG 默认节点");
});

test("positive direct weight participates in the same distribution", () => {
  const shares = weightedShares([
    { nodeId: "direct", weight: 10 },
    { nodeId: "proxy", weight: 30 },
  ]);
  assert.deepEqual(shares.map((n) => n.percent), [75, 25]);
});
