import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const read = (name) => readFile(new URL("../" + name, import.meta.url), "utf8");
test("crawl main only mounts one tab and one primary overlay", async () => {
  const page = await read("pages/admin/crawl.vue");
  assert.match(page, /CrawlChannelsTab/);
  assert.ok(!page.includes("CrawlJobsTab"));
  assert.ok(!page.includes("CrawlReviewTab"));
  assert.ok(!page.includes("最近 50 条消息"));
  assert.ok(!page.includes("JSON.stringify(previewData"));
  assert.match(page, /v-else-if="messageChannel"/);
});
test("messages retain sheet navigation and stored resources without original or preview", async () => {
  const sheet = await read("components/admin/crawl/CrawlMessagesSheet.vue");
  const detail = await read("components/admin/crawl/CrawlMessageDetail.vue");
  assert.match(sheet, /AdminDialog/);
  assert.match(sheet, /drawer/);
  assert.match(sheet, /scrollRegion/);
  assert.match(detail, /返回消息列表/);
  assert.ok(!detail.includes("v-html"));
  assert.match(detail, /CrawlResultCards/);
  assert.match(detail, /这条消息没有已存资源/);
  assert.match(detail, /role="alert"/);
  for (const removed of ["/preview", "rawHtml", "rawText", "Textarea", "TabsTrigger", "规则预览"]) {
    assert.ok(!detail.includes(removed), removed);
  }
  assert.ok(!sheet.includes("m.summary"));
  const types = await read("types/crawl.ts");
  for (const removed of ["ParsePreview", "rawHtml", "rawText", "summary:"]) {
    assert.ok(!types.includes(removed), removed);
  }
});
test("message preview fixture is read-only and cannot forward real API requests", async () => {
  const fixture = await read("tests/fixtures/crawl-messages-preview.html");
  assert.match(fixture, /CrawlMessagesSheet/);
  assert.match(fixture, /window.fetch = async/);
  assert.match(fixture, /options.method !== 'GET'/);
  assert.match(fixture, /验收页禁止真实请求/);
  assert.match(fixture, /scenario === 'empty'/);
  assert.match(fixture, /scenario === 'error'/);
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
  for (const file of ["CrawlMessagesSheet"]) {
    const text = await read("components/admin/crawl/" + file + ".vue");
    assert.match(text, /datetime-local/);
    assert.match(text, /crawlFilterDate/);
  }
  assert.match(await read("components/admin/crawl/CrawlMessageDetail.vue"), /crawlTime\(data.publishedAt\)/);
});

