import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const read = (name) => readFile(new URL("../" + name, import.meta.url), "utf8");
test("crawl main only mounts one tab and one primary overlay", async () => {
  const page = await read("pages/admin/crawl.vue");
  assert.match(page, /CrawlChannelsTab/);
  assert.match(page, /CrawlJobsTab/);
  assert.match(page, /CrawlReviewTab/);
  assert.ok(!page.includes("最近 50 条消息"));
  assert.ok(!page.includes("JSON.stringify(previewData"));
  assert.match(page, /v-else-if="messageChannel"/);
});
test("messages use same sheet navigation and safe original text", async () => {
  const sheet = await read("components/admin/crawl/CrawlMessagesSheet.vue");
  const detail = await read("components/admin/crawl/CrawlMessageDetail.vue");
  assert.match(sheet, /AdminDialog/);
  assert.match(sheet, /drawer/);
  assert.match(sheet, /scrollRegion/);
  assert.match(detail, /返回消息列表/);
  assert.ok(!detail.includes("v-html"));
  assert.match(detail, /尚未写入/);
  assert.ok(detail.includes("/preview"));
});
test("policies are owned by source or channel and use shared editor", async () => {
  for (const file of [
    "components/sources/SourceEditor.vue",
    "components/admin/crawl/CrawlChannelEditor.vue",
    "components/admin/crawl/CrawlSettings.vue",
  ]) {
    assert.match(await read(file), /OutboundPolicyEditor/);
  }
  const node = await read("components/admin/ProxyNodesPage.vue");
  assert.ok(!node.includes("新增策略"));
  assert.ok(!node.includes("sourceIds"));
});
test("polling clears timers, aborts stale requests and stops on authentication failure", async () => {
  const query = await read("composables/admin/useCrawlQuery.ts");
  assert.match(query, /controller\?\.abort/);
  assert.match(query, /id\s*!==\s*seq/);
  assert.match(query, /401,\s*403/);
  assert.match(query, /clearInterval/);
  assert.match(query, /document.hidden/);
});
test("new crawl forms keep action footers outside scrollable fields", async () => {
  for (const name of [
    "CrawlChannelEditor",
    "CrawlSettings",
    "CrawlJobDialog",
  ]) {
    const file = await read("components/admin/crawl/" + name + ".vue");
    assert.match(file, /admin-dialog-form/);
    assert.match(file, /admin-form-fields/);
    assert.match(file, /modal-actions/);
    assert.match(file, /role="alert"/);
  }
});

test("default settings keep separate dirty baselines and load failure blocks saves", async () => {
  const settings = await read("components/admin/crawl/CrawlSettings.vue");
  assert.match(settings, /baselinePolicy/);
  assert.match(settings, /baselineTransform/);
  assert.match(settings, /templateVersion/);
  assert.match(settings, /!loaded/);
  assert.match(
    await read("components/admin/crawl/CrawlChannelEditor.vue"),
    /!loaded/,
  );
});
test("durable enqueue key and timezone date filters are wired to shadcn forms", async () => {
  assert.match(
    await read("components/admin/crawl/CrawlJobDialog.vue"),
    /requestKey/,
  );
  for (const file of ["CrawlJobsTab", "CrawlMessagesSheet"]) {
    const text = await read("components/admin/crawl/" + file + ".vue");
    assert.match(text, /datetime-local/);
    assert.match(text, /crawlFilterDate/);
  }
  assert.ok(
    (await read("components/admin/crawl/CrawlMessageDetail.vue")).includes(
      "rawText",
    ),
  );
});

test("node selection exposes only checkboxes and weights, including direct", async () => {
  const editor = await read("components/admin/OutboundPolicyEditor.vue");
  assert.match(editor, /AdminCheckbox/);
  assert.match(editor, /sortedNodes/);
  assert.match(editor, /权重越大越优先/);
  for (const removed of [
    "maxAttempts",
    "unavailableFallback",
    "replaySafe",
    "加权随机",
    "上移",
    "下移",
    "AdminSelect",
  ]) {
    assert.ok(!editor.includes(removed), removed);
  }
  assert.match(editor, /min="0"/);
});
test("priority order is deterministic and preserves input arrays", async () => {
  const { sortedNodes, directPolicy } = await import("../types/outbound.ts");
  const input = [
    { nodeId: "a", weight: 20 },
    { nodeId: "direct", weight: 0 },
    { nodeId: "z", weight: 20 },
    { nodeId: "top", weight: 100 },
  ];
  assert.deepEqual(
    sortedNodes(input).map((n) => n.nodeId),
    ["top", "z", "a", "direct"],
  );
  assert.equal(input[0].nodeId, "a");
  assert.equal(directPolicy().nodes[0].nodeId, "direct");
});
test("built-in direct node has no management mutation menu", async () => {
  assert.match(
    await read("components/admin/ProxyNodesPage.vue"),
    /n.kind !== 'direct'/,
  );
});

test("admin resource search advertises name-only matching",async()=>{const page=await read("components/admin/AdminResourcesPage.vue");assert.match(page,/仅按资源名称查询/);assert.ok(!page.includes("按名称、描述或标签查询"));});
