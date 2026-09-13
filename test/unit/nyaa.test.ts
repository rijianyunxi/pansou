import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ofetch } from "ofetch";
import type { PluginSearchContext } from "../../server/core/plugins/manager";
import {
  NyaaPlugin,
  buildSearchUrl,
  parseNyaaTimestamp,
  parseSearchPage,
  rowToSearchResult,
} from "../../server/core/plugins/nyaa";

vi.mock("ofetch", () => ({ ofetch: vi.fn() }));
const fetcher = vi.mocked(ofetch);

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "nyaa");
const page1Html = readFileSync(join(fixturesDir, "search-results-page1.html"), "utf8");
const emptyHtml = readFileSync(join(fixturesDir, "search-results-empty.html"), "utf8");
// 固定"当前时间"，让相对时间解析的断言完全确定（2026-09-12T00:00:00Z）。
const NOW = Date.UTC(2026, 8, 12, 0, 0, 0);

function makeContext(options: { keyword?: string; timeoutMs?: number; signal?: AbortSignal } = {}): PluginSearchContext {
  return {
    searchId: "test-search",
    keyword: options.keyword ?? "example",
    keywordVariants: [options.keyword ?? "example"],
    timeoutMs: options.timeoutMs ?? 5000,
    signal: options.signal ?? new AbortController().signal,
    ext: {},
  };
}

/** 用本地 fixture 替代真实网络请求的插件桩：记录请求 URL 并按页码返回页面。 */
class FixtureNyaaPlugin extends NyaaPlugin {
  readonly pages = new Map<number, string>();
  readonly requestedUrls: string[] = [];

  protected override async fetchText(url: string, _signal: AbortSignal, _timeoutMs: number): Promise<string> {
    this.requestedUrls.push(url);
    const page = Number(new URL(url).searchParams.get("p") || "1");
    const html = this.pages.get(page);
    if (html === undefined) throw new Error(`fixture missing for page ${page}`);
    return html;
  }
}

class CappedNyaaPlugin extends FixtureNyaaPlugin {
  constructor(private readonly cap: number) {
    super();
  }
  protected override resolveMaxResults(): number {
    return this.cap;
  }
}

class SlowFixtureNyaaPlugin extends FixtureNyaaPlugin {
  protected override async fetchText(url: string, signal: AbortSignal, timeoutMs: number): Promise<string> {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return super.fetchText(url, signal, timeoutMs);
  }
}

class AbortAfterFirstPagePlugin extends FixtureNyaaPlugin {
  constructor(private readonly controller: AbortController) {
    super();
  }
  protected override async fetchText(url: string, signal: AbortSignal, timeoutMs: number): Promise<string> {
    const html = await super.fetchText(url, signal, timeoutMs);
    this.controller.abort();
    return html;
  }
}

/** 构造一个只有 1 行结果、分页指向指定页码的最小搜索页。 */
function singleRowPage(id: number, nextPage: number | null): string {
  const pagination = nextPage === null
    ? ""
    : `<ul class="pagination"><li><a href="?q=example&amp;p=${nextPage}">${nextPage}</a></li></ul>`;
  const magnetHash = `${String(id).padStart(6, "0")}abcdef0123456789abcdef0123456789`;
  return `<!DOCTYPE html><html><body><table class="torrent-list"><tbody>
    <tr class="default">
      <td class="text-center"><a href="/?c=1_2" title="Anime - English-translated"><img class="category-icon" src="/static/img/icons/nyaa/1_2.png" alt="Anime"></a></td>
      <td class="text-center" colspan="2"><a href="/view/${id}" title="Example ${id}">Example ${id}</a></td>
      <td class="text-center"><a href="magnet:?xt=urn:btih:${magnetHash}&amp;dn=example"><i class="fa fa-fw fa-magnet"></i></a></td>
      <td class="text-center">1.0 GiB</td>
      <td class="text-center" data-timestamp="1726000000">2024-09-10 20:26</td>
      <td class="text-center">10</td>
      <td class="text-center">1</td>
      <td class="text-center">2</td>
    </tr>
  </tbody></table>${pagination}</body></html>`;
}

