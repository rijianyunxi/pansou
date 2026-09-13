import { describe, expect, it } from "vitest";
import {
  copyTextToClipboard,
  failureKindDetail,
  failureKindLabel,
  failureKindTone,
  formatHtmlPretty,
  formatTgCharCount,
  normalizeTgStages,
  renderHighlightedHtml,
  tgStageBarPercent,
} from "../../utils/telegramProbeView";

describe("formatHtmlPretty", () => {
  it("indents nested elements and closes depth on closing tags", () => {
    const pretty = formatHtmlPretty("<html><head><title>t</title></head><body><p>hi</p></body></html>");
    expect(pretty).toBe(
      [
        "<html>",
        "  <head>",
        "    <title>",
        "      t",
        "    </title>",
        "  </head>",
        "  <body>",
        "    <p>",
        "      hi",
        "    </p>",
        "  </body>",
        "</html>",
      ].join("\n"),
    );
  });

  it("does not increase depth for void and self-closing tags", () => {
    const pretty = formatHtmlPretty('<div><br><img src="x.png"><span/>after</div>');
    const lines = pretty.split("\n");
    expect(lines).toEqual([
      "<div>",
      "  <br>",
      "  <img src=\"x.png\">",
      "  <span/>",
      "  after",
      "</div>",
    ]);
  });

  it("collapses whitespace in text and keeps comments, empty input safe", () => {
    expect(formatHtmlPretty("<div>\n  hello   world\n</div>")).toBe(
      ["<div>", "  hello world", "</div>"].join("\n"),
    );
    expect(formatHtmlPretty("<!-- note --><i>a</i>")).toBe(
      ["<!-- note -->", "<i>", "  a", "</i>"].join("\n"),
    );
    expect(formatHtmlPretty("")).toBe("");
  });
});

describe("renderHighlightedHtml", () => {
  it("escapes HTML so injected markup is inert, and only adds own <mark> tags", () => {
    const { html } = renderHighlightedHtml('<script>alert("x")</script>', { keyword: "" });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<mark");
  });

  it("highlights supported netdisk hosts and magnet links", () => {
    const source = [
      "https://pan.baidu.com/s/1abc?pwd=xyz",
      "https://www.alipan.com/s/abc",
      "https://pan.quark.cn/s/abc",
      "https://drive.uc.cn/s/abc",
      "https://123pan.com/s/abc",
      "magnet:?xt=urn:btih:0123456789abcdef&dn=name",
    ].join(" ");
    const { html, stats } = renderHighlightedHtml(source, { keyword: "" });
    expect(stats.links).toBe(6);
    expect((html.match(/<mark class="tg-hit-link">/g) ?? [])).toHaveLength(6);
    expect(html).toContain('<mark class="tg-hit-link">https://pan.baidu.com/s/1abc?pwd=xyz</mark>');
    expect(html).toContain('<mark class="tg-hit-link">magnet:?xt=urn:btih:0123456789abcdef&amp;dn=name</mark>');
  });

  it("does not treat unrelated hosts as netdisk links", () => {
    const { stats } = renderHighlightedHtml("https://example.com/a https://x115.com/b", { keyword: "" });
    expect(stats.links).toBe(0);
  });

  it("highlights keyword case-insensitively and message node tokens", () => {
    const source = 'div class="tgme_widget_message_wrap" and tgme_widget_message_text, keyword ThreeBody here';
    const { html, stats } = renderHighlightedHtml(source, { keyword: "threebody" });
    expect(stats.nodes).toBe(2);
    expect(stats.keywords).toBe(1);
    expect(html).toContain('<mark class="tg-hit-node">tgme_widget_message_wrap</mark>');
    expect(html).toContain('<mark class="tg-hit-keyword">ThreeBody</mark>');
  });

  it("keeps links whole: keyword inside a URL is part of the link mark only", () => {
    const { html, stats } = renderHighlightedHtml("https://pan.baidu.com/s/threebody", { keyword: "threebody" });
    expect(stats.links).toBe(1);
    expect(stats.keywords).toBe(0);
    expect((html.match(/<mark /g) ?? [])).toHaveLength(1);
    expect(html).toContain("tg-hit-link");
  });

  it("returns empty output for empty input", () => {
    expect(renderHighlightedHtml("", { keyword: "x" }).html).toBe("");
  });
});

describe("normalizeTgStages / tgStageBarPercent", () => {
  it("normalizes missing fields with defaults", () => {
    const rows = normalizeTgStages([
      { stage: "direct", durationMs: 120, ok: true, url: "https://t.me/s/x", bytes: 5000 },
      { stage: "jina" },
      null,
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ stage: "direct", durationMs: 120, ok: true, bytes: 5000, error: "" });
    expect(rows[1]).toMatchObject({ stage: "jina", durationMs: null, ok: false, bytes: null, label: "Jina 镜像" });
    expect(rows[2]!.stage).toBe("direct");
    expect(normalizeTgStages(undefined)).toEqual([]);
    expect(normalizeTgStages("bad")).toEqual([]);
  });

  it("computes relative bar widths with a visible minimum and zero for null", () => {
    const rows = normalizeTgStages([{ stage: "direct", durationMs: 400, ok: true }, { stage: "jina", durationMs: 100, ok: false }]);
    expect(tgStageBarPercent(rows, 400)).toBe(100);
    expect(tgStageBarPercent(rows, 100)).toBe(25);
    expect(tgStageBarPercent(rows, null)).toBe(0);
    expect(tgStageBarPercent([], 10)).toBe(100);
  });
});

describe("failureKind copy and tone", () => {
  it("maps the five contract kinds to readable text", () => {
    for (const kind of ["channel_not_found", "channel_private", "network_error", "structure_changed", "no_results"] as const) {
      expect(failureKindLabel(kind)).not.toBe(kind);
      expect(failureKindDetail(kind).length).toBeGreaterThan(0);
    }
    expect(failureKindLabel(undefined)).toBe("");
    expect(failureKindLabel("future_kind")).toBe("future_kind");
  });

  it("picks a tone per failure kind", () => {
    expect(failureKindTone("network_error")).toBe("bad");
    expect(failureKindTone("no_results")).toBe("info");
    expect(failureKindTone("channel_private")).toBe("warn");
  });
});

describe("formatTgCharCount", () => {
  it("formats counts and falls back for missing values", () => {
    expect(formatTgCharCount(30000)).toBe("30,000 字符");
    expect(formatTgCharCount(null)).toBe("—");
    expect(formatTgCharCount(undefined)).toBe("—");
  });
});

describe("copyTextToClipboard", () => {
  it("refuses empty text without touching the DOM", async () => {
    const result = await copyTextToClipboard("");
    expect(result.ok).toBe(false);
    expect(result.method).toBe("none");
  });

  it("degrades gracefully when no clipboard API is available", async () => {
    const result = await copyTextToClipboard("some payload");
    expect(["clipboard-api", "exec-command", "none"]).toContain(result.method);
    expect(result.message.length).toBeGreaterThan(0);
  });
});
