import { load } from "cheerio";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchTgChannelPosts, parseChannelPage } from "../../server/core/services/tg";
import { ofetch } from "ofetch";
import { getTgSourceSettings, saveTgSourceSettings } from "../../server/core/services/tgSourceSettings";

vi.mock("ofetch", () => ({ ofetch: vi.fn() }));
const fetcher = vi.mocked(ofetch);

function page(options: { date?: string; urls?: string[]; before?: string; title?: string } = {}) {
  return `<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="channel/123">
    <time datetime="${options.date ?? "2026-09-12T00:00:00Z"}"></time>
    <div class="tgme_widget_message_text">${options.title ?? "test movie"}
    ${(options.urls ?? ["https://pan.quark.cn/s/abc"]).map((url) => `<a href="${url}">download</a>`).join("")}</div>
  </div></div>${options.before ? `<a href="?before=${options.before}">older</a>` : ""}`;
}
let sourceSnapshot: ReturnType<typeof getTgSourceSettings>;
beforeEach(() => {
  vi.useFakeTimers();
  fetcher.mockReset();
  sourceSnapshot = getTgSourceSettings();
});
afterEach(() => {
  vi.useRealTimers();
  saveTgSourceSettings(sourceSnapshot);
});


it("runs a hot-updated configured transform through the common parser runtime", async () => {
  saveTgSourceSettings({
    transform: `(payload, $, context) => [{ title: "configured:" + context.route, url: "https://pan.quark.cn/s/configured" }]`,
  });
  fetcher.mockResolvedValue(page());
  const result = await fetchTgChannelPosts("channel", "test");
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    title: "configured:telegram",
    pluginId: "tg-source",
    pluginVersion: "1.0.1",
    links: [{ type: "quark", url: "https://pan.quark.cn/s/configured" }],
  });
});

it("sends configured request headers to the selected TG route", async () => {
  saveTgSourceSettings({ userAgent: "Configured UA", headers: { "x-panhub-test": "enabled" } });
  fetcher.mockResolvedValue(page());
  await fetchTgChannelPosts("channel", "test");
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    headers: { "user-agent": "Configured UA", "x-panhub-test": "enabled" },
  });
});

it("ignores legacy parser bindings and uses the configured TG transform", async () => {
  saveTgSourceSettings({
    transform: `(payload, $, context) => [{ title: "configured:" + context.channel, url: "https://pan.quark.cn/s/configured" }]`,
  });
  fetcher.mockResolvedValue(page());
  const result = await fetchTgChannelPosts("channel", "test");
  expect(result).toMatchObject([{ title: "configured:channel", pluginId: "tg-source" }]);
});

