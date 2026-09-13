import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { load } from "cheerio";
import { ofetch } from "ofetch";
import {
  classifyTgChannelPage,
  fetchTgChannelPosts,
  parseChannelPage,
  parseJinaChannelMarkdown,
  buildTelegramPageUrl,
  probeTgChannel,
  validateTgChannel,
  TgChannelError,
} from "../../server/core/services/tg";
import { classifyError } from "../../server/core/utils/errors";

// 让 tgChannelSettings 指向一个必然不存在的存储路径，保证单测不受本机 data/ 目录影响。
vi.hoisted(() => {
  process.env.PANHUB_TG_CHANNEL_SETTINGS_STORE = "./.tmp/vitest-tg-channel-settings/absent.json";
});
vi.mock("ofetch", () => ({ ofetch: Object.assign(vi.fn(), { raw: vi.fn() }) }));
const fetcher = vi.mocked(ofetch);
const fetcherRaw = (ofetch as unknown as { raw: ReturnType<typeof vi.fn> }).raw;

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../fixtures/tg/${name}`, import.meta.url)), "utf-8");
const channelPage = fixture("channel-page.html");
const notFoundPage = fixture("channel-not-found.html");
const privatePage = fixture("channel-private.html");
const structureChangedPage = fixture("channel-structure-changed.html");
const emptyChannelPage = fixture("channel-empty.html");

beforeEach(() => {
  fetcher.mockReset();
  fetcherRaw.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("parseChannelPage（脱敏 fixture 离线解析）", () => {
  it("正常解析：提取网盘链接、提取码、日期与标题，纯文本消息被丢弃", () => {
    const results = parseChannelPage(load(channelPage), "panhub_demo", "三体", 50);
    expect(results).toHaveLength(3);
    const quark = results.find((item) => item.message_id === "panhub_demo/101")!;
    expect(quark.links).toEqual([
      { type: "quark", url: "https://pan.quark.cn/s/8fH2kQrT", password: "9x2k" },
    ]);
    expect(quark.datetime).toBe("2026-08-01T10:00:00.000Z");
    expect(quark.title).toContain("三体");
    const baidu = results.find((item) => item.message_id === "panhub_demo/102")!;
    expect(baidu.links).toEqual([
      { type: "baidu", url: "https://pan.baidu.com/s/1AbCdEfGhIjK?pwd=q3w5", password: "" },
    ]);
    expect(results.find((item) => item.message_id === "panhub_demo/103")).toBeUndefined();
  });

  it("异常日期置空但不丢结果；非公开/伪装链接被过滤", () => {
    const results = parseChannelPage(load(channelPage), "panhub_demo", "三体", 50);
    const bad = results.find((item) => item.message_id === "panhub_demo/104")!;
    expect(bad.datetime).toBe("");
    expect(bad.links.map((link) => link.type)).toEqual(["aliyun"]);
    expect(bad.links[0]!.url).toBe("https://www.alipan.com/s/vAlId00");
  });

  it("关键词无匹配时返回空数组而不是报错", () => {
    const results = parseChannelPage(load(channelPage), "panhub_demo", "银河系漫游指南", 50);
    expect(results).toEqual([]);
  });

  it("链接后的 Telegram emoji 不会污染 URL 或制造重复链接", () => {
    const $ = load(`
      <div class="tgme_widget_message_wrap">
        <div class="tgme_widget_message" data-post="gotopan/1">
          <div class="tgme_widget_message_text">阿凡达 https://pan.quark.cn/s/demo📂</div>
          <a href="https://pan.quark.cn/s/demo"></a>
          <time datetime="2026-01-01T00:00:00Z"></time>
        </div>
      </div>`);
    const results = parseChannelPage($, "gotopan", "阿凡达", 20);
    expect(results[0]?.links).toEqual([{ type: "quark", url: "https://pan.quark.cn/s/demo", password: "" }]);
  });
});

describe("parseJinaChannelMarkdown（Jina Reader 独立适配器）", () => {
  it("解析消息链接、标题、描述和网盘链接，不依赖 Telegram DOM", () => {
    const results = parseJinaChannelMarkdown(
      fixture("channel-page.jina.md"),
      "panhub_demo",
      "三体",
      50,
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      message_id: "panhub_demo/101",
      datetime: "",
      title: "三体 电视剧版 全季",
      content: "三体故事简介，包含全部剧集。",
      links: [
        {
          type: "quark",
          url: "https://pan.quark.cn/s/8fH2kQrT",
          password: "",
        },
      ],
    });
  });

  it("没有公开网盘链接时丢弃消息", () => {
    expect(
      parseJinaChannelMarkdown(
        "Title: demo\n\nURL Source: https://t.me/s/demo?q=x\n\nMarkdown Content:\n[](https://t.me/demo/1)\n\n【标题】：x\n\n普通文本，没有网盘链接。",
        "demo",
        "x",
        20,
      ),
    ).toEqual([]);
  });
});

describe("Telegram 上游 URL", () => {
  it("把关键词放进 q，并在分页时同时保留 before", () => {
    expect(buildTelegramPageUrl("@demo", "兰香如故")).toBe(
      "https://t.me/s/demo?q=%E5%85%B0%E9%A6%99%E5%A6%82%E6%95%85",
    );
    expect(buildTelegramPageUrl("demo", "兰香如故", "123")).toBe(
      "https://t.me/s/demo?q=%E5%85%B0%E9%A6%99%E5%A6%82%E6%95%85&before=123",
    );
  });
});

describe("validateTgChannel（添加前公开性校验）", () => {
  it("公开 Telegram 页面校验通过", async () => {
    fetcher.mockResolvedValueOnce(channelPage);
    await expect(validateTgChannel("@Panhub_Demo")).resolves.toMatchObject({
      ok: true,
      channel: "panhub_demo",
      kind: "available",
      route: "telegram",
    });
  });

  it("真实 Telegram 页面中的 tg://resolve 不会被误判为不存在", async () => {
    fetcher.mockResolvedValueOnce(`<!doctype html>
      <html><head>
        <title>网盘资源分享频道 – Telegram</title>
        <meta property="al:ios:url" content="tg://resolve?domain=gotopan" />
      </head><body>
        <a href="tg://resolve?domain=gotopan">打开 Telegram</a>
        <div class="tgme_widget_message" data-post="gotopan/49078">
          <div class="tgme_widget_message_text">三体 https://pan.example/s/demo</div>
        </div>
      </body></html>`);
    await expect(validateTgChannel("gotopan")).resolves.toMatchObject({
      ok: true,
      channel: "gotopan",
      kind: "available",
      route: "telegram",
    });
  });

  it("私密邀请页校验失败，不会继续请求 Jina", async () => {
    fetcher.mockResolvedValueOnce(privatePage);
    await expect(validateTgChannel("demo")).resolves.toMatchObject({
      ok: false,
      kind: "channel_private",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("Telegram 联系页校验失败", async () => {
    fetcher.mockResolvedValueOnce(notFoundPage).mockRejectedValueOnce(new Error("jina unavailable"));
    await expect(validateTgChannel("nonexistent_demo")).resolves.toMatchObject({
      ok: false,
      kind: "channel_not_found",
    });
  });

  it("直连失败后可用 Jina 公开页面校验通过", async () => {
    fetcher.mockRejectedValueOnce(new Error("telegram unavailable")).mockResolvedValueOnce(fixture("channel-page.jina.md"));
    await expect(validateTgChannel("panhub_demo")).resolves.toMatchObject({
      ok: true,
      kind: "available",
      route: "jina",
    });
  });

  it("Jina 空页面不能绕过公开消息校验", async () => {
    fetcher.mockRejectedValueOnce(new Error("telegram unavailable")).mockResolvedValueOnce(
      "Title: Empty channel\n\nURL Source: https://t.me/s/empty\n\nMarkdown Content:\n暂无公开消息。",
    );
    await expect(validateTgChannel("empty")).resolves.toMatchObject({
      ok: false,
      kind: "structure_changed",
    });
  });
});

describe("classifyTgChannelPage（五种失败区分）", () => {
  it("结构变化：页面非空但没有消息节点时给出明确告警类别", () => {
    const changed = classifyTgChannelPage(structureChangedPage);
    expect(changed.ok).toBe(false);
    expect(changed.kind).toBe("structure_changed");
    expect(changed.reason).toContain("解析失败");
  });
  it("频道不存在：Telegram 联系页", () => {
    expect(classifyTgChannelPage(notFoundPage).kind).toBe("channel_not_found");
  });
  it("频道私有：邀请/加入页", () => {
    expect(classifyTgChannelPage(privatePage).kind).toBe("channel_private");
  });
  it("空公开频道（有频道信息无消息）也归入结构告警而不是静默无结果", () => {
    expect(classifyTgChannelPage(emptyChannelPage).kind).toBe("structure_changed");
  });
});

describe("fetchTgChannelPosts（离线抓取路径分类）", () => {
  it("按每频道策略与默认 fallback 抓取并解析 fixture 页面", async () => {
    fetcher.mockResolvedValue(channelPage);
    const results = await fetchTgChannelPosts("panhub_demo", "三体", { limitPerChannel: 50 });
    expect(results).toHaveLength(3);
    expect(fetcher).toHaveBeenCalledWith(
      "https://t.me/s/panhub_demo?q=%E4%B8%89%E4%BD%93",
      expect.objectContaining({ retry: 0, responseType: "text", signal: expect.any(AbortSignal) }),
    );
  });

  it.each([
    ["channel-structure-changed.html", "structure_changed"],
    ["channel-not-found.html", "channel_not_found"],
    ["channel-private.html", "channel_private"],
    ["channel-empty.html", "structure_changed"],
  ])("以 TgChannelError 抛出 %s 的失败类别", async (name, kind) => {
    fetcher.mockResolvedValue(fixture(name));
    const error = await fetchTgChannelPosts("panhub_demo", "三体").catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(TgChannelError);
    expect((error as TgChannelError).tgKind).toBe(kind);
  });

  it("onWarning 收到分类错误并保留已有结果", async () => {
    fetcher.mockResolvedValue(structureChangedPage);
    const warning = vi.fn();
    const results = await fetchTgChannelPosts("panhub_demo", "三体", { onWarning: warning });
    expect(results).toEqual([]);
    expect(warning).toHaveBeenCalledTimes(1);
    expect((warning.mock.calls[0]![0] as TgChannelError).tgKind).toBe("structure_changed");
  });

  it("网络失败归类为 network_error", async () => {
    fetcher.mockRejectedValue(new Error("connect timeout"));
    const error = await fetchTgChannelPosts("panhub_demo", "三体").catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(TgChannelError);
    expect((error as TgChannelError).tgKind).toBe("network_error");
  });
});

it("直连失败后能用真实形态的 Jina Markdown 解析", async () => {
    fetcher.mockRejectedValueOnce(new Error("network")).mockResolvedValue(
      fixture("channel-page.jina.md"),
    );
    const results = await fetchTgChannelPosts("panhub_demo", "三体");
    expect(results).toHaveLength(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://t.me/s/panhub_demo?q=%E4%B8%89%E4%BD%93",
    );
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      "https://r.jina.ai/https://t.me/s/panhub_demo?q=%E4%B8%89%E4%BD%93",
    );
  });

describe("probeTgChannel stages（诊断契约）", () => {
  it("直连成功：单阶段，不再尝试镜像", async () => {
    fetcherRaw.mockResolvedValue({ status: 200, headers: new Headers(), _data: channelPage });
    const result = await probeTgChannel("panhub_demo", "三体", 20);
    expect(fetcherRaw).toHaveBeenCalledTimes(1);
    expect(result.state).toBe("available");
    expect(result.results).toHaveLength(3);
    expect(result.failureKind).toBeUndefined();
    expect(result.stages).toEqual([
      {
        stage: "direct",
        durationMs: expect.any(Number),
        ok: true,
        url: "https://t.me/s/panhub_demo?q=%E4%B8%89%E4%BD%93",
        bytes: channelPage.length,
      },
    ]);
  });

  it("直连失败后按 Jina Markdown 适配器解析", async () => {
    fetcherRaw.mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValue({
      status: 200,
      headers: new Headers({ "content-type": "text/markdown" }),
      _data: fixture("channel-page.jina.md"),
    });
    const result = await probeTgChannel("panhub_demo", "三体", 20);
    expect(result.state).toBe("available");
    expect(result.results).toHaveLength(1);
    expect(result.route).toBe("jina");
    expect(result.stages[1]).toMatchObject({
      stage: "jina",
      ok: true,
      url: "https://r.jina.ai/https://t.me/s/panhub_demo?q=%E4%B8%89%E4%BD%93",
    });
  });

  it("直连失败后镜像成功：两个阶段且各自的成败与耗时", async () => {
    fetcherRaw.mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValue({
      status: 200,
      headers: new Headers(),
      _data: channelPage,
    });
    const result = await probeTgChannel("panhub_demo", "三体", 20);
    expect(result.state).toBe("available");
    expect(result.stages).toHaveLength(2);
    expect(result.stages[0]).toMatchObject({ stage: "direct", ok: false, error: "ECONNRESET" });
    expect(result.stages[1]).toMatchObject({
      stage: "jina",
      ok: true,
      url: "https://r.jina.ai/https://t.me/s/panhub_demo?q=%E4%B8%89%E4%BD%93",
      bytes: channelPage.length,
    });
    expect(result.failureKind).toBeUndefined();
  });

  it("两阶段都网络失败：state=error 且 failureKind=network_error", async () => {
    fetcherRaw.mockRejectedValue(new Error("ENOTFOUND"));
    const result = await probeTgChannel("panhub_demo", "三体", 20);
    expect(result.state).toBe("error");
    expect(result.failureKind).toBe("network_error");
    expect(result.results).toEqual([]);
    expect(result.stages).toHaveLength(2);
    expect(result.stages.every((stage) => !stage.ok && stage.error)).toBe(true);
  });

  it("页面可访问但结构变化：明确告警而不是静默无结果", async () => {
    fetcherRaw.mockResolvedValue({ status: 200, headers: new Headers(), _data: structureChangedPage });
    const result = await probeTgChannel("panhub_demo", "三体", 20);
    expect(result.state).toBe("warning");
    expect(result.failureKind).toBe("structure_changed");
    expect(result.message).toContain("解析失败");
    expect(result.stages[0]).toMatchObject({ ok: false, bytes: structureChangedPage.length });
  });

  it("频道不存在 / 频道私有给出对应 failureKind", async () => {
    fetcherRaw.mockResolvedValue({ status: 200, headers: new Headers(), _data: notFoundPage });
    const missing = await probeTgChannel("panhub_demo", "三体", 20);
    expect(missing.state).toBe("warning");
    expect(missing.failureKind).toBe("channel_not_found");

    fetcherRaw.mockResolvedValue({ status: 200, headers: new Headers(), _data: privatePage });
    const priv = await probeTgChannel("panhub_demo", "三体", 20);
    expect(priv.state).toBe("warning");
    expect(priv.failureKind).toBe("channel_private");
  });

  it("关键词无结果：页面正常但没有匹配链接", async () => {
    fetcherRaw.mockResolvedValue({ status: 200, headers: new Headers(), _data: channelPage });
    const result = await probeTgChannel("panhub_demo", "银河系漫游指南", 20);
    expect(result.state).toBe("warning");
    expect(result.failureKind).toBe("no_results");
    expect(result.message).toBe("频道可访问，但当前关键词没有提取到网盘链接");
  });

  it("fallback=direct 时只探测直连阶段", async () => {
    fetcherRaw.mockRejectedValue(new Error("ECONNRESET"));
    const result = await probeTgChannel("panhub_demo", "三体", 20, { fallback: "direct" });
    expect(fetcherRaw).toHaveBeenCalledTimes(1);
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]!.stage).toBe("direct");
  });
});

describe("TgChannelError 与搜索 warning 分类", () => {
  it("classifyError 保留机器可读 code，五种失败可区分", () => {
    const detail = classifyError(new TgChannelError("channel_not_found", "TG 频道 demo 不存在"), "tg:demo");
    expect(detail.type).toBe("validation_error");
    expect(detail.code).toBe("tg_channel_not_found");
    expect(classifyError(new TgChannelError("structure_changed", "结构变化")).type).toBe("parse_error");
    expect(classifyError(new TgChannelError("network_error", "网络失败")).type).toBe("network_error");
    expect(classifyError(new TgChannelError("channel_private", "私有")).code).toBe("tg_channel_private");
  });
});
