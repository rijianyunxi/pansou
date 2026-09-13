import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSearch } from "../../composables/useSearch";
const response = { code: 0, data: { total: 0, results: [] } };
const options = { apiBase: "/api", keyword: "test", userTgChannels: ["ownchan"] };

describe("frontend search lifecycle", () => {
  const fetch = vi.fn();
  beforeEach(() => { fetch.mockReset(); vi.stubGlobal("$fetch", fetch); });
  afterEach(() => vi.unstubAllGlobals());
  it("sends a minimal POST for all-site search", async () => {
    fetch.mockResolvedValue(response);
    await useSearch().performSearch(options);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe("/api/search");
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "POST", retry: 0, body: { kw: "test" } });
    expect(Object.keys(fetch.mock.calls[0]![1].body)).toEqual(["kw"]);
  });
  it("only mode sends no request with empty list", async () => {
    const search = useSearch();
    await search.performSearch({ ...options, onlyUserTg: true, userTgChannels: [] });
    expect(fetch).not.toHaveBeenCalled();
    expect(search.error.value).toContain("添加至少一个");
  });
  it("supports only mode and displays partial-success warnings", async () => {
    fetch.mockResolvedValue({ ...response, warnings: [{}] });
    const search = useSearch();
    await search.performSearch({ ...options, onlyUserTg: true });
    expect(fetch.mock.calls[0]![1].body.channels_mode).toBe("only");
    expect(search.state.value.warning).toContain("部分来源");
  });
  it("does not disguise failures as empty results; 401 prompts auth once", async () => {
    fetch.mockRejectedValue({ statusCode: 401 });
    const onAuthRequired = vi.fn();
    const search = useSearch();
    await search.performSearch({ ...options, onAuthRequired });
    expect(search.error.value).toContain("解锁");
    expect(onAuthRequired).toHaveBeenCalledTimes(1);
  });
  it("late response from aborted search cannot finish or overwrite newer search", async () => {
    let finishOld!: (value: unknown) => void;
    let finishNew!: (value: unknown) => void;
    fetch.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishNew = resolve; }));
    const search = useSearch();
    const old = search.performSearch(options);
    const current = search.performSearch({ ...options, keyword: "new" });
    expect(fetch.mock.calls[0]![1].signal.aborted).toBe(true);
    finishOld(response); await old;
    expect(search.loading.value).toBe(true);
    finishNew(response); await current;
    expect(search.loading.value).toBe(false);
  });
  it("pause/resume retries the captured request, not edited channels or mode", async () => {
    let finishOld!: (value: unknown) => void;
    fetch.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; })).mockResolvedValue(response);
    const search = useSearch();
    const channels = ["ownchan"];
    const old = search.performSearch({ ...options, userTgChannels: channels, onlyUserTg: true });
    search.pauseSearch(); channels.push("laterchan");
    await search.continueSearch({ ...options, keyword: "changed", onlyUserTg: false });
    expect(fetch.mock.calls[1]![1].body).toEqual({ kw: "test", channels: ["ownchan"], channels_mode: "only" });
    finishOld(response); await old;
    expect(search.paused.value).toBe(false);
  });
});
