import { describe, expect, it } from "vitest";
import type { UpstreamDefinition } from "../../types/source";
import { buildSourceDebugUrl } from "../../utils/upstreamDebugUrl";

function source(id: string): UpstreamDefinition {
  const definitions: Record<string, UpstreamDefinition> = {
    nyaa: { id: "nyaa", name: "Nyaa", description: "", url: "https://nyaa.si/", method: "GET", format: "html", plugin: "nyaa", adapter: "", color: "", initials: "N", mapping: { items: "", title: "", url: "", type: "", password: "" }, request: { query: { f: "0", c: "0_0", q: "{{keyword}}", s: "seeders", o: "desc" } } },
    hunhepan: { id: "hunhepan", name: "Hunhepan", description: "", url: "https://example.com/search", method: "POST", format: "json", plugin: "hunhepan", adapter: "", color: "", initials: "H", mapping: { items: "", title: "", url: "", type: "", password: "" }, request: { body: { q: "{{keyword}}", page: 1, exact: true, size: 30, filter: true } } },
    duoduo: { id: "duoduo", name: "Duoduo", description: "", url: "https://tv.yydsys.top/index.php/vod/search/wd/{{keyword}}.html", method: "GET", format: "html", plugin: "duoduo", adapter: "", color: "", initials: "D", mapping: { items: "", title: "", url: "", type: "", password: "" } },
    pansearch: { id: "pansearch", name: "PanSearch", description: "", url: "https://www.pansearch.me/search", method: "GET", format: "json", plugin: "pansearch", adapter: "", color: "", initials: "P", mapping: { items: "", title: "", url: "", type: "", password: "" }, request: { query: { keyword: "{{keyword}}", offset: "0" } } },
  };
  const value = definitions[id];
  if (!value) throw new Error(`Missing fixture ${id}`);
  return value;
}

describe("buildSourceDebugUrl", () => {
  it("renders a GET URL with every configured query parameter", () => {
    const url = new URL(buildSourceDebugUrl(source("nyaa"), "三体"));
    expect(url.origin + url.pathname).toBe("https://nyaa.si/");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      f: "0",
      c: "0_0",
      q: "三体",
      s: "seeders",
      o: "desc",
    });
  });

  it("mirrors POST body fields into a browser-openable parameter preview", () => {
    const url = new URL(buildSourceDebugUrl(source("hunhepan"), "三体"));
    expect(url.searchParams.get("q")).toBe("三体");
    expect(url.searchParams.get("page")).toBe("1");
    expect(url.searchParams.get("exact")).toBe("true");
    expect(url.searchParams.get("size")).toBe("30");
    expect(url.searchParams.get("filter")).toBe("true");
  });

  it("renders known path templates and falls back for unknown stage variables", () => {
    expect(buildSourceDebugUrl(source("duoduo"), "三体")).toContain("/wd/%E4%B8%89%E4%BD%93.html");

    const url = new URL(buildSourceDebugUrl(source("pansearch"), "三体"));
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("keyword")).toBe("三体");
    expect(url.searchParams.get("offset")).toBe("0");
  });

  it("includes the executor defaults when advanced request fields are omitted", () => {
    const getSource = { ...source("nyaa"), request: undefined };
    expect(new URL(buildSourceDebugUrl(getSource, "默认词")).searchParams.get("keyword")).toBe("默认词");

    const postSource = { ...source("hunhepan"), request: undefined };
    expect(new URL(buildSourceDebugUrl(postSource, "默认词")).searchParams.get("keyword")).toBe("默认词");
  });

  it("never exposes sensitive parameter values", () => {
    const custom: UpstreamDefinition = {
      ...source("nyaa"),
      request: {
        query: { q: "{{keyword}}", token: "private-token" },
        body: { nested: { password: "private-password" } },
      },
      method: "POST",
    };
    const url = new URL(buildSourceDebugUrl(custom, "test"));
    expect(url.searchParams.get("token")).toBe("[REDACTED]");
    expect(url.searchParams.get("nested")).toBe('{"password":"[REDACTED]"}');
    expect(url.toString()).not.toContain("private-token");
    expect(url.toString()).not.toContain("private-password");
  });
});