it("parses direct pages without hidden automatic retries", async () => {
  fetcher.mockResolvedValue(page());
  const result = await fetchTgChannelPosts("channel", "test");
  expect(result).toHaveLength(1);
  expect(fetcher).toHaveBeenCalledWith("https://t.me/s/channel?q=test", expect.objectContaining({ retry: 0, responseType: "text", signal: expect.any(AbortSignal) }));
  expect(vi.getTimerCount()).toBe(0);
});
it("falls back on a direct failure and reports success when the mirror is usable", async () => {
  fetcher.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(page());
  expect(await fetchTgChannelPosts("channel", "test")).toHaveLength(1);
  expect(fetcher.mock.calls[1]?.[0]).toBe("https://r.jina.ai/https://t.me/s/channel?q=test");
});
it("does not switch to a backup route for a managed source address", async () => {
  fetcher.mockRejectedValue(new Error("network"));
  await expect(fetchTgChannelPosts("channel", "test", {
    primaryUrl: "https://proxy.example.com/{{channel}}?q={{keyword}}",
    maxRetries: 0,
  })).rejects.toThrow("network");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[0]).toBe("https://proxy.example.com/channel?q=test");
});
it("surfaces failure and distinguishes it from a valid zero-match response", async () => {
  fetcher.mockResolvedValue("<html>blocked</html>");
  await expect(fetchTgChannelPosts("channel", "test")).rejects.toThrow("解析失败");
  fetcher.mockResolvedValue(page());
  expect(await fetchTgChannelPosts("channel", "no-match")).toEqual([]);
});
it("does not start a request when already aborted", async () => {
  const controller = new AbortController(); controller.abort();
  await expect(fetchTgChannelPosts("channel", "test", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(fetcher).not.toHaveBeenCalled();
});
it("cancels a pending fetch without starting the mirror", async () => {
  fetcher.mockImplementation(() => new Promise(() => {}));
  const controller = new AbortController();
  const promise = fetchTgChannelPosts("channel", "test", { signal: controller.signal });
  const assertion = expect(promise).rejects.toThrow("cancelled");
  await vi.advanceTimersByTimeAsync(0);
  const signal = fetcher.mock.calls[0]?.[1]?.signal;
  controller.abort(new Error("cancelled"));
  await assertion;
  expect(signal?.aborted).toBe(true); expect(fetcher).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it("has a real deadline even when the caller supplies a signal", async () => {
  fetcher.mockImplementation(() => new Promise(() => {}));
  const controller = new AbortController();
  const promise = fetchTgChannelPosts("channel", "test", { signal: controller.signal, timeoutMs: 20 });
  const assertion = expect(promise).rejects.toMatchObject({ name: "TimeoutError" });
  await vi.advanceTimersByTimeAsync(20); await assertion;
  expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  expect(controller.signal.aborted).toBe(false);
});
it("cancels the pagination delay and does not start the next page", async () => {
  fetcher.mockResolvedValue(page({ before: "100" }));
  const controller = new AbortController();
  const promise = fetchTgChannelPosts("channel", "test", { signal: controller.signal });
  const assertion = expect(promise).rejects.toThrow("cancelled");
  await vi.advanceTimersByTimeAsync(1);
  controller.abort(new Error("cancelled"));
  await assertion; await vi.advanceTimersByTimeAsync(1000);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it("stops when Telegram repeats a pagination cursor", async () => {
  fetcher.mockResolvedValue(page({ before: "100" }));
  const promise = fetchTgChannelPosts("channel", "test", { limitPerChannel: 160 });
  await vi.advanceTimersByTimeAsync(500);
  await promise;
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("keeps q when requesting an older Telegram page", async () => {
  fetcher
    .mockResolvedValueOnce(page({ before: "100" }))
    .mockResolvedValueOnce(page());
  const promise = fetchTgChannelPosts("channel", "test", { limitPerChannel: 40 });
  await vi.advanceTimersByTimeAsync(100);
  await promise;
  expect(fetcher.mock.calls[1]?.[0]).toBe(
    "https://t.me/s/channel?q=test&before=100",
  );
});
it("preserves earlier pages and warns if a later page fails", async () => {
  fetcher.mockResolvedValueOnce(page({ before: "100" })).mockRejectedValue(new Error("network failed"));
  const warning = vi.fn();
  const promise = fetchTgChannelPosts("channel", "test", { onWarning: warning });
  await vi.advanceTimersByTimeAsync(100);
  expect(await promise).toHaveLength(1); expect(warning).toHaveBeenCalledTimes(1);
});
it("ignores an invalid timestamp without losing valid links", () => {
  const result = parseChannelPage(load(page({ date: "invalid" })), "channel", "test", 50);
  expect(result).toHaveLength(1); expect(result[0]!.datetime).toBe("");
});
it("rejects lookalike cloud domains, credentials and non-HTTP schemes", () => {
  const result = parseChannelPage(load(page({ urls: [
    "https://evilalipan.com/s/a", "https://evilaliyundrive.com/s/a",
    "https://evil123pan.com/s/a", "ftp://pan.quark.cn/s/a", "https://user:pass@pan.quark.cn/s/a",
    "https://www.alipan.com/s/a", "https://www.123pan.com/s/a",
  ] })), "channel", "test", 50);
  expect(result[0]!.links.map((link) => link.type)).toEqual(["aliyun", "123"]);
});
it("preserves case-sensitive share ids while deduplicating identical URLs", () => {
  const result = parseChannelPage(load(page({ urls: ["https://pan.quark.cn/s/ABC", "https://pan.quark.cn/s/abc", "https://pan.quark.cn/s/ABC"] })), "channel", "test", 50);
  expect(result[0]!.links).toHaveLength(2);
});
it("does not treat keyword-only messages as usable search results", () => {
  expect(parseChannelPage(load(page({ urls: [] })), "channel", "test", 50)).toEqual([]);
});
