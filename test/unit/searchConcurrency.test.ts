import { createServer, type Server } from "node:http";
import { createApp, toNodeListener } from "h3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { search, settings } = vi.hoisted(() => ({
  search: vi.fn(),
  settings: { channels: ["SystemChan"], plugins: ["nyaa"], concurrency: 4, pluginTimeoutMs: 5000, trashedPlugins: [] },
}));
vi.mock("../../server/core/services", () => ({
  getOrCreateSearchService: () => ({
    searchWithWarnings: search,
    getPluginManager: () => ({ snapshot: () => ({ version: 1, plugins: [] }) }),
    getPluginHealthStatus: () => [],
  }),
}));
vi.mock("../../server/core/services/searchSettingsService", () => ({ getSearchSettings: () => settings }));
vi.mock("../../server/utils/requireAuth", () => ({ requireSearchAuth: vi.fn() }));
import getRoute from "../../server/api/search.get";
import postRoute from "../../server/api/search.post";
import healthRoute from "../../server/api/health.get";
import {
  SEARCH_GOVERNANCE_LIMITS,
  SearchGovernor,
  searchGovernor,
  type SearchGovernanceLimits,
  type SearchLease,
} from "../../server/core/security/concurrency";

function admit(governor: SearchGovernor, key: string, limits: SearchGovernanceLimits, now = 0): SearchLease {
  const decision = governor.tryBegin(key, limits, now);
  if (!decision.allowed) throw new Error(`unexpected rejection: ${decision.reason}`);
  return decision.lease;
}

describe("SearchGovernor", () => {
  // Fixed clock: every call in these tests must share one rate window.
  const NOW = 1_000;
  const limits = (): SearchGovernanceLimits => ({ ...SEARCH_GOVERNANCE_LIMITS, perClientInFlight: 2, perClientWindowLimit: 3, globalInFlight: 3 });

  it("admits up to the per-client in-flight cap and rejects beyond it with 429", () => {
    const governor = new SearchGovernor();
    const first = admit(governor, "c1", limits(), NOW);
    admit(governor, "c1", limits(), NOW);
    expect(governor.clientInFlight("c1")).toBe(2);
    expect(governor.tryBegin("c1", limits(), NOW)).toMatchObject({ allowed: false, reason: "client_concurrency", statusCode: 429 });
    first.release();
    expect(governor.tryBegin("c1", limits(), NOW).allowed).toBe(true);
  });

  it("treats lease release as idempotent so aborts cannot leak or go negative", () => {
    const governor = new SearchGovernor();
    const lease = admit(governor, "c1", limits(), NOW);
    lease.release();
    lease.release();
    expect(governor.clientInFlight("c1")).toBe(0);
    expect(governor.totalInFlight()).toBe(0);
  });

  it("returns 503 global_capacity for other clients once the instance cap is reached", () => {
    const governor = new SearchGovernor();
    const leases = ["a", "b", "c"].map((key) => admit(governor, key, limits(), NOW));
    expect(governor.tryBegin("d", limits(), NOW)).toMatchObject({ allowed: false, reason: "global_capacity", statusCode: 503 });
    leases[0]!.release();
    expect(governor.tryBegin("d", limits(), NOW).allowed).toBe(true);
  });

  it("rejects with 429 and the remaining window when the rate budget is spent", () => {
    const governor = new SearchGovernor();
    const rateLimits: SearchGovernanceLimits = { ...SEARCH_GOVERNANCE_LIMITS, perClientInFlight: 10, perClientWindowLimit: 2, perClientWindowMs: 30_000 };
    admit(governor, "c1", rateLimits, 1_000).release();
    admit(governor, "c1", rateLimits, 2_000).release();
    expect(governor.tryBegin("c1", rateLimits, 21_000)).toMatchObject({
      allowed: false, reason: "client_rate_limited", statusCode: 429, retryAfterSeconds: 10,
    });
    expect(governor.tryBegin("c1", rateLimits, 31_000).allowed).toBe(true);
  });

  it("does not burn rate tokens for requests rejected by concurrency", () => {
    const governor = new SearchGovernor();
    const tight: SearchGovernanceLimits = { ...SEARCH_GOVERNANCE_LIMITS, perClientInFlight: 1, perClientWindowLimit: 3 };
    const held = admit(governor, "c1", tight, NOW);
    expect(governor.tryBegin("c1", tight, NOW)).toMatchObject({ allowed: false, reason: "client_concurrency" });
    held.release();
    admit(governor, "c1", tight, NOW).release();
    admit(governor, "c1", tight, NOW).release();
    expect(governor.tryBegin("c1", tight, NOW)).toMatchObject({ allowed: false, reason: "client_rate_limited" });
  });
});

