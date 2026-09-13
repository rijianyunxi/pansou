import { afterEach, describe, expect, it, vi } from "vitest";
import { executeInstructions } from "../../server/core/instructions/executor";
import { validateInstructionDefinition } from "../../server/core/instructions/validator";
import type { InstructionPluginDefinition } from "../../server/core/instructions/types";

const manifest = {
  id: "fixture-json",
  name: "Fixture JSON",
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

afterEach(() => vi.restoreAllMocks());

describe("Instructions executor", () => {
  it("renders a JSON request and maps SearchResult", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      data: { list: [{ name: "Example", description: "desc", updated_at: "2026-01-02T03:04:05Z", links: [{ url: "https://pan.quark.cn/s/abc", type: "quark", password: "1234" }] }] },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await executeInstructions(jsonDefinition, "hello");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ keyword: "hello", page: "1" });
    expect(result.results[0]).toMatchObject({ title: "Example", content: "desc", links: [{ type: "quark", password: "1234" }] });
    expect(result.traces[0]?.status).toBe(200);
  });

  it("supports HTML selectors and relative links", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(`
      <div class="item"><h2>HTML result</h2><p class="desc">Details</p><a class="share" href="/s/xyz">share</a></div>
    `, { status: 200, headers: { "content-type": "text/html" } }));
    const definition = { ...jsonDefinition, manifest: { ...manifest, id: "fixture-html" }, request: { method: "GET" as const, url: "https://example.com/search?q={{keyword}}" }, response: {
      format: "html" as const, items: ".item", fields: { title: ".item h2", content: ".desc" }, links: { selector: "a.share", url: { selector: "", source: "href" as const }, type: { source: "constant" as const, value: "quark" } },
    }};
    const result = await executeInstructions(definition, "hello");
    expect(result.results[0]?.title).toBe("HTML result");
    expect(result.results[0]?.links[0]?.url).toBe("https://example.com/s/xyz");
  });

  it("rejects unsupported variables and unsafe URLs", () => {
    expect(() => validateInstructionDefinition({ ...jsonDefinition, request: { ...jsonDefinition.request, url: "file:///etc/passwd" } })).toThrow(/协议/);
    // Unsupported interpolation is rejected before a request is sent.
    expect(() => validateInstructionDefinition({ ...jsonDefinition, request: { ...jsonDefinition.request, url: "https://example.com/{{env}}" } })).toThrow(/模板变量/);
  });

  it("rejects insecure HTTP, non-standard ports and unexpected content types", async () => {
    expect(() =>
      validateInstructionDefinition({
        ...jsonDefinition,
        request: { ...jsonDefinition.request, url: "http://example.com/search" },
      })
    ).toThrow(/HTTPS/);
    expect(() =>
      validateInstructionDefinition({
        ...jsonDefinition,
        request: { ...jsonDefinition.request, url: "https://example.com:8443/search" },
      })
    ).toThrow(/端口/);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not json", {
        status: 200,
        headers: { "content-type": "text/plain" },
      })
    );
    await expect(executeInstructions(jsonDefinition, "hello")).rejects.toThrow(
      /Content-Type/
    );
  });

  it("does not follow a redirect outside the allowlist", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } }));
    await expect(executeInstructions({ ...jsonDefinition, request: { ...jsonDefinition.request, redirect: "follow" } }, "hello")).rejects.toThrow(/协议|内网/);
  });

  it("extracts fields with a restricted regex (JSON)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      data: { list: [{ name: "资源标题", detail: "提取码: x8k2，详见说明", links: [{ url: "https://pan.quark.cn/s/abc" }] }] },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const definition: InstructionPluginDefinition = {
      ...jsonDefinition,
      response: {
        ...jsonDefinition.response,
        fields: {
          ...jsonDefinition.response.fields,
          content: { path: "detail", regex: { pattern: "提取码[:：]\\s*(\\w+)" } },
        },
      },
    };
    const result = await executeInstructions(definition, "hello");
    expect(result.results[0]?.content).toBe("x8k2");
  });

  it("extracts passwords from HTML text with a regex", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(`
      <div class="item"><h2>T</h2><a class="share" href="/s/xyz">链接 密码：ab12</a></div>
    `, { status: 200, headers: { "content-type": "text/html" } }));
    const definition: InstructionPluginDefinition = {
      ...jsonDefinition,
      manifest: { ...manifest, id: "fixture-html-regex" },
      request: { method: "GET", url: "https://example.com/search?q={{keyword}}" },
      response: {
        format: "html",
        items: ".item",
        fields: { title: ".item h2" },
        links: {
          selector: "a.share",
          url: { selector: "", source: "href" },
          password: { selector: "", regex: { pattern: "密码：(\\w+)" } },
        },
      },
    };
    const result = await executeInstructions(definition, "hello");
    expect(result.results[0]?.links[0]).toMatchObject({
      url: "https://example.com/s/xyz",
      password: "ab12",
    });
  });

  it("paginates JSON results via a page query parameter", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("p") || "0");
      const list = page === 1 || page === 2
        ? [{ name: `Item ${page}`, links: [{ url: `https://pan.quark.cn/s/p${page}` }] }]
        : [];
      return new Response(JSON.stringify({ data: { list } }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const definition: InstructionPluginDefinition = {
      ...jsonDefinition,
      request: { ...jsonDefinition.request, method: "GET", url: "https://example.com/api/search", query: { q: "{{keyword}}" } },
      response: { ...jsonDefinition.response, nextPage: { queryParam: "p", maxPages: 5 } },
    };
    const result = await executeInstructions(definition, "hello");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.results.map((item) => item.title)).toEqual(["Item 1", "Item 2"]);
    expect(result.traces.map((trace) => trace.stage)).toEqual(["request", "page:2", "page:3"]);
  });

  it("stops pagination at maxPages when every page has results", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({
      data: { list: [{ name: "Item", links: [{ url: "https://pan.quark.cn/s/abc" }] }] },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const definition: InstructionPluginDefinition = {
      ...jsonDefinition,
      request: { ...jsonDefinition.request, method: "GET", url: "https://example.com/api/search" },
      response: { ...jsonDefinition.response, nextPage: { queryParam: "p", maxPages: 2 } },
    };
    const result = await executeInstructions(definition, "hello");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.results).toHaveLength(2);
  });

  it("follows an HTML next-page selector and merges pages", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      const page = url.searchParams.get("page") || "1";
      const nextLink = page === "1" ? '<a class="next" href="/search?page=2">下一页</a>' : "";
      return new Response(`
        <div class="item"><h2>Page ${page}</h2><a class="share" href="/s/${page}">share</a></div>
        ${nextLink}
      `, { status: 200, headers: { "content-type": "text/html" } });
    });
    const definition: InstructionPluginDefinition = {
      ...jsonDefinition,
      manifest: { ...manifest, id: "fixture-html-pages" },
      request: { method: "GET", url: "https://example.com/search?q={{keyword}}" },
      response: {
        format: "html",
        items: ".item",
        fields: { title: ".item h2" },
        links: { selector: "a.share", url: { selector: "", source: "href" } },
        nextPage: { selector: "a.next", maxPages: 3 },
      },
    };
    const result = await executeInstructions(definition, "hello");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.results.map((item) => item.title)).toEqual(["Page 1", "Page 2"]);
    expect(result.results[1]?.links[0]?.url).toBe("https://example.com/s/2");
    expect(result.traces.map((trace) => trace.stage)).toEqual(["request", "page:2"]);
  });

  it("keeps earlier-page results when a later page fails", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("p") || "0");
      if (page >= 2) return new Response("boom", { status: 500 });
      return new Response(JSON.stringify({
        data: { list: [{ name: `Item ${page}`, links: [{ url: "https://pan.quark.cn/s/abc" }] }] },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const definition: InstructionPluginDefinition = {
      ...jsonDefinition,
      request: { ...jsonDefinition.request, method: "GET", url: "https://example.com/api/search" },
      response: { ...jsonDefinition.response, nextPage: { queryParam: "p", maxPages: 3 } },
    };
    const result = await executeInstructions(definition, "hello");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.results.map((item) => item.title)).toEqual(["Item 1"]);
    expect(result.traces.at(-1)?.error).toContain("500");
  });

  it("rejects invalid regex and nextPage configuration", () => {
    expect(() =>
      validateInstructionDefinition({
        ...jsonDefinition,
        response: {
          ...jsonDefinition.response,
          fields: { ...jsonDefinition.response.fields, title: { path: "name", regex: { pattern: "([" } } },
        },
      })
    ).toThrow(/regex\.pattern 无效/);
    expect(() =>
      validateInstructionDefinition({
        ...jsonDefinition,
        response: {
          ...jsonDefinition.response,
          fields: { ...jsonDefinition.response.fields, title: { path: "name", regex: { pattern: "a", flags: "gx" } } },
        },
      })
    ).toThrow(/regex\.flags/);
    expect(() =>
      validateInstructionDefinition({
        ...jsonDefinition,
        response: { ...jsonDefinition.response, nextPage: {} },
      })
    ).toThrow(/selector 或 queryParam/);
    expect(() =>
      validateInstructionDefinition({
        ...jsonDefinition,
        response: { ...jsonDefinition.response, nextPage: { selector: "a.next" } },
      })
    ).toThrow(/仅支持 HTML/);
    expect(() =>
      validateInstructionDefinition({
        ...jsonDefinition,
        response: { ...jsonDefinition.response, nextPage: { queryParam: "p", maxPages: 20 } },
      })
    ).toThrow(/maxPages/);
  });

  it("runs a pre-stage that extracts a token used by the main request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/api/token")) {
        return new Response(JSON.stringify({ data: { buildId: "bld_42" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      expect(url).toBe("https://example.com/api/search?build=bld_42");
      expect((init?.headers as Record<string, string>)["x-trace"]).toBe("bld_42");
      expect(JSON.parse(String(init?.body))).toEqual({ keyword: "hello", buildId: "bld_42" });
      return new Response(JSON.stringify({
        data: { list: [{ name: "Stage Result", links: [{ url: "https://pan.quark.cn/s/abc" }] }] },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const definition: InstructionPluginDefinition = {
      ...jsonDefinition,
      request: {
        ...jsonDefinition.request,
        url: "https://example.com/api/search",
        query: { build: "{{buildId}}" },
        headers: { "x-trace": "{{buildId}}" },
        body: { keyword: "{{keyword}}", buildId: "{{buildId}}" },
        stages: [
          {
            method: "GET",
            url: "https://example.com/api/token",
            response: { format: "json", vars: { buildId: "data.buildId" } },
          },
        ],
      },
    };
    const result = await executeInstructions(definition, "hello");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.traces.map((trace) => trace.stage)).toEqual(["stage:1", "request"]);
    expect(result.results[0]?.title).toBe("Stage Result");
  });

  it("rejects stage requests outside the main request domain without an allowlist", async () => {
    vi.spyOn(globalThis, "fetch");
    const definition: InstructionPluginDefinition = {
      ...jsonDefinition,
      request: {
        ...jsonDefinition.request,
        url: "https://example.com/api/search",
        stages: [
          {
            method: "GET",
            url: "https://other.example.net/api/token",
            response: { format: "json", vars: { buildId: "data.buildId" } },
          },
        ],
      },
    };
    await expect(executeInstructions(definition, "hello")).rejects.toThrow(/仅允许访问主请求同域/);
  });

  it("fails with a config path when a stage variable extracts to empty", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const definition: InstructionPluginDefinition = {
      ...jsonDefinition,
      request: {
        ...jsonDefinition.request,
        url: "https://example.com/api/search",
        stages: [
          {
            method: "GET",
            url: "https://example.com/api/token",
            response: { format: "json", vars: { buildId: "data.missing" } },
          },
        ],
      },
    };
    await expect(executeInstructions(definition, "hello")).rejects.toThrow(
      /stages\[0\]\.response\.vars\.buildId 提取结果为空/
    );
  });

  it("validates stage structure, limits and variable names", () => {
    const withStages = (stages: any[]) =>
      validateInstructionDefinition({
        ...jsonDefinition,
        request: { ...jsonDefinition.request, url: "https://example.com/api/search", stages },
      });
    expect(() => withStages(new Array(3).fill({
      method: "GET",
      url: "https://example.com/api/token",
      response: { format: "json", vars: { token: "data.token" } },
    }))).toThrow(/最多 2 个阶段/);
    expect(() => withStages([
      { method: "GET", url: "https://example.com/api/token", response: { format: "json", vars: { keyword: "data.k" } } },
    ])).toThrow(/保留变量/);
    expect(() => withStages([
      { method: "GET", url: "https://example.com/api/token", response: { format: "json", vars: { "bad name": "data.k" } } },
    ])).toThrow(/变量名/);
  });

  it("injects secrets into headers and body but never into URLs", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      data: { list: [{ name: "Secret Result", links: [{ url: "https://pan.quark.cn/s/abc" }] }] },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const definition: InstructionPluginDefinition = {
      ...jsonDefinition,
      request: {
        ...jsonDefinition.request,
        url: "https://example.com/api/search",
        secrets: ["apiKey"],
        headers: { "x-api-key": "{{secret.apiKey}}" },
      },
    };
    const result = await executeInstructions(definition, "hello", {
      secrets: { apiKey: "sk-test-123" },
    });
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("sk-test-123");
    expect(String(init?.body || "")).not.toContain("sk-test-123");
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain("sk-test-123");
    expect(result.results[0]?.title).toBe("Secret Result");
  });

  it("rejects secret references in URL or query templates", () => {
    expect(() =>
      validateInstructionDefinition({
        ...jsonDefinition,
        request: {
          ...jsonDefinition.request,
          url: "https://example.com/api/search",
          secrets: ["apiKey"],
          query: { key: "{{secret.apiKey}}" },
        },
      })
    ).toThrow(/密钥仅可用于请求头和请求体/);
    expect(() =>
      validateInstructionDefinition({
        ...jsonDefinition,
        request: {
          ...jsonDefinition.request,
          url: "https://example.com/api/search?key={{secret.apiKey}}",
          secrets: ["apiKey"],
        },
      })
    ).toThrow(/密钥仅可用于请求头和请求体/);
  });
});
