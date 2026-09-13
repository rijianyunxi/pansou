import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SearchService, type SearchServiceOptions } from "../../server/core/services/searchService";
import { definePluginManifest, PluginManager, type PluginSearchContext, type SearchPlugin } from "../../server/core/plugins/manager";
import type { SearchResult } from "../../server/core/types/models";

const { tg } = vi.hoisted(() => ({ tg: vi.fn() }));
vi.mock("../../server/core/services/tg", () => ({ fetchTgChannelPosts: tg }));
vi.mock("../../server/core/services/searchSettingsService", () => ({ getSearchSettings: () => ({ trashedPlugins: [] }) }));

function results(id: string, count = 5): SearchResult[] {
  return Array.from({ length: count }, (_, i) => ({
    unique_id: `${id}-${i}`, message_id: `${id}-${i}`, channel: id,
    datetime: "2026-09-12T00:00:00.000Z", title: "test", content: "test",
    links: [{ type: "quark", url: `https://pan.quark.cn/s/${id}-${i}`, password: "" }],
  }));
}
function plugin(id: string, search: SearchPlugin["search"], priority = 1, group?: string): SearchPlugin {
  return { manifest: definePluginManifest({ id, name: id, priority, timeoutMs: 1000, upstreamGroup: group }), search };
}
function service(plugins: SearchPlugin[] = [], options: Partial<SearchServiceOptions> = {}) {
  const manager = new PluginManager();
  for (const source of plugins) manager.register(source);
  return new SearchService({
    priorityChannels: [], defaultChannels: [], defaultConcurrency: 2,
    pluginTimeoutMs: 3000, searchTimeoutMs: 100, cacheEnabled: false, cacheTtlMinutes: 1,
    ...options,
  }, manager);
}
function search(svc: SearchService, options: { channels?: string[]; signal?: AbortSignal; conc?: number; ext?: Record<string, unknown> } = {}) {
  return svc.searchWithWarnings("test", options.channels ?? [], options.conc, false, "results", "all", undefined, undefined, options.ext ?? {}, { signal: options.signal });
}

beforeEach(() => { vi.useFakeTimers(); tg.mockReset().mockResolvedValue([]); });
afterEach(() => { vi.useRealTimers(); });

it("bounds the whole search, aborts TG, skips queued/deep channels and preserves completed sources", async () => {
  let activeSignal: AbortSignal | undefined;
  tg.mockImplementation((channel, _keyword, options) => {
    if (channel === "fastchan") return Promise.resolve(results(channel));
    activeSignal = options.signal;
    return new Promise(() => {}); // deliberately ignores cancellation
  });
  const promise = search(service(), { channels: ["fastchan", "slowchan", "queuedchan"], conc: 1 });
  await vi.advanceTimersByTimeAsync(100);
  const result = await promise;
  expect(result.response.total).toBe(5);
  expect(result.warnings).toEqual([expect.objectContaining({ type: "timeout_error", source: "search" })]);
  expect(activeSignal?.aborted).toBe(true);
  expect(tg.mock.calls.map(([channel]) => channel)).toEqual(["fastchan", "slowchan"]);
  expect(vi.getTimerCount()).toBe(0);
});

it("shares the concurrency cap between TG and plugins and honors concurrency=1", async () => {
  let active = 0;
  let maximum = 0;
  const work = async (id: string) => {
    active++; maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    return results(id);
  };
  tg.mockImplementation((channel) => work(channel));
  const svc = service([plugin("one", () => work("one")), plugin("two", () => work("two"))], { searchTimeoutMs: 1000 });
  const promise = search(svc, { channels: ["firstchan", "secondchan"], conc: 1 });
  await vi.advanceTimersByTimeAsync(100);
  expect((await promise).response.total).toBe(20);
  expect(maximum).toBe(1);
});

