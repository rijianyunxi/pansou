import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecutionBudgetError, executeInstructions } from "../../server/core/instructions/executor";
import type { InstructionPluginDefinition } from "../../server/core/instructions/types";

const manifest = {
  id: "fixture-budget",
  name: "Fixture Budget",
  version: "1.0.0",
  kind: "instructions" as const,
  priority: 50,
  timeoutMs: 5_000,
  maxResults: 20,
  schemaVersion: 1,
  outputTypes: ["quark"],
};

const jsonDefinition: InstructionPluginDefinition = {
  schemaVersion: 1,
  manifest,
  request: {
    method: "POST",
    url: "https://example.com/api/search",
    bodyType: "json",
    body: { keyword: "{{keyword}}", page: "{{page}}" },
  },
  response: {
    format: "json",
    items: "data.list",
    fields: { title: "name", content: "description", datetime: "updated_at" },
    links: { array: "links", url: "url", type: "type", password: "password" },
  },
};

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const pagedDefinition = (maxPages: number): InstructionPluginDefinition => ({
  ...jsonDefinition,
  request: {
    ...jsonDefinition.request,
    method: "GET",
    url: "https://example.com/api/search",
    query: { q: "{{keyword}}" },
    stages: [
      {
        method: "GET",
        url: "https://example.com/api/token",
        response: { format: "json", vars: { buildId: "data.buildId" } },
      },
    ],
  },
  response: { ...jsonDefinition.response, nextPage: { queryParam: "p", maxPages } },
});

afterEach(() => vi.restoreAllMocks());

describe("instruction execution budgets", () => {
  it("spends one request budget across stage, main request and pagination", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/token")) return jsonResponse({ data: { buildId: "bld_1" } });
      const page = new URL(url).searchParams.get("p") || "1";
      return jsonResponse({
        data: { list: [{ name: `Item ${page}`, description: "d", updated_at: "2026-01-02T03:04:05Z", links: [{ url: "https://pan.quark.cn/s/x", type: "quark" }] }] },
      });
    });
    const definition = pagedDefinition(10);
    // stage + main + page:2 exhaust maxTotalRequests=3; page:3 must fail loudly.
    const first = executeInstructions(definition, "hello", { budget: { maxTotalRequests: 3 } });
    await expect(first).rejects.toThrow(ExecutionBudgetError);
    await expect(executeInstructions(definition, "hello", { budget: { maxTotalRequests: 3 } }))
      .rejects.toMatchObject({ name: "ExecutionBudgetError", path: "budget.maxTotalRequests" });
    await expect(executeInstructions(definition, "hello", { budget: { maxTotalRequests: 3 } }))
      .rejects.toThrow(/解析器请求预算超限: budget\.maxTotalRequests=3/);
  });

  it("surfaces budget exhaustion instead of degrading pagination results", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/token")) return jsonResponse({ data: { buildId: "bld_1" } });
      const page = new URL(url).searchParams.get("p") || "1";
      return jsonResponse({
        data: { list: [{ name: `Item ${page}`, description: "d", updated_at: "2026-01-02T03:04:05Z", links: [{ url: "https://pan.quark.cn/s/x", type: "quark" }] }] },
      });
    });
    // stage + main + page:2 succeed, page:3 exceeds the budget: the call must
    // reject (search layer turns it into a warning) rather than silently keep
    // the partial pages.
    await expect(executeInstructions(pagedDefinition(10), "hello", { budget: { maxTotalRequests: 3 } }))
      .rejects.toThrow(ExecutionBudgetError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("admits the historical worst case under the default budgets", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/token")) return jsonResponse({ data: { buildId: "bld_1" } });
      const page = new URL(url).searchParams.get("p") || "1";
      return jsonResponse({
        data: { list: [{ name: `Item ${page}`, description: "d", updated_at: "2026-01-02T03:04:05Z", links: [{ url: "https://pan.quark.cn/s/x", type: "quark" }] }] },
      });
    });
    // 1 stage + main + pagination until totalRequests hits MAX_TOTAL_REQUESTS(6)
    // = 7 requests total; the default budget must admit exactly this.
    const result = await executeInstructions(pagedDefinition(10), "hello");
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(result.results).toHaveLength(6);
  });

  it("counts request bodies toward the transfer budget", async () => {
    // Fresh Response per call: a Response body stream can be read only once.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({ data: { list: [] } }));
    // Body `{"keyword":"hello","page":"1"}` = 30 bytes + response body 20 bytes = 50.
    await expect(executeInstructions(jsonDefinition, "hello", { budget: { maxTotalBytes: 49 } }))
      .rejects.toMatchObject({ name: "ExecutionBudgetError", path: "budget.maxTotalBytes" });
    await expect(executeInstructions(jsonDefinition, "hello", { budget: { maxTotalBytes: 49 } }))
      .rejects.toThrow(/解析器传输预算超限: budget\.maxTotalBytes=49/);
    const result = await executeInstructions(jsonDefinition, "hello", { budget: { maxTotalBytes: 50 } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.results).toEqual([]);
  });
});
