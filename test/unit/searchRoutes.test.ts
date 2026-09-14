import { createServer, type Server } from "node:http";
import { createApp, toNodeListener } from "h3";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

const { search, settings } = vi.hoisted(() => ({
  search: vi.fn(),
  settings: { channels: ["SystemChan"], plugins: ["nyaa"], concurrency: 4, pluginTimeoutMs: 5000, trashedPlugins: [] },
}));
vi.mock("../../server/core/services", () => ({ getOrCreateSearchService: () => ({ searchWithWarnings: search }) }));
vi.mock("../../server/core/services/searchSettingsService", () => ({ getSearchSettings: () => settings }));
vi.mock("../../server/utils/requireAuth", () => ({ requireSearchAuth: vi.fn() }));
import getRoute from "../../server/api/search.get";
import postRoute from "../../server/api/search.post";
let server: Server;
let base: string;
beforeAll(async () => {
  vi.stubGlobal("useRuntimeConfig", () => ({ defaultChannels: ["FallbackChan"] }));
  const app = createApp();
  app.use("/get", getRoute); app.use("/post", postRoute);
  server = createServer(toNodeListener(app));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllGlobals();
});
beforeEach(() => search.mockReset().mockResolvedValue({ response: { total: 0 }, warnings: [] }));
it.each(["GET", "POST"])("%s defaults merge user/system TG and include system plugins", async (method) => {
  const response = method === "GET" ? await fetch(`${base}/get?kw=test&channels=%40OwnChan`)
    : await fetch(`${base}/post`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ kw: "test", channels: ["@OwnChan"] }) });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await response.text()).toContain("event: complete");
  expect(search.mock.calls[0]![1]).toEqual(["systemchan", "ownchan"]);
  expect(search.mock.calls[0]![5]).toBe("all");
  expect(search.mock.calls[0]![6]).toEqual(["nyaa"]);
});
it.each(["GET", "POST"])("%s only mode cannot be broadened by src or plugin arguments", async (method) => {
  const response = method === "GET" ? await fetch(`${base}/get?kw=test&channels=ownchan&channels_mode=only&src=all&plugins=nyaa`)
    : await fetch(`${base}/post`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ kw: "test", channels: ["ownchan"], channels_mode: "only", src: "all", plugins: ["nyaa"] }) });
  expect(response.status).toBe(200);
  expect(search.mock.calls[0]![1]).toEqual(["ownchan"]);
  expect(search.mock.calls[0]![5]).toBe("tg");
  expect(search.mock.calls[0]![6]).toEqual([]);
});
it("flushes source results before search completion", async () => {
  let finishSearch!: () => void;
  let searchFinished = false;
  search.mockImplementationOnce((...args) => {
    const onSourceSuccess = args[9].onSourceSuccess;
    onSourceSuccess({
      source: { kind: "telegram", id: "firstchan" },
      request: { keyword: "test", phase: "shallow" },
      results: [],
    });
    return new Promise((resolve) => {
      finishSearch = () => {
        searchFinished = true;
        resolve({ response: { total: 0 }, warnings: [] });
      };
    });
  });

  const response = await fetch(`${base}/get?kw=test`);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let partial = "";
  while (!partial.includes("event: result")) {
    const chunk = await reader.read();
    expect(chunk.done).toBe(false);
    partial += decoder.decode(chunk.value, { stream: true });
  }
  expect(searchFinished).toBe(false);
  expect(partial).toContain('"id":"firstchan"');

  finishSearch();
  while (!(await reader.read()).done) { /* drain */ }
});

