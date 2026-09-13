import { describe, expect, it } from "vitest";
import { parseWithParserPlugin } from "../../server/core/parsers/runtime";
import { SqliteParserPluginRepository } from "../../server/core/parsers/repository";
import type { ParserPluginRecord } from "../../server/core/parsers/types";

const record = (format: "html" | "json" | "text", code: string): ParserPluginRecord => ({
  id: `test-${format}`, status: "published", manifest: { id: `test-${format}`, name: "test", version: "1.0.0", format, target: "both", timeoutMs: 1000, maxResults: 20 }, code, versions: [], createdAt: "", updatedAt: "", updatedBy: "test",
});

describe("parser plugin runtime", () => {
  it("passes raw HTML and Cheerio to transform", () => {
    const results = parseWithParserPlugin(record("html", "function transform(raw, $, context) { return [{ title: $('h1').text() + context.keyword, url: $('a').attr('href') }]; }"), "<h1>Movie</h1><a href='https://pan.baidu.com/s/abc'>x</a>", { rawBody: "", format: "html", keyword: " test", channel: "chan" });
    expect(results[0]).toMatchObject({ title: "Movie test", channel: "chan", links: [{ type: "baidu", url: "https://pan.baidu.com/s/abc" }] });
  });
  it("auto format provides Cheerio for HTML and parsed payload for JSON", () => {
    const htmlRecord = { ...record("html", "(payload, $, context) => [{ title: context.format + ':' + $('h1').text(), url: $('a').attr('href') }]") , manifest: { ...record("html", "() => []").manifest, id: "test-auto-html", format: "auto" as const } } as ParserPluginRecord;
    const html = parseWithParserPlugin(htmlRecord, "<h1>Movie</h1><a href='https://pan.baidu.com/s/auto'>x</a>", { rawBody: "", format: "html" });
    expect(html[0]).toMatchObject({ title: "html:Movie" });
    const jsonRecord = { ...htmlRecord, id: "test-auto-json", manifest: { ...htmlRecord.manifest, id: "test-auto-json" }, code: "(payload, $, context) => [{ title: context.format + ':' + payload.name, url: payload.url }]" } as ParserPluginRecord;
    const json = parseWithParserPlugin(jsonRecord, JSON.stringify({ name: "JSON", url: "https://pan.quark.cn/s/auto" }), { rawBody: "", format: "json" });
    expect(json[0]).toMatchObject({ title: "json:JSON" });
  });
  it("passes parsed JSON and normalizes item links", () => {
    const results = parseWithParserPlugin(record("json", "(payload) => payload.data.map(item => ({ title: item.name, links: [{ url: item.link, password: item.pwd }] }))"), JSON.stringify({ data: [{ name: "A", link: "https://pan.quark.cn/s/x", pwd: "123" }] }), { rawBody: "", format: "json", keyword: "k" });
    expect(results[0]).toMatchObject({ title: "A", links: [{ type: "quark", password: "123" }] });
  });
  it("enforces timeout while invoking the transform", () => {
    expect(() => parseWithParserPlugin(record("text", "() => { while (true) {} }"), "x", { rawBody: "", format: "text" })).toThrow();
  });
  it("keeps the published version serving while a new draft is edited", async () => {
    const repository = new SqliteParserPluginRepository();
    await repository.saveDraft({
      manifest: { id: "hot-swap", name: "Hot swap", version: "1.0.0", format: "text", target: "both", timeoutMs: 1000, maxResults: 20 },
      code: "() => [{ title: 'v1', url: 'https://pan.baidu.com/s/v1' }]",
    });
    await repository.publish("hot-swap");
    await repository.saveDraft({
      manifest: { id: "hot-swap", name: "Hot swap", version: "2.0.0", format: "text", target: "both", timeoutMs: 1000, maxResults: 20 },
      code: "() => [{ title: 'v2', url: 'https://pan.baidu.com/s/v2' }]",
    });
    expect((await repository.getPublished("hot-swap"))?.manifest.version).toBe("1.0.0");
    await repository.publish("hot-swap");
    expect((await repository.getPublished("hot-swap"))?.manifest.version).toBe("2.0.0");
  });
  it("does not expose process or require", () => {
    expect(() => parseWithParserPlugin(record("text", "() => process.env"), "x", { rawBody: "", format: "text" })).toThrow(/禁止的运行时关键字/);
  });
});