const cloudflareHtml = `<!DOCTYPE html><html><head><title>Just a moment...</title></head>
<body>Checking your browser before accessing. challenge-platform scripts follow.</body></html>`;

const noTableHtml = `<!DOCTYPE html><html><body><h1>Welcome to example</h1><p>Some other layout.</p></body></html>`;

const emptyTableHtml = `<!DOCTYPE html><html><body><table class="torrent-list"><tbody></tbody></table></body></html>`;

const linklessRowPage = `<!DOCTYPE html><html><body><table class="torrent-list"><tbody>
  <tr class="default">
    <td class="text-center"><a href="/?c=1_2" title="Anime"><img class="category-icon" src="/x.png" alt="Anime"></a></td>
    <td class="text-center" colspan="2"><a href="/view/9001000" title="No Links Item">No Links Item</a></td>
    <td class="text-center"><i class="fa fa-fw fa-magnet"></i></td>
    <td class="text-center">1.0 GiB</td>
    <td class="text-center" data-timestamp="1726000000">2024-09-10 20:26</td>
    <td class="text-center">10</td>
    <td class="text-center">1</td>
    <td class="text-center">2</td>
  </tr>
</tbody></table></body></html>`;

/** 第 2 页：含一条与第 1 页重复的种子（同 id 不同标题）和一条新种子，分页只剩回链 p=1。 */
const page2Html = `<!DOCTYPE html><html><body><table class="torrent-list"><tbody>
  <tr class="default">
    <td class="text-center"><a href="/?c=1_2" title="Anime"><img class="category-icon" src="/x.png" alt="Anime"></a></td>
    <td class="text-center" colspan="2"><a href="/view/9000001" title="Duplicate 9000001">Duplicate 9000001</a></td>
    <td class="text-center"><a href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&amp;dn=dup"><i class="fa fa-fw fa-magnet"></i></a></td>
    <td class="text-center">1.3 GiB</td>
    <td class="text-center" data-timestamp="1726000000">2024-09-10 20:26</td>
    <td class="text-center">1</td>
    <td class="text-center">1</td>
    <td class="text-center">1</td>
  </tr>
  <tr class="default">
    <td class="text-center"><a href="/?c=1_2" title="Anime"><img class="category-icon" src="/x.png" alt="Anime"></a></td>
    <td class="text-center" colspan="2"><a href="/view/9000006" title="Example New Item">Example New Item</a></td>
    <td class="text-center"><a href="magnet:?xt=urn:btih:9999999999999999999999999999999999999999&amp;dn=new"><i class="fa fa-fw fa-magnet"></i></a></td>
    <td class="text-center">700 MiB</td>
    <td class="text-center" data-timestamp="1726000500">2024-09-10 20:35</td>
    <td class="text-center">9</td>
    <td class="text-center">0</td>
    <td class="text-center">3</td>
  </tr>
</tbody></table>
<ul class="pagination"><li><a href="?q=example&amp;p=1">1</a></li></ul></body></html>`;

beforeEach(() => {
  fetcher.mockReset();
});

describe("buildSearchUrl", () => {
  it("builds the page-1 search URL with category filter and seeders sort", () => {
    expect(buildSearchUrl("one piece")).toBe(
      "https://nyaa.si/?f=0&c=0_0&q=one+piece&s=seeders&o=desc"
    );
  });

  it("appends the p parameter only for pages after the first", () => {
    expect(buildSearchUrl("one piece", 2)).toBe(
      "https://nyaa.si/?f=0&c=0_0&q=one+piece&s=seeders&o=desc&p=2"
    );
    expect(buildSearchUrl("one piece", 1)).not.toContain("p=");
  });

  it("percent-encodes non-ASCII keywords while staying readable via URL parsing", () => {
    const url = buildSearchUrl("轻音少女");
    expect(url).toContain("q=%E8%BD%BB%E9%9F%B3%E5%B0%91%E5%A5%B3");
    expect(new URL(url).searchParams.get("q")).toBe("轻音少女");
  });

  it("encodes reserved characters in the keyword", () => {
    const url = buildSearchUrl("a&b c");
    expect(url).toContain("q=a%26b+c");
    expect(new URL(url).searchParams.get("q")).toBe("a&b c");
  });
});