it("sends only unseen result deltas and a summary-only complete event", async () => {
  const result = (id: string, url: string) => ({
    message_id: id,
    unique_id: id,
    channel: "source",
    datetime: "2026-09-14T00:00:00.000Z",
    title: id,
    content: "",
    links: [{ type: "quark", url, password: "" }],
    source: "plugin" as const,
    pluginId: "plugin-one",
    pluginVersion: "1.0.0",
  });
  search.mockImplementationOnce((...args) => {
    const onSourceSuccess = args[9].onSourceSuccess;
    const first = result("first", "https://first");
    const second = result("second", "https://second");
    const third = result("third", "https://third");
    onSourceSuccess({
      source: { kind: "telegram", id: "firstchan" },
      request: { keyword: "test", phase: "shallow" },
      results: [first, second],
    });
    onSourceSuccess({
      source: { kind: "telegram", id: "firstchan" },
      request: { keyword: "test", phase: "deep" },
      results: [first, second],
    });
    onSourceSuccess({
      source: { kind: "plugin", id: "plugin-one", version: "1.0.0" },
      request: { keyword: "test", phase: "variant" },
      results: [first, second, third],
    });
    return Promise.resolve({
      response: {
        total: 3,
        results: [first, second, third],
        meta: { registryVersion: 7, pluginVersions: {} },
      },
      warnings: [],
    });
  });

  const response = await fetch(`${base}/get?kw=test`);
  const text = await response.text();
  const blocks = text.split(/\r?\n\r?\n/).filter(Boolean).map((block) => {
    const event = block.match(/^event: (.+)$/m)?.[1];
    const data = block.match(/^data: (.+)$/m)?.[1];
    return { event, data: data ? JSON.parse(data) : undefined };
  });
  const resultEvents = blocks.filter((item) => item.event === "result");
  expect(resultEvents).toHaveLength(3);
  expect(resultEvents[0]!.data.data.update.results.map((item: any) => item.unique_id)).toEqual(["first", "second"]);
  expect(resultEvents[1]!.data.data.update.results).toEqual([]);
  expect(resultEvents[2]!.data.data.update.results.map((item: any) => item.unique_id)).toEqual(["third"]);
  for (const event of resultEvents) {
    for (const item of event.data.data.update.results) {
      expect(item).not.toHaveProperty("source");
      expect(item).not.toHaveProperty("pluginId");
      expect(item).not.toHaveProperty("pluginVersion");
    }
  }

  const completeEvent = blocks.find((item) => item.event === "complete")!;
  expect(completeEvent.data.data).toEqual({ total: 3 });
  expect(completeEvent.data.data).not.toHaveProperty("results");
  expect(completeEvent.data.data).not.toHaveProperty("items");
});


it("returns SSE diagnostics when debug=1", async () => {
  const debugResult = {
    message_id: "debug",
    unique_id: "debug",
    channel: "source",
    datetime: "2026-09-14T00:00:00.000Z",
    title: "debug",
    content: "",
    links: [{ type: "quark", url: "https://debug", password: "" }],
    source: "plugin",
    pluginId: "plugin-one",
    pluginVersion: "1.0.0",
  };
  search.mockImplementationOnce((...args) => {
    args[9].onSourceSuccess({
      source: { kind: "plugin", id: "plugin-one", version: "1.0.0" },
      request: { keyword: "test", phase: "shallow" },
      results: [debugResult],
    });
    return Promise.resolve({
      response: { total: 1, meta: { registryVersion: 7, pluginVersions: { "plugin-one": "1.0.0" } } },
      warnings: [{ source: "plugin:other", message: "timeout" }],
    });
  });

  const text = await (await fetch(`${base}/get?kw=test&debug=1`)).text();
  const blocks = text.split(/\r?\n\r?\n/).filter(Boolean).map((block) => ({
    event: block.match(/^event: (.+)$/m)?.[1],
    data: JSON.parse(block.match(/^data: (.+)$/m)?.[1] || "null"),
  }));
  const resultEvent = blocks.find((item) => item.event === "result")!;
  expect(resultEvent.data.data.update.results[0]).toMatchObject({
    source: "plugin",
    pluginId: "plugin-one",
    pluginVersion: "1.0.0",
  });
  const completeEvent = blocks.find((item) => item.event === "complete")!;
  expect(completeEvent.data.data.meta).toEqual({ registryVersion: 7, pluginVersions: { "plugin-one": "1.0.0" } });
  expect(completeEvent.data.warnings).toEqual([{ source: "plugin:other", message: "timeout" }]);
});

it.each(["GET", "POST"])("%s only mode with no channels fails before scheduling", async (method) => {
  const response = method === "GET" ? await fetch(`${base}/get?kw=test&channels_mode=only`)
    : await fetch(`${base}/post`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ kw: "test", channels_mode: "only", channels: [] }) });
  expect(response.status).toBe(400);
  expect(search).not.toHaveBeenCalled();
});

it.each(["GET", "POST"])("%s forwards client disconnect to the search signal", async (method) => {
  let started!: () => void;
  let cancelled!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const aborted = new Promise<void>((resolve) => { cancelled = resolve; });
  search.mockImplementationOnce((...args) => new Promise((resolve) => {
    const signal: AbortSignal = args[9].signal;
    signal.addEventListener("abort", () => {
      cancelled();
      resolve({ response: { total: 0 }, warnings: [] });
    }, { once: true });
    started();
  }));
  const controller = new AbortController();
  const request = fetch(`${base}/${method === "GET" ? "get?kw=test" : "post"}`, {
    method, signal: controller.signal,
    ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ kw: "test" }) } : {}),
  });
  await ready;
  const response = await request;
  const body = response.text();
  controller.abort();
  await expect(body).rejects.toMatchObject({ name: "AbortError" });
  await aborted;
});
