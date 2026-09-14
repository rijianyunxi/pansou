import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfiguredUpstreamPlugin, upstreamToInstructionDefinition } from "../../server/core/services/configuredUpstreamPlugin";
import type { UpstreamDefinition } from "../../types/source";

const source: UpstreamDefinition = {
  id: "configured-demo",
  name: "Configured demo",
  description: "",
  url: "https://example.com/search",
  method: "GET",
  format: "json",
  plugin: "configured-demo",
  adapter: "json-mapping",
  color: "#697fbd",
  initials: "C",
  mapping: { items: "", title: "name", url: "share", type: "kind", password: "pwd" },
};

afterEach(() => vi.restoreAllMocks());

describe("configured upstream runtime", () => {
  it("converts catalog config to the generic executor and supports root arrays", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([
      { name: "Demo", share: "https://pan.quark.cn/s/abc", kind: "quark", pwd: "1234" },
    ]), { status: 200, headers: { "content-type": "application/json" } }));
    const definition = upstreamToInstructionDefinition(source);
    expect(definition.request.query).toEqual({ keyword: "{{keyword}}" });
    expect(definition.response.items).toBe("");
    const plugin = createConfiguredUpstreamPlugin(source);
    const results = await plugin.search({
      searchId: "test",
      keyword: "demo",
      keywordVariants: ["demo"],
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      ext: {},
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results[0]).toMatchObject({ title: "Demo", links: [{ type: "quark", password: "1234" }] });
  });

  it("changes the registry version token when endpoint configuration changes", () => {
    const first = upstreamToInstructionDefinition(source);
    const second = upstreamToInstructionDefinition({ ...source, url: "https://example.com/other" });
    expect(first.manifest.version).not.toBe(second.manifest.version);
  });

  it("uses source.url as the only request endpoint", () => {
    const definition = upstreamToInstructionDefinition({
      ...source,
      url: "https://example.com/search?q={{keyword}}",
      request: { query: { q: "{{keyword}}" } },
    });

    expect(definition.request.url).toBe("https://example.com/search?q={{keyword}}");
    expect(definition.request).not.toHaveProperty("fallbackUrls");
    expect(definition.request.allowedDomains).toEqual(["example.com"]);
  });

  it("runs a configured transform(payload, $, context) after the response", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      rows: [{ name: "Transformed", href: "https://pan.baidu.com/s/transform" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const transformed = {
      ...source,
      id: "configured-transform",
      transform: "function transform(payload, $, context) { return payload.rows.map(function (row) { return { title: row.name + ':' + context.keyword, url: row.href }; }); }",
      mapping: { items: "", title: "", url: "", type: "", password: "" },
    };
    const definition = upstreamToInstructionDefinition(transformed);
    expect(definition.response.transform).toContain("context.keyword");
    const plugin = createConfiguredUpstreamPlugin(transformed);
    const results = await plugin.search({
      searchId: "test",
      keyword: "demo",
      keywordVariants: ["demo"],
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      ext: {},
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results[0]).toMatchObject({ title: "Transformed:demo", links: [{ type: "baidu" }] });
  });

  it("uses configured POST body and HTML selectors", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      `<article class="item"><h2>HTML demo</h2><a class="share" href="/s/abc">share</a></article>`,
      { status: 200, headers: { "content-type": "text/html" } },
    ));
    const htmlSource: UpstreamDefinition = {
      ...source,
      id: "configured-html",
      method: "POST",
      format: "html",
      mapping: { items: ".item", title: "h2", url: "", linkArray: "a.share", type: "", password: "" },
      request: { bodyType: "json", body: { q: "{{keyword}}" } },
    };
    const plugin = createConfiguredUpstreamPlugin(htmlSource);
    const results = await plugin.search({
      searchId: "test",
      keyword: "demo",
      keywordVariants: ["demo"],
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      ext: {},
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ q: "demo" });
    expect(results[0]).toMatchObject({ title: "HTML demo", links: [{ url: "https://example.com/s/abc" }] });
  });
});