describe("parseNyaaTimestamp", () => {
  it("converts the data-timestamp attribute (unix seconds) to ISO 8601", () => {
    expect(parseNyaaTimestamp("2024-09-10 20:26", "1726000000", NOW)).toBe(
      "2024-09-10T20:26:40.000Z"
    );
  });

  it("accepts millisecond timestamps as well", () => {
    expect(parseNyaaTimestamp("ignored", "1726000000000", NOW)).toBe("2024-09-10T20:26:40.000Z");
  });

  it("falls back to relative time text", () => {
    expect(parseNyaaTimestamp("3 hours ago", undefined, NOW)).toBe("2026-09-11T21:00:00.000Z");
    expect(parseNyaaTimestamp("2 weeks ago", undefined, NOW)).toBe(
      new Date(NOW - 14 * 24 * 60 * 60 * 1000).toISOString()
    );
    expect(parseNyaaTimestamp("just now", undefined, NOW)).toBe(new Date(NOW).toISOString());
    expect(parseNyaaTimestamp("yesterday", undefined, NOW)).toBe(
      new Date(NOW - 24 * 60 * 60 * 1000).toISOString()
    );
  });

  it("falls back to the absolute UTC date text", () => {
    expect(parseNyaaTimestamp("2026-09-01 12:00", undefined, NOW)).toBe("2026-09-01T12:00:00.000Z");
  });

  it("discards invalid, pre-2005 and future timestamps", () => {
    expect(parseNyaaTimestamp("garbage-time", "not-a-number", NOW)).toBe("");
    expect(parseNyaaTimestamp("garbage-time", undefined, NOW)).toBe("");
    // 2001-09-09：早于 2005-01-01 下限。
    expect(parseNyaaTimestamp("", "1000000000", NOW)).toBe("");
    // 晚于 now+24h：视为异常。
    expect(parseNyaaTimestamp("", String(Math.floor(NOW / 1000) + 10 * 86400), NOW)).toBe("");
  });
});

describe("parseSearchPage with the recorded nyaa.si layout", () => {
  const page = parseSearchPage(page1Html, 1, NOW);

  it("detects a results page and the next page from pagination links", () => {
    expect(page.kind).toBe("results");
    expect(page.nextPage).toBe(2);
    expect(page.items).toHaveLength(5);
    expect(parseSearchPage(page1Html, 2, NOW).nextPage).toBe(3);
    expect(parseSearchPage(page1Html, 3, NOW).nextPage).toBeNull();
  });

  it("maps every field of a normal row", () => {
    const row = page.items[0]!;
    expect(row.torrentId).toBe("9000001");
    expect(row.title).toBe("[ExampleSubs] Example Anime - 01 (1080p) [DEADBEEF].mkv");
    expect(row.magnet.startsWith("magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&")).toBe(true);
    expect(row.torrentUrl).toBe("https://nyaa.si/download/9000001.torrent");
    expect(row.size).toBe("1.3 GiB");
    expect(row.datetime).toBe("2024-09-10T20:26:40.000Z");
    expect(row.seeders).toBe(797);
    expect(row.leechers).toBe(10);
    expect(row.downloads).toBe(10941);
  });

  it("parses relative dates and rows without a torrent file link", () => {
    const row = page.items[1]!;
    expect(row.torrentId).toBe("9000002");
    expect(row.datetime).toBe("2026-09-11T21:00:00.000Z");
    expect(row.magnet.startsWith("magnet:?xt=urn:btih:fedcba98")).toBe(true);
    expect(row.torrentUrl).toBe("");
    expect(row.leechers).toBe(0);
  });

  it("uses the title link instead of the comments link and drops broken dates", () => {
    const row = page.items[2]!;
    expect(row.title).toBe("[ExampleRaw] Example Anime OVA [CAFEF00D].mkv");
    expect(row.datetime).toBe("");
    expect(row.seeders).toBe(1024);
    expect(row.downloads).toBe(3300);
  });

  it("keeps linkless rows at parse level but drops them at conversion", () => {
    const row = page.items[3]!;
    expect(row.title).toBe("[ExampleTeam] Example Game Repack");
    expect(row.magnet).toBe("");
    expect(row.torrentUrl).toBe("");
    expect(rowToSearchResult(row)).toBeNull();
  });

  it("parses the absolute UTC date fallback and absolutizes torrent links", () => {
    const row = page.items[4]!;
    expect(row.datetime).toBe("2026-09-01T12:00:00.000Z");
    expect(row.torrentUrl).toBe("https://nyaa.si/download/9000005.torrent");
  });
});

