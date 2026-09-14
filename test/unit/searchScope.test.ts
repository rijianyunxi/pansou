import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseSearchRequest } from "../../server/utils/searchRequest";
import { resolveSearchDefaults } from "../../server/utils/searchDefaults";
import { SearchService } from "../../server/core/services/searchService";
import { PluginManager } from "../../server/core/plugins/manager";
import type { SearchSettings } from "../../server/core/services/searchSettingsService";

const defaults: SearchSettings = { channels: null, plugins: null, concurrency: 4, pluginTimeoutMs: 5000, trashedPlugins: [] };
const runtime = { defaultChannels: ["SystemChan", "shared_chan"] };
function resolve(raw: unknown, settings = defaults) {
  const req = parseSearchRequest(raw);
  return resolveSearchDefaults({ ...req, channelsMode: req.channels_mode }, settings, runtime);
}
describe("search scope contract", () => {
  it("defaults to system channels and enabled plugins, accepts zero user channels", () => {
    expect(resolve({ kw: "test", channels: [] })).toMatchObject({ channels: ["systemchan", "shared_chan"], src: "all", plugins: undefined });
  });
  it("appends, trims and deduplicates case-insensitively", () => {
    expect(resolve({ kw: "test", channels: [" @SHARED_CHAN ", "OwnChan", "ownchan"] }).channels).toEqual(["systemchan", "shared_chan", "ownchan"]);
  });
  it("only overrides conflicting src/plugins and never includes system channels", () => {
    expect(resolve({ kw: "test", channels_mode: "only", src: "plugin", plugins: ["nyaa"], channels: ["@OwnChan"] }))
      .toMatchObject({ channels: ["ownchan"], src: "tg", plugins: [] });
  });
  it("GET and POST have identical normalized scope", () => {
    expect(resolve({ kw: "test", channels: "@OwnChan,shared_chan", channels_mode: "only", conc: "2", refresh: "false" }))
      .toEqual(resolve({ kw: "test", channels: ["@OwnChan", "shared_chan"], channels_mode: "only", conc: 2, refresh: false }));
  });
  it("enables response diagnostics only for debug=1", () => {
    expect(parseSearchRequest({ kw: "test" }).debug).toBe(false);
    expect(parseSearchRequest({ kw: "test", debug: "1" }).debug).toBe(true);
    expect(parseSearchRequest({ kw: "test", debug: 1 }).debug).toBe(true);
    expect(parseSearchRequest({ kw: "test", debug: true }).debug).toBe(false);
  });
  it("honors explicit admin empty arrays and plugin-only API requests", () => {
    expect(resolve({ kw: "test" }, { ...defaults, channels: [], plugins: [] })).toMatchObject({ channels: [], plugins: [] });
    expect(resolve({ kw: "test", src: "plugin", channels: ["ownchan"] }).channels).toEqual([]);
    expect(resolve({ kw: "test", channels: ["ownchan"] }, { ...defaults, channels: [] }).channels).toEqual(["ownchan"]);
  });
  it("reads each settings snapshot rather than freezing defaults", () => {
    expect(resolve({ kw: "test" }, { ...defaults, channels: ["ChangedChan"], plugins: ["nyaa"] })).toMatchObject({ channels: ["changedchan"], plugins: ["nyaa"] });
  });
  it.each([
    { kw: 123 }, { kw: "x".repeat(101) }, { kw: " " }, { kw: "test", src: "typo" },
    { kw: "test", channels_mode: "only" }, { kw: "test", channels_mode: "only", channels: [] },
    { kw: "test", channels: ["https://t.me/test"] }, { kw: "test", channels: ["../admin"] },
    { kw: "test", channels: [123] }, { kw: "test", channels: Array(51).fill("testchan") },
    { kw: "test", conc: 100 }, { kw: "test", conc: "3x" }, { kw: "test", ext: [] },
    { kw: "test", refresh: "invalid" }, { kw: "test", channels_mode: "typo" },
    { kw: "test", ext: { __plugin_timeout_ms: 999999 } },
  ])("rejects malformed/dangerous input with 400: %j", (input) => {
    expect(() => parseSearchRequest(input)).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
});

describe("service scope regression", () => {
  let service: SearchService;
  beforeEach(() => {
    service = new SearchService({ priorityChannels: [], defaultChannels: ["systemchan"], defaultConcurrency: 2,
      pluginTimeoutMs: 5000, cacheEnabled: false, cacheTtlMinutes: 1 }, new PluginManager());
  });
  it("explicit [] TG channels never expand to defaults", async () => {
    const tg = vi.spyOn(service as any, "searchTG").mockResolvedValue([]);
    await service.search("test", [], 1, false, "results", "tg", [], undefined, {});
    expect(tg.mock.calls[0]![1]).toEqual([]);
  });
  it("user-only scope never schedules plugin search", async () => {
    const tg = vi.spyOn(service as any, "searchTG").mockResolvedValue([]);
    const plugins = vi.spyOn(service as any, "searchPlugins");
    const effective = resolve({ kw: "test", channels_mode: "only", channels: ["ownchan"] });
    await service.search("test", effective.channels, 1, false, "results", effective.src, effective.plugins, undefined, {});
    expect(tg.mock.calls[0]![1]).toEqual(["ownchan"]);
    expect(plugins).not.toHaveBeenCalled();
  });
  it("explicit [] plugins never selects all registered plugins", async () => {
    const pm = service.getPluginManager();
    const search = vi.fn().mockResolvedValue([]);
    pm.register({ manifest: { id: "testplugin", name: "test", version: "1", kind: "code", priority: 1, timeoutMs: 5000, maxResults: 20, schemaVersion: 1 }, search } as any);
    vi.spyOn(service as any, "refreshDynamicPlugins").mockResolvedValue(undefined);
    await service.search("test", [], 1, false, "results", "plugin", [], undefined, {});
    expect(search).not.toHaveBeenCalled();
  });
});