it("aborts plugins without marking them unhealthy or running queued work/failover", async () => {
  let observed: AbortSignal | undefined;
  const first = vi.fn((context: PluginSearchContext) => {
    observed = context.signal;
    return new Promise<SearchResult[]>(() => {});
  });
  const fallback = vi.fn(async () => results("fallback"));
  const lower = vi.fn(async () => results("lower"));
  const svc = service([plugin("a-first", first, 2, "mirrors"), plugin("b-fallback", fallback, 2, "mirrors"), plugin("lower", lower)]);
  const controller = new AbortController();
  const promise = search(svc, { signal: controller.signal });
  const rejected = expect(promise).rejects.toThrow("cancelled");
  await vi.advanceTimersByTimeAsync(1);
  controller.abort(new Error("cancelled"));
  await rejected;
  expect(observed?.aborted).toBe(true);
  expect(fallback).not.toHaveBeenCalled();
  expect(lower).not.toHaveBeenCalled();
  expect(svc.getPluginHealthStatus().every((status) => status.failureCount === 0)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not start a pre-cancelled search", async () => {
  const loader = vi.fn(async () => []);
  const controller = new AbortController(); controller.abort();
  await expect(search(service([], { dynamicPluginLoader: loader }), { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(loader).not.toHaveBeenCalled(); expect(tg).not.toHaveBeenCalled();
});

it("bounds a stalled dynamic registry load", async () => {
  const loader = vi.fn(() => new Promise<SearchPlugin[]>(() => {}));
  const promise = search(service([], { dynamicPluginLoader: loader }));
  await vi.advanceTimersByTimeAsync(100);
  expect((await promise).warnings).toEqual([expect.objectContaining({ source: "search" })]);
  expect(vi.getTimerCount()).toBe(0);
});

it("records TG errors instead of silently returning success or retrying the failed channel deeply", async () => {
  tg.mockRejectedValue(new Error("network unavailable"));
  const response = await search(service(), { channels: ["brokenchan"] });
  expect(response.warnings).toEqual([expect.objectContaining({ source: "tg:brokenchan", type: "network_error" })]);
  expect(tg).toHaveBeenCalledTimes(1);
});

it("aborts a single TG source on its deadline and reports a channel warning", async () => {
  let observed: AbortSignal | undefined;
  tg.mockImplementation((_channel, _keyword, options) => {
    observed = options.signal;
    return new Promise(() => {});
  });
  const promise = search(service([], { searchTimeoutMs: 10_000 }), { channels: ["slowchan"] });
  await vi.advanceTimersByTimeAsync(3000);
  const response = await promise;
  expect(observed?.aborted).toBe(true);
  expect(response.warnings).toEqual([expect.objectContaining({ source: "tg:slowchan", type: "timeout_error" })]);
  expect(tg).toHaveBeenCalledTimes(1);
});

it("uses one budget across keyword variants and keeps results from completed variants", async () => {
  let count = 0;
  const source = plugin("variants", async () => {
    count++;
    if (count === 1) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return results("exact", 1);
    }
    return new Promise(() => {});
  });
  const svc = service([{ ...source, manifest: { ...source.manifest, timeoutMs: 50 } }]);
  const promise = svc.searchWithWarnings("a", [], 1, false, "results", "plugin", undefined, undefined, {});
  await vi.advanceTimersByTimeAsync(50);
  const response = await promise;
  expect(response.response.total).toBe(1);
  expect(response.warnings).toEqual([expect.objectContaining({ source: "variants", type: "timeout_error" })]);
  expect(count).toBe(2);
  expect(svc.getPluginHealthStatus()[0]?.failureCount).toBe(1);
});

it("does not cache partial TG results or hide their warnings on the next search", async () => {
  tg.mockImplementation((channel) => channel === "goodchan" ? Promise.resolve(results(channel)) : Promise.reject(new Error("network failure")));
  const svc = service([], { cacheEnabled: true });
  const first = await search(svc, { channels: ["goodchan", "badchan"] });
  const second = await search(svc, { channels: ["goodchan", "badchan"] });
  expect(first.response.total).toBe(5); expect(second.response.total).toBe(5);
  expect(second.warnings).toHaveLength(1);
  expect(tg).toHaveBeenCalledTimes(4);
});

it("does not cache partial plugin results", async () => {
  const good = vi.fn(async () => results("good"));
  const bad = vi.fn(async () => { throw new Error("network failure"); });
  const svc = service([plugin("good", good), plugin("bad", bad)], { cacheEnabled: true });
  await search(svc);
  const second = await search(svc);
  expect(second.warnings).toHaveLength(1);
  expect(good).toHaveBeenCalledTimes(2); expect(bad).toHaveBeenCalledTimes(2);
});

it("does not reuse plugin cache across caller-specific extension parameters", async () => {
  const source = vi.fn(async (context: PluginSearchContext) => results(String(context.ext.tenant)));
  const svc = service([plugin("scoped", source)], { cacheEnabled: true });
  const first = await search(svc, { ext: { tenant: "alice" } });
  const second = await search(svc, { ext: { tenant: "bob" } });
  expect((first.response.results?.[0] as SearchResult | undefined)?.unique_id).toBe("alice-0");
  expect((second.response.results?.[0] as SearchResult | undefined)?.unique_id).toBe("bob-0");
  expect(source).toHaveBeenCalledTimes(2);
});

it("still caches complete searches without custom extension parameters", async () => {
  const source = vi.fn(async () => results("complete"));
  const svc = service([plugin("complete", source)], { cacheEnabled: true });
  await search(svc); await search(svc);
  expect(source).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("warns on an open circuit and releases recovery probes cancelled by the caller", async () => {
  const source = vi.fn(async (): Promise<SearchResult[]> => { throw new Error("network failure"); });
  const svc = service([plugin("recovering", source)]);
  for (let i = 0; i < 5; i++) await search(svc);
  const skipped = await search(svc);
  expect(skipped.warnings[0]?.message).toContain("熔断");
  expect(source).toHaveBeenCalledTimes(5);
  await vi.advanceTimersByTimeAsync(300_001);
  source.mockImplementation(() => new Promise(() => {}));
  const controller = new AbortController();
  const pending = search(svc, { signal: controller.signal });
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(1);
  controller.abort(); await rejected;
  source.mockResolvedValue(results("recovered"));
  expect((await search(svc)).response.total).toBe(5);
  expect(svc.getPluginHealthStatus()[0]?.circuitState).toBe("closed");
});