describe("parseSearchPage failure semantics", () => {
  it("treats the 'No results found' page as a genuine empty result", () => {
    expect(parseSearchPage(emptyHtml, 1, NOW)).toEqual({ kind: "empty", items: [], nextPage: null });
  });

  it("throws a distinct error for Cloudflare challenge pages", () => {
    expect(() => parseSearchPage(cloudflareHtml, 1, NOW)).toThrow(/Cloudflare/);
  });

  it("throws when the torrent-list table is missing", () => {
    expect(() => parseSearchPage(noTableHtml, 1, NOW)).toThrow(/结构可能已变化/);
    expect(() => parseSearchPage(noTableHtml, 1, NOW)).toThrow(/torrent-list/);
  });

  it("throws when the table exists but no row can be parsed", () => {
    expect(() => parseSearchPage(emptyTableHtml, 1, NOW)).toThrow(/0 行可解析/);
  });
});

describe("NyaaPlugin.search pagination and results", () => {
  it("follows pagination, merges pages and deduplicates by torrent id", async () => {
    const plugin = new FixtureNyaaPlugin();
    plugin.pages.set(1, page1Html);
    plugin.pages.set(2, page2Html);

    const results = await plugin.search(makeContext());

    expect(plugin.requestedUrls[0]).toBe(buildSearchUrl("example", 1));
    expect(plugin.requestedUrls[1]).toBe(buildSearchUrl("example", 2));
    expect(results).toHaveLength(5);
    expect(results.map((r) => r.unique_id)).toEqual([
      "nyaa-9000001",
      "nyaa-9000002",
      "nyaa-9000003",
      "nyaa-9000005",
      "nyaa-9000006",
    ]);
    expect(results.some((r) => r.title === "Duplicate 9000001")).toBe(false);
  });

  it("maps content and links for torrent-class resources", async () => {
    const plugin = new FixtureNyaaPlugin();
    plugin.pages.set(1, page1Html);
    plugin.pages.set(2, page2Html);

    const results = await plugin.search(makeContext());

    expect(results[0]!.content).toBe("Size: 1.3 GiB | Seeders: 797 | Leechers: 10 | Downloads: 10941");
    expect(results[0]!.datetime).toBe("2024-09-10T20:26:40.000Z");
    expect(results[0]!.links).toEqual([
      { type: "magnet", url: expect.stringMatching(/^magnet:\?xt=urn:btih:/), password: "" },
      { type: "torrent", url: "https://nyaa.si/download/9000001.torrent", password: "" },
    ]);
    expect(results[1]!.links).toHaveLength(1);
    expect(results[1]!.links[0]!.type).toBe("magnet");
    expect(results[2]!.content).toBe("Size: 2.2 GiB | Seeders: 1024 | Leechers: 7 | Downloads: 3300");
    expect(results[2]!.datetime).toBe("");
    // 相对时间行在 search 级别也应得到一个 ISO 时间。
    expect(results[1]!.datetime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("stops when the pagination offers no next page", async () => {
    const plugin = new FixtureNyaaPlugin();
    plugin.pages.set(1, page1Html);
    plugin.pages.set(2, page2Html);
    await plugin.search(makeContext());
    expect(plugin.requestedUrls).toHaveLength(2);
  });

  it("stops once maxResults is reached and skips further pages", async () => {
    const plugin = new CappedNyaaPlugin(2);
    plugin.pages.set(1, page1Html);
    plugin.pages.set(2, page2Html);

    const results = await plugin.search(makeContext());

    expect(results).toHaveLength(2);
    expect(plugin.requestedUrls).toHaveLength(1);
  });

  it("caps pagination at MAX_PAGES to avoid runaway requests", async () => {
    const plugin = new FixtureNyaaPlugin();
    for (let page = 1; page <= 8; page++) {
      plugin.pages.set(page, singleRowPage(8000000 + page, page < 8 ? page + 1 : null));
    }

    const results = await plugin.search(makeContext());

    expect(plugin.requestedUrls).toHaveLength(5);
    expect(plugin.requestedUrls[4]).toBe(buildSearchUrl("example", 5));
    expect(results).toHaveLength(5);
  });

  it("stops paginating when the time budget for the next page is exhausted", async () => {
    const plugin = new SlowFixtureNyaaPlugin();
    plugin.pages.set(1, singleRowPage(8000001, 2));
    plugin.pages.set(2, singleRowPage(8000002, 3));
    plugin.pages.set(3, singleRowPage(8000003, null));

    const results = await plugin.search(makeContext({ timeoutMs: 40 }));

    expect(plugin.requestedUrls).toHaveLength(1);
    expect(results).toHaveLength(1);
  });

  it("stops following pagination when the signal is aborted mid-run", async () => {
    const controller = new AbortController();
    const plugin = new AbortAfterFirstPagePlugin(controller);
    plugin.pages.set(1, singleRowPage(8000001, 2));
    plugin.pages.set(2, singleRowPage(8000002, null));

    await expect(plugin.search(makeContext({ signal: controller.signal }))).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(plugin.requestedUrls).toHaveLength(1);
  });

  it("returns [] for a genuine empty results page", async () => {
    const plugin = new FixtureNyaaPlugin();
    plugin.pages.set(1, emptyHtml);
    expect(await plugin.search(makeContext())).toEqual([]);
    expect(plugin.requestedUrls).toHaveLength(1);
  });

  it("surfaces Cloudflare blocks instead of returning empty results", async () => {
    const plugin = new FixtureNyaaPlugin();
    plugin.pages.set(1, cloudflareHtml);
    await expect(plugin.search(makeContext())).rejects.toThrow(/Cloudflare/);
  });

  it("throws a structure-changed error when rows exist but no links resolve", async () => {
    const plugin = new FixtureNyaaPlugin();
    plugin.pages.set(1, linklessRowPage);
    await expect(plugin.search(makeContext())).rejects.toThrow(/磁力\/种子链接/);
  });
});

describe("NyaaPlugin.fetchText error semantics (ofetch mocked)", () => {
  it("wraps HTTP failures into a nyaa-prefixed error with the status code", async () => {
    const failure = new Error("Service Unavailable");
    (failure as Error & { statusCode?: number }).statusCode = 503;
    fetcher.mockRejectedValue(failure);

    const plugin = new NyaaPlugin();
    await expect(plugin.search(makeContext())).rejects.toThrow(
      "nyaa: 搜索页请求失败 (HTTP 503)"
    );
    expect(fetcher).toHaveBeenCalledWith(
      buildSearchUrl("example", 1),
      expect.objectContaining({
        retry: 0,
        signal: expect.any(AbortSignal),
        timeout: expect.any(Number),
      })
    );
  });

  it("keeps the upstream error message for non-HTTP failures", async () => {
    fetcher.mockRejectedValue(new Error("ECONNREFUSED"));
    const plugin = new NyaaPlugin();
    await expect(plugin.search(makeContext())).rejects.toThrow("nyaa: 搜索页请求失败 (ECONNREFUSED)");
  });

  it("propagates cancellation unwrapped", async () => {
    const controller = new AbortController();
    fetcher.mockImplementation(() => {
      controller.abort();
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    const plugin = new NyaaPlugin();
    await expect(plugin.search(makeContext({ signal: controller.signal }))).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
