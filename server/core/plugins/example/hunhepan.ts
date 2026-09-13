import { CodeSearchPlugin, type PluginSearchContext } from "../manager";
import type { SearchResult } from "../../types/models";
import type { UpstreamDefinition } from "../../../../config/upstreams";
import { fetchRawWithRetry } from "../../utils/fetch";
import { parseConfiguredUpstreamResponse } from "../../parsers/upstream";
import { getConfiguredUpstream } from "../../services/upstreamCatalog";
import { normalizeUpstreamJson } from "../../../../utils/upstreamAdapter";

type HunhepanItem = {
  disk_id: string;
  disk_name: string;
  disk_pass: string;
  disk_type: string;
  files: string;
  doc_id: string;
  share_user: string;
  shared_time: string; // "2025-07-07 13:19:48"
  link: string;
  enabled: boolean;
  weight: number;
  status: number;
};

type HunhepanApiResult =
  | { kind: "items"; items: HunhepanItem[] }
  | { kind: "results"; results: SearchResult[] };

type HunhepanResponse = {
  code: number;
  msg: string;
  data: {
    total: number;
    per_size: number;
    list: HunhepanItem[];
  };
};

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGES = 2; // 适度保守，避免过多请求

export class HunhepanPlugin extends CodeSearchPlugin {
  constructor() {
    super({ id: "hunhepan", name: "hunhepan", priority: 3 });
  }

  override async search(context: PluginSearchContext): Promise<SearchResult[]> {
    const { keyword, signal } = context;
    const timeout = context.timeoutMs;
    const source = getConfiguredUpstream("hunhepan");
    if (!source || source.enabled === false) return [];
    const allItems: HunhepanItem[] = [];
    const normalized: SearchResult[] = [];
    // Endpoint, method and response format are catalog configuration. The
    // Core handler only supplies the Hunhepan request/normalization capability.
    const apis = [source.url];
    const tasks = apis.map((api) => this.searchApi(api, keyword, signal, timeout, source.method, source.format, source.mapping));
    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status !== "fulfilled") {
        continue;
      }
      if (result.value.kind === "results") normalized.push(...result.value.results);
      else allItems.push(...result.value.items);
    }
    // A configured transform owns the normalized output. Never mix its output
    // with the compatibility adapter for the same upstream.
    if (normalized.length || source.transform?.trim()) return normalized;
    const unique = this.deduplicate(allItems);
    return this.convertResults(unique);
  }

  private async searchApi(
    apiUrl: string,
    keyword: string,
    signal: AbortSignal,
    timeoutMs: number,
    method: "GET" | "POST",
    format: "json" | "html",
    mapping: UpstreamDefinition["mapping"],
  ): Promise<HunhepanApiResult> {
    const pageTasks: Array<Promise<HunhepanApiResult>> = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const body = {
        q: keyword, exact: true, page, size: DEFAULT_PAGE_SIZE, type: "",
        time: "", from: "web", user_id: 0, filter: true,
      } as const;
      let requestUrl = apiUrl;
      if (method === "GET") {
        const parsed = new URL(apiUrl);
        parsed.searchParams.set("q", keyword);
        parsed.searchParams.set("page", String(page));
        requestUrl = parsed.toString();
      }
      const headers: Record<string, string> = {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      };
      pageTasks.push(
        fetchRawWithRetry(
          requestUrl,
          { method, body: method === "POST" ? JSON.stringify(body) : undefined, headers, signal },
          { maxRetries: 0, timeout: Math.max(3000, timeoutMs || 10000), signal },
        )
          .then(async (rawBody) => {
            if (format !== "json") {
              const configured = await parseConfiguredUpstreamResponse("hunhepan", rawBody, format, { keyword, rawBody, url: apiUrl, page });
              return configured ? { kind: "results", results: configured } as const : { kind: "items", items: [] as HunhepanItem[] } as const;
            }
            const resp = JSON.parse(rawBody) as HunhepanResponse;
            if (!resp || resp.code !== 200) return { kind: "items", items: [] as HunhepanItem[] } as const;
            const configured = await parseConfiguredUpstreamResponse("hunhepan", resp, format, {
              keyword,
              rawBody,
              url: apiUrl,
              page,
            });
            if (configured) return { kind: "results", results: configured } as const;
            if (mapping.items !== "data.list" || mapping.title !== "disk_name" || mapping.url !== "link") {
              return { kind: "results", results: normalizeUpstreamJson(resp, mapping, "hunhepan") } as const;
            }
            return { kind: "items", items: resp.data?.list || [] } as const;
          })
          .catch(() => {
            return { kind: "items", items: [] as HunhepanItem[] } as const;
          })
      );
    }

    const pages = await Promise.all(pageTasks);
    if (pages.some((page) => page.kind === "results")) {
      return {
        kind: "results",
        results: pages.flatMap((page) => page.kind === "results" ? page.results : []),
      };
    }
    return { kind: "items", items: pages.flatMap((page) => page.kind === "items" ? page.items : []) };
  }

  private deduplicate(items: HunhepanItem[]): HunhepanItem[] {
    const map = new Map<string, HunhepanItem>();
    for (const item of items) {
      const cleanedName = this.cleanTitle(item.disk_name);
      const clone: HunhepanItem = { ...item, disk_name: cleanedName };
      let key = "";
      if (clone.disk_id) key = clone.disk_id;
      else if (clone.link) key = `${clone.link}|${cleanedName}`;
      else key = `${cleanedName}|${clone.disk_type}`;

      if (!map.has(key)) {
        map.set(key, clone);
      } else {
        const existing = map.get(key)!;
        let existingScore = (existing.files || "").length;
        let newScore = (clone.files || "").length;
        if (!existing.disk_pass && clone.disk_pass) newScore += 5;
        if (!existing.shared_time && clone.shared_time) newScore += 3;
        if (newScore > existingScore) map.set(key, clone);
      }
    }
    return Array.from(map.values());
  }

  private convertResults(items: HunhepanItem[]): SearchResult[] {
    const out: SearchResult[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (!item) continue;
      const linkType = this.convertDiskType(item.disk_type);
      const uniqueId = `hunhepan-${item.disk_id || i}`;
      const datetime = this.parseTime(item.shared_time);
      out.push({
        message_id: "",
        unique_id: uniqueId,
        channel: "",
        datetime,
        title: this.cleanTitle(item.disk_name),
        content: item.files,
        links: [
          {
            type: linkType,
            url: item.link,
            password: item.disk_pass || "",
          },
        ],
      });
    }
    return out;
  }

  private convertDiskType(diskType: string): string {
    switch (diskType) {
      case "BDY":
        return "baidu";
      case "ALY":
        return "aliyun";
      case "QUARK":
        return "quark";
      case "TIANYI":
        return "tianyi";
      case "UC":
        return "uc";
      case "CAIYUN":
        return "mobile";
      case "115":
        return "115";
      case "XUNLEI":
        return "xunlei";
      case "123PAN":
        return "123";
      case "PIKPAK":
        return "pikpak";
      default:
        return "others";
    }
  }

  private cleanTitle(title: string): string {
    const replacements: Record<string, string> = {
      "<em>": "",
      "</em>": "",
      "<b>": "",
      "</b>": "",
      "<strong>": "",
      "</strong>": "",
      "<i>": "",
      "</i>": "",
    };
    let result = title || "";
    for (const [tag, repl] of Object.entries(replacements)) {
      result = result.split(tag).join(repl);
    }
    return result.trim();
  }

  private parseTime(t: string): string {
    if (!t) return "";
    const iso = t.replace(" ", "T") + "Z";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toISOString();
  }
}