test("node selection exposes only checkboxes and weights, including direct", async () => {
  const editor = await read("components/admin/OutboundPolicyEditor.vue");
  assert.match(editor, /AdminCheckbox/);
  assert.match(editor, /weightedShares/);
  assert.match(editor, /加权随机/);
  assert.match(editor, /权重 0 完全不参与/);
  assert.match(editor, /配置占比/);
  assert.ok(!editor.includes("尝试顺序"));
  for (const removed of [
    "maxAttempts",
    "unavailableFallback",
    "replaySafe",
    "上移",
    "下移",
    "AdminSelect",
  ]) {
    assert.ok(!editor.includes(removed), removed);
  }
  assert.match(editor, /min="0"/);
});
test("display order is deterministic, not a request attempt order", async () => {
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

test("channel list owns tasks and failed-page bulk operations without public bindings",async()=>{
 const channels=await read("components/admin/crawl/CrawlChannelsTab.vue");
 assert.match(channels,/CrawlChannelActivity/);assert.match(channels,/aria-expanded/);
 const editor=await read("components/admin/crawl/CrawlChannelEditor.vue");
 for(const removed of ["公共搜索身份","bindings","publish","intervalSeconds"]) assert.ok(!editor.includes(removed));
 const activity=await read("components/admin/crawl/CrawlChannelActivity.vue");
 assert.match(activity,/一键重试/);assert.match(activity,/一键忽略/);assert.match(activity,/ids:selected.value/);
 const settings=await read("components/admin/crawl/CrawlSettings.vue");
 for(const key of ["concurrentChannels","pageDelaySeconds","dailyIntervalSeconds"]) assert.match(settings,new RegExp(key));
});

test("channel task states keep distinct tones and paused overrides stale job errors", async () => {
 const {channelTaskState}=await import("../types/crawl.ts");
 const now=Date.parse("2026-10-01T00:00:00Z");
 const channel={enabled:true,historyComplete:true,latestJob:null};
 assert.deepEqual(channelTaskState(channel,now),{state:"idle",text:"等待日常采集"});
 assert.deepEqual(channelTaskState({...channel,historyComplete:false},now),{state:"waiting",text:"等待历史补齐"});
 for(const [status,state] of [["running","running"],["failed","failed"],["paused","paused"]]) {
  assert.equal(channelTaskState({...channel,latestJob:{status,kind:"backfill"}},now).state,state);
 }
 assert.deepEqual(channelTaskState({...channel,enabled:false,latestJob:{status:"failed"}},now),{state:"paused",text:"已暂停"});
 const queued={status:"queued",attempts:0,nextRunAt:"2026-10-01T00:00:01Z"};
 assert.deepEqual(channelTaskState({...channel,latestJob:queued},now),{state:"waiting",text:"等待下一页"});
 assert.equal(channelTaskState({...channel,latestJob:{...queued,attempts:1}},now).text,"退避等待");
 assert.equal(channelTaskState({...channel,latestJob:{...queued,nextRunAt:"2026-09-30T23:59:59Z"}},now).text,"等待执行");
 const source=await read("components/admin/crawl/CrawlChannelsTab.vue");
 for(const state of ["running","waiting","idle","paused","failed"]) assert.match(source,new RegExp("\\.state-"+state+"\\{"));
 assert.match(source,/aria-hidden="true"/);
});

test("channel labels distinguish normal page waiting, capacity queue and error backoff", async () => {
 const {channelTaskState,compactChannelTaskLabel}=await import("../types/crawl.ts");
 const base={enabled:true,historyComplete:false,taskState:"running",taskPhase:"page_wait",taskStateAt:"2026-10-01T00:00:00Z",nextPageAt:"2026-10-01T00:00:01Z",latestJob:{status:"queued",attempts:0,kind:"backfill",nextRunAt:"2026-09-30T23:59:59Z"}};
 assert.equal(compactChannelTaskLabel(base),"采集中");
 assert.match(channelTaskState(base,Date.parse("2026-10-01T01:00:00Z")).text,/等待下一页/);
 assert.equal(compactChannelTaskLabel({...base,taskState:"queued",taskPhase:"queued"}),"排队中");
 assert.equal(channelTaskState({...base,taskState:"queued",taskPhase:"queued"}).text,"等待并发槽位");
 assert.equal(compactChannelTaskLabel({...base,taskState:"backoff",latestJob:{...base.latestJob,attempts:2}}),"退避中");
 assert.equal(channelTaskState({...base,taskState:"backoff",latestJob:{...base.latestJob,attempts:2}}).text,"退避等待");
 assert.equal(compactChannelTaskLabel({...base,taskState:"running",latestJob:{...base.latestJob,status:"running"}}),"采集中");
 assert.equal(compactChannelTaskLabel({...base,taskState:"paused",enabled:false}),"已暂停");
});

test("task state text has readable contrast in both badge palettes", async () => {
 const source=await read("components/admin/crawl/CrawlChannelsTab.vue");
 const luminance=(hex)=>{
  const rgb=hex.match(/\w\w/g).map(v=>parseInt(v,16)/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4);
  return rgb[0]*0.2126+rgb[1]*0.7152+rgb[2]*0.0722;
 };
 const palettes=[...source.matchAll(/--state-fg:#([a-f\d]{6});--state-bg:#([a-f\d]{6})/g)];
 assert.equal(palettes.length,10);
 for(const [,fg,bg] of palettes){
  const a=luminance(fg),b=luminance(bg);
  assert.ok((Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)>=4.5,fg+" on "+bg);
 }
});

test("compact crawl times retain dates outside today in Shanghai", async () => {
 const {crawlCompactTime,compactChannelTaskLabel}=await import("../types/crawl.ts");
 const now=Date.parse("2026-10-01T02:00:00Z");
 assert.equal(crawlCompactTime("2026-10-01T02:01:53Z",now),"10:01");
 assert.equal(crawlCompactTime("2026-09-30T17:02:00Z",now),"01:02");
 assert.equal(crawlCompactTime("2026-09-30T15:02:00Z",now),"09-30 23:02");
 assert.equal(crawlCompactTime("2025-09-30T15:02:00Z",now),"2025-09-30 23:02");
 assert.equal(crawlCompactTime(null,now),"—");assert.equal(crawlCompactTime("invalid",now),"—");
 assert.equal(compactChannelTaskLabel({enabled:true,historyComplete:true,latestJob:null}),"待同步");
 assert.equal(compactChannelTaskLabel({enabled:true,latestJob:{status:"running",kind:"backfill"}}),"采集中");
});

test("compact channel columns preserve exact counts and accessible full information",async()=>{
 const source=await read("components/admin/crawl/CrawlChannelsTab.vue");
 assert.ok(!source.includes("已处理 {{c.historyPages}} 页 · 无总页数上限"));
 assert.ok(!source.includes("最近：{{"));assert.ok(!source.includes("下次：{{"));
 for(const icon of ["History","Timer","MessageSquare","Files","ListChecks"]) assert.ok(source.includes(icon));
 for(const count of ["historyPages","messageCount","resourceCount","failureCount"]) assert.ok(source.includes(count+".toLocaleString('zh-CN')"));
 assert.match(source,/CrawlHint/);assert.match(source,/tabindex="0"/);assert.match(source,/emit\('messages',c.id\)/);
 const hint=await read("components/admin/crawl/CrawlHint.vue");assert.match(hint,/TooltipTrigger as-child :aria-label="label"/);assert.match(hint,/TooltipContent/);
});
