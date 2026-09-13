import { describe, expect, it, vi, afterEach } from "vitest";
import { updateResponseAdapter } from "../../server/utils/responseAdapter";
import { executeInstructions } from "../../server/core/instructions/executor";
import type { InstructionPluginDefinition } from "../../server/core/instructions/types";
const definition: InstructionPluginDefinition = {
  schemaVersion: 1,
  manifest: { id: "response-fixture", name: "Response fixture", version: "1.2.3", kind: "instructions", priority: 50, timeoutMs: 5000, maxResults: 20, schemaVersion: 1, outputTypes: ["quark"] },
  request: { method: "GET", url: "https://example.com/search", allowedDomains: ["example.com"], headers: { "x-api-key": "{{secret.api_key}}" }, secrets: ["api_key"], query: { q: "{{keyword}}" }, maxResponseBytes: 50000 },
  response: { format: "json", items: "data", fields: { title: "title" }, links: { url: "url" } },
};
afterEach(() => vi.restoreAllMocks());
describe("persisted response adapter", () => {
  it("changes only response and patch version without losing request configuration", () => {
    const changed = updateResponseAdapter(definition, { ...definition.response, fields: { title: "name" } });
    expect(changed.manifest.version).toBe("1.2.4");
    expect(changed.request).toEqual(definition.request);
    expect(definition.response.fields.title).toBe("title");
  });
  it("JSON rules are consumed by the actual search instruction executor", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: [{ name: "Mapped", share: "https://pan.quark.cn/s/example" }] }), { headers: { "content-type": "application/json" } }));
    const changed = updateResponseAdapter(definition, { format: "json", items: "data", fields: { title: "name" }, links: { url: "share" } });
    const execution = await executeInstructions(changed, "Mapped", { secrets: { api_key: "test-value" } });
    expect(execution.results[0]?.title).toBe("Mapped");
    expect(execution.results[0]?.links[0]?.url).toBe("https://pan.quark.cn/s/example");
  });
  it("HTML selector and href rules use the same instruction executor", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('<div class="item"><h2>HTML mapped</h2><a href="https://pan.quark.cn/s/example">Download</a></div>', { headers: { "content-type": "text/html" } }));
    const changed = updateResponseAdapter(definition, { format: "html", items: ".item", fields: { title: "h2" }, links: { selector: "a", url: { source: "href" } } });
    const execution = await executeInstructions(changed, "HTML", { secrets: { api_key: "test-value" } });
    expect(execution.results[0]?.title).toBe("HTML mapped");
    expect(execution.results[0]?.links[0]?.url).toBe("https://pan.quark.cn/s/example");
  });
  it("rejects invalid response rules instead of silently saving a display-only mapping", () => {
    expect(() => updateResponseAdapter(definition, { format: "xml" } as any)).toThrow();
    expect(() => updateResponseAdapter(definition, undefined as any)).toThrow();
  });
});
