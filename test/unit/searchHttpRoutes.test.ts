import { createServer, type Server } from "node:http";
import { createApp, toNodeListener } from "h3";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

const { search, settings } = vi.hoisted(() => ({
  search: vi.fn(),
  settings: { channels: ["SystemChan"], plugins: ["nyaa"], concurrency: 4, pluginTimeoutMs: 5000, trashedPlugins: [] },
}));

vi.mock("../../server/core/services", () => ({
  getOrCreateSearchService: () => ({ searchWithWarnings: search }),
}));
vi.mock("../../server/core/services/searchSettingsService", () => ({ getSearchSettings: () => settings }));
vi.mock("../../server/utils/requireAuth", () => ({ requireSearchAuth: vi.fn() }));

import getRoute from "../../server/api/searchHttp.get";
import postRoute from "../../server/api/searchHttp.post";

let server: Server;
let base: string;

beforeAll(async () => {
  vi.stubGlobal("useRuntimeConfig", () => ({ defaultChannels: ["FallbackChan"] }));
  const app = createApp();
  app.use("/get", getRoute);
  app.use("/post", postRoute);
  server = createServer(toNodeListener(app));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllGlobals();
});

beforeEach(() => {
  search.mockReset().mockResolvedValue({
    response: {
      total: 1,
      meta: { registryVersion: 7, pluginVersions: { nyaa: "1.0.0" } },
      results: [{
        url: "https://example.test/file",
        password: "",
        note: "test",
        datetime: "2026-09-14T00:00:00.000Z",
        source: "plugin:nyaa@1.0.0",
        pluginId: "nyaa",
        pluginVersion: "1.0.0",
      }],
    },
    warnings: [],
  });
});

it.each(["GET", "POST"])("%s returns the completed search as JSON instead of SSE", async (method) => {
  const response = method === "GET"
    ? await fetch(`${base}/get?kw=test&channels=%40OwnChan`)
    : await fetch(`${base}/post`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kw: "test", channels: ["@OwnChan"] }),
      });

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(response.headers.get("content-type")).not.toContain("text/event-stream");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await response.json()).toEqual({
    code: 0,
    message: "success",
    data: {
      total: 1,
      results: [{ url: "https://example.test/file", password: "", note: "test", datetime: "2026-09-14T00:00:00.000Z" }],
    },
  });
  expect(search.mock.calls[0]![1]).toEqual(["systemchan", "ownchan"]);
});

it("hides partial-success warnings by default", async () => {
  search.mockResolvedValueOnce({
    response: { total: 0 },
    warnings: [{ source: "plugin:test", message: "timeout" }],
  });

  const response = await fetch(`${base}/get?kw=test`);
  expect(await response.json()).toEqual({
    code: 0,
    message: "partial_success",
    data: { total: 0 },
  });
});

it("returns diagnostics when debug=1", async () => {
  search.mockResolvedValueOnce({
    response: {
      total: 1,
      meta: { registryVersion: 7, pluginVersions: { test: "1.2.3" } },
      results: [{
        url: "https://example.test/debug",
        password: "",
        note: "debug",
        datetime: "2026-09-14T00:00:00.000Z",
        source: "plugin:test@1.2.3",
        pluginId: "test",
        pluginVersion: "1.2.3",
      }],
    },
    warnings: [{ source: "plugin:other", message: "timeout" }],
  });

  const response = await fetch(`${base}/get?kw=test&debug=1`);
  expect(await response.json()).toEqual({
    code: 0,
    message: "partial_success",
    data: {
      total: 1,
      meta: { registryVersion: 7, pluginVersions: { test: "1.2.3" } },
      results: [{
        url: "https://example.test/debug",
        password: "",
        note: "debug",
        datetime: "2026-09-14T00:00:00.000Z",
        source: "plugin:test@1.2.3",
        pluginId: "test",
        pluginVersion: "1.2.3",
      }],
    },
    warnings: [{ source: "plugin:other", message: "timeout" }],
  });
});
