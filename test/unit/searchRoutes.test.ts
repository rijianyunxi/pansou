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
it("streams successful sources before the final complete event", async () => {
  search.mockImplementationOnce((...args) => {
    const onSourceSuccess = args[9].onSourceSuccess;
    onSourceSuccess({
      source: { kind: "telegram", id: "firstchan" },
      request: { keyword: "test", phase: "shallow" },
      results: [],
    });
    return new Promise((resolve) => setTimeout(() => {
      onSourceSuccess({
        source: { kind: "plugin", id: "plugin-one", version: "1.0.0" },
        request: { keyword: "test", phase: "variant" },
        results: [],
      });
      resolve({ response: { total: 0, results: [] }, warnings: [] });
    }, 10));
  });
  const response = await fetch(`${base}/get?kw=test`);
  const text = await response.text();
  const eventNames = [...text.matchAll(/^event: (.+)$/gm)].map((match) => match[1]);
  expect(eventNames).toEqual(["start", "result", "result", "complete"]);
  expect(text).toContain('"id":"firstchan"');
  expect(text).toContain('"id":"plugin-one"');
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
