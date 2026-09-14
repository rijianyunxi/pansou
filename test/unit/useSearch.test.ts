import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSearch } from "../../composables/useSearch";

const options = { apiBase: "/api", keyword: "test", userTgChannels: ["ownchan"] };
const complete = (data: unknown = { total: 0, results: [] }, warnings?: unknown[]) => [
  "event: start\ndata: {\"code\":0,\"message\":\"started\"}\n\n",
  `event: complete\ndata: ${JSON.stringify({ code: 0, message: warnings?.length ? "partial_success" : "success", data, ...(warnings ? { warnings } : {}) })}\n\n`,
].join("");
const sseResponse = (body = complete()) => new Response(body, {
  headers: { "content-type": "text/event-stream; charset=utf-8" },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("frontend search lifecycle", () => {
  const fetchMock = vi.fn();
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  it("sends a minimal POST requesting SSE for all-site search", async () => {
    fetchMock.mockResolvedValue(sseResponse());
    await useSearch().performSearch(options);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/search");
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      method: "POST",
      headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
    });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ kw: "test" });
  });

  it("only mode sends no request with empty list", async () => {
    const search = useSearch();
    await search.performSearch({ ...options, onlyUserTg: true, userTgChannels: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(search.error.value).toContain("添加至少一个");
  });

  it("renders source results before completion and keeps them when complete only sends a summary", async () => {
    const encoder = new TextEncoder();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; } });
    fetchMock.mockResolvedValue(new Response(body, { headers: { "content-type": "text/event-stream" } }));
    const search = useSearch();
    const pending = search.performSearch(options);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    streamController.enqueue(encoder.encode(`event: result\ndata: ${JSON.stringify({
      code: 0,
      data: { update: { source: { kind: "plugin", id: "one" }, request: { keyword: "test", phase: "variant" }, results: [{ title: "first", datetime: "", links: [{ type: "quark", url: "https://first", password: "" }] }] } },
    })}\n\n`));
    await vi.waitFor(() => expect(search.total.value).toBe(1));
    expect(search.items.value).toEqual([expect.objectContaining({ type: "quark", url: "https://first" })]);
    expect(search.loading.value).toBe(true);
    streamController.enqueue(encoder.encode(`event: complete\ndata: ${JSON.stringify({
      code: 0,
      message: "partial_success",
      data: { total: 1, meta: { registryVersion: 3, pluginVersions: { one: "1.0.0" } } },
      warnings: [{}],
    })}\n\n`));
    streamController.close();
    await pending;
    expect(search.items.value).toEqual([expect.objectContaining({ type: "quark", url: "https://first" })]);
    expect(search.state.value.warning).toContain("部分来源");
  });

  it("supports only mode", async () => {
    fetchMock.mockResolvedValue(sseResponse());
    await useSearch().performSearch({ ...options, onlyUserTg: true });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      kw: "test", channels: ["ownchan"], channels_mode: "only",
    });
  });

  it("does not disguise failures as empty results; 401 prompts auth once", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ statusMessage: "Unauthorized" }), {
      status: 401, headers: { "content-type": "application/json" },
    }));
    const onAuthRequired = vi.fn();
    const search = useSearch();
    await search.performSearch({ ...options, onAuthRequired });
    expect(search.error.value).toContain("解锁");
    expect(onAuthRequired).toHaveBeenCalledTimes(1);
  });

  it("late response from aborted search cannot finish or overwrite newer search", async () => {
    const oldResponse = deferred<Response>();
    const newResponse = deferred<Response>();
    fetchMock.mockImplementationOnce(() => oldResponse.promise).mockImplementationOnce(() => newResponse.promise);
    const search = useSearch();
    const old = search.performSearch(options);
    const current = search.performSearch({ ...options, keyword: "new" });
    expect(fetchMock.mock.calls[0]![1].signal.aborted).toBe(true);
    oldResponse.resolve(sseResponse()); await old;
    expect(search.loading.value).toBe(true);
    newResponse.resolve(sseResponse()); await current;
    expect(search.loading.value).toBe(false);
  });

  it("pause/resume retries the captured request, not edited channels or mode", async () => {
    const oldResponse = deferred<Response>();
    fetchMock.mockImplementationOnce(() => oldResponse.promise).mockResolvedValue(sseResponse());
    const search = useSearch();
    const channels = ["ownchan"];
    const old = search.performSearch({ ...options, userTgChannels: channels, onlyUserTg: true });
    search.pauseSearch(); channels.push("laterchan");
    await search.continueSearch({ ...options, keyword: "changed", onlyUserTg: false });
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({
      kw: "test", channels: ["ownchan"], channels_mode: "only",
    });
    oldResponse.resolve(sseResponse()); await old;
    expect(search.paused.value).toBe(false);
  });
});