describe("search route governance", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    vi.stubGlobal("useRuntimeConfig", () => ({ defaultChannels: ["FallbackChan"] }));
    const app = createApp();
    app.use("/search/get", getRoute);
    app.use("/search/post", postRoute);
    app.use("/health", healthRoute);
    server = createServer(toNodeListener(app));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllGlobals();
  });
  beforeEach(async () => {
    await vi.waitFor(() => expect(searchGovernor.totalInFlight()).toBe(0));
    searchGovernor.reset();
    search.mockReset().mockResolvedValue({ response: { total: 0 }, warnings: [] });
  });

  const getSearch = () => fetch(`${base}/search/get?kw=test`);
  const postSearch = () => fetch(`${base}/search/post`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kw: "test" }),
  });
  const waitUntilAdmitted = async (count: number) => {
    while (search.mock.calls.length < count) await new Promise((resolve) => setTimeout(resolve, 5));
  };

  it("returns 429 with Retry-After when one client exceeds the in-flight cap", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    search.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    const pending = [getSearch(), postSearch(), getSearch()];
    await waitUntilAdmitted(3);
    const rejected = await getSearch();
    expect(rejected.status).toBe(429);
    expect(Number(rejected.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await rejected.text()).toContain("too many concurrent searches");
    resolvers.forEach((resolve) => resolve({ response: { total: 0 }, warnings: [] }));
    const responses = await Promise.all(pending);
    await Promise.all(responses.map((response) => response.text()));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
  });

  it("releases the in-flight slot when a client disconnects mid-search", async () => {
    search.mockImplementationOnce((...args) => new Promise((resolve) => {
      const signal: AbortSignal = args[9].signal;
      signal.addEventListener("abort", () => resolve({ response: { total: 0 }, warnings: [] }), { once: true });
    }));
    const controller = new AbortController();
    const request = fetch(`${base}/search/get?kw=test`, { signal: controller.signal });
    await waitUntilAdmitted(1);
    const response = await request;
    const body = response.text();
    controller.abort();
    await expect(body).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(searchGovernor.totalInFlight()).toBe(0));
    let next!: Response;
    for (let attempt = 0; attempt < 50; attempt++) {
      next = await getSearch();
      if (next.status === 200) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(next.status).toBe(200);
    await next.text();
    // The aborted search and this fresh search each consumed one rate token;
    // the intermediate concurrency 429s were free.
    expect(next.headers.get("x-ratelimit-remaining")).toBe("28");
  });

  it("does not throttle ops endpoints while searches are saturated", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    search.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    const pending = [getSearch(), getSearch(), getSearch()];
    await waitUntilAdmitted(3);
    expect((await getSearch()).status).toBe(429);
    expect((await fetch(`${base}/health`)).status).toBe(200);
    resolvers.forEach((resolve) => resolve({ response: { total: 0 }, warnings: [] }));
    const responses = await Promise.all(pending);
    await Promise.all(responses.map((response) => response.text()));
  });

  it("rate-limits a client after 30 admitted searches within the window", async () => {
    for (let i = 0; i < SEARCH_GOVERNANCE_LIMITS.perClientWindowLimit; i++) {
      const response = await getSearch();
      expect(response.status).toBe(200);
      await response.text();
    }
    const rejected = await getSearch();
    expect(rejected.status).toBe(429);
    const retryAfter = Number(rejected.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(30);
    expect(await rejected.text()).toContain("too many search requests");
  });
});
