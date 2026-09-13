import { load } from "cheerio";
import { type UpstreamProbe, type ProbeTrace } from "../../../config/upstreams";
import { getConfiguredUpstream } from "./upstreamCatalog";
import { executeInstructions } from "../instructions/executor";
import { isCoreCompatibleConfiguration, upstreamToInstructionDefinition } from "./configuredUpstreamPlugin";
import {
  normalizeUpstreamJson,
  validResourceUrl,
} from "../../../utils/upstreamAdapter";
import { parseConfiguredUpstreamResponse } from "../parsers/upstream";
import type { SearchResult } from "../types/models";

function networkMessage(error: any): string {
  const cause = error?.cause || error;
  const code = cause?.code || error?.name || "NETWORK_ERROR";
  return `${code}: ${cause?.message || "请求失败"}`;
}

async function probeDeclarativeUpstream(
  source: NonNullable<ReturnType<typeof getConfiguredUpstream>>,
  keyword: string,
): Promise<UpstreamProbe> {
  const started = Date.now();
  const result: UpstreamProbe = {
    sourceId: source.id,
    checkedAt: new Date().toISOString(),
    state: "error",
    message: "",
    elapsedMs: 0,
    httpStatus: null,
    traces: [],
    raw: "",
    rawTruncated: false,
    results: [],
  };
  try {
    const execution = await executeInstructions(upstreamToInstructionDefinition(source), keyword, {
      limit: 200,
    });
    result.results = execution.results;
    result.traces = execution.traces.map((trace) => ({
      stage: trace.stage,
      url: trace.url,
      method: trace.method,
      status: trace.status,
      elapsedMs: trace.elapsedMs,
      bytes: trace.bytes,
      contentType: trace.contentType || "",
      ...(trace.error ? { error: trace.error } : {}),
    }));
    const lastResponse = [...result.traces].reverse().find((trace) => trace.status != null);
    result.httpStatus = lastResponse?.status ?? null;
    result.raw = execution.raw;
    result.rawTruncated = execution.rawTruncated;
    result.state = "available";
    result.message = result.results.length
      ? `解析成功，输出 ${result.results.length} 条统一结果`
      : "请求成功，本次关键词无有效结果";
    return result;
  } catch (error) {
    result.message = error instanceof Error ? error.message : String(error);
    const lastResponse = [...result.traces].reverse().find((trace) => trace.status != null);
    result.httpStatus = lastResponse?.status ?? null;
    return result;
  } finally {
    result.elapsedMs = Date.now() - started;
  }
}

/** Probe the currently published SQLite catalog entry. Core owns only the safe probe and handler logic. */
export async function probeConfiguredUpstream(
  id: string,
  keyword: string,
): Promise<UpstreamProbe> {
  const source = getConfiguredUpstream(id);
  if (!source) throw new Error("Unknown upstream");
  // Edited catalog rows use the same declarative executor as formal search;
  // untouched built-ins retain their specialized Core diagnostics.
  if (!isCoreCompatibleConfiguration(source)) {
    return probeDeclarativeUpstream(source, keyword);
  }
  const sourceUrl = source.url;
  const started = Date.now();
  const result: UpstreamProbe = {
    sourceId: id,
    checkedAt: new Date().toISOString(),
    state: "error",
    message: "",
    elapsedMs: 0,
    httpStatus: null,
    traces: [],
    raw: "",
    rawTruncated: false,
    results: [],
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  async function request(
    url: string,
    method = "GET",
    body?: Record<string, unknown>,
  ) {
    const trace: ProbeTrace = {
      url,
      method,
      status: null,
      elapsedMs: 0,
      bytes: 0,
      contentType: "",
    };
    result.traces.push(trace);
    const start = Date.now();
    try {
      const response = await fetch(url, {
        method,
        body: body ? JSON.stringify(body) : undefined,
        headers: {
          "user-agent": "Mozilla/5.0",
          referer: `${new URL(sourceUrl).origin}/search`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        signal: controller.signal,
        redirect: "manual",
      });
      trace.status = response.status;
      trace.contentType = response.headers.get("content-type") || "";
      result.httpStatus = response.status;
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let text = "";
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          trace.bytes += value.byteLength;
          if (trace.bytes > 1024 * 1024) {
            await reader.cancel();
            throw new Error("响应超过 1 MiB 安全上限");
          }
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      }
      result.raw = text.slice(0, 100000);
      result.rawTruncated = text.length > 100000;
      return { text, status: response.status, ok: response.ok };
    } catch (error) {
      trace.error = networkMessage(error);
      throw error;
    } finally {
      trace.elapsedMs = Date.now() - start;
    }
  }
  try {
    const baseUrl = new URL(source.url);
    let requestUrl = source.url;
    let requestBody: Record<string, unknown> | undefined;
    if (id === "hunhepan" && source.method === "POST") {
      requestBody = { q: keyword, exact: true, page: 1, size: 30, type: "", time: "", from: "web", user_id: 0, filter: true };
    } else if (source.method === "POST") {
      requestBody = { keyword };
    } else if (source.method === "GET") {
      const parsed = new URL(source.url);
      if (id === "nyaa") { parsed.searchParams.set("f", "0"); parsed.searchParams.set("c", "0_0"); parsed.searchParams.set("q", keyword); parsed.searchParams.set("s", "seeders"); parsed.searchParams.set("o", "desc"); }
      else if (id === "duoduo") requestUrl = `${source.url.replace(/\/$/, "")}/index.php/vod/search/wd/${encodeURIComponent(keyword)}.html`;
      else parsed.searchParams.set("keyword", keyword);
      if (requestUrl === source.url) requestUrl = parsed.toString();
    }
    let response = await request(requestUrl, source.method, requestBody);
    if (!response.ok) {
      result.message =
        response.status >= 300 && response.status < 400
          ? `HTTP ${response.status} 重定向（安全模式不自动跟随）`
          : `HTTP ${response.status}：上游拒绝请求或接口不可用`;
      if (/Just a moment|cf-chl-|captcha/i.test(response.text))
        result.message += "；检测到验证页面";
      return result;
    }

    // The configured transform is the same response path used by formal search.
    let parserPayload: unknown = response.text;
    if (source.format === "json") {
      try {
        parserPayload = JSON.parse(response.text);
      } catch {
        result.message = "HTTP 200，但响应不是预期的 JSON";
        return result;
      }
    }
    const configured = await parseConfiguredUpstreamResponse(source.id, parserPayload, source.format, {
      keyword,
      rawBody: response.text,
      url: requestUrl,
      page: 1,
    });
    if (configured !== null) {
      result.results = configured;
      result.state = "available";
      result.message = result.results.length
        ? `解析成功，输出 ${result.results.length} 条统一结果`
        : "请求成功，本次关键词无有效结果";
      return result;
    }

    if (id === "pansearch") {
      const buildId = response.text.match(/"buildId":"([a-zA-Z0-9_-]+)"/)?.[1];
      if (!buildId) {
        result.state = "warning";
        result.message = "HTTP 可达，但未找到 Next.js buildId";
        return result;
      }
      response = await request(
        `${baseUrl.origin}/_next/data/${encodeURIComponent(buildId)}/search.json?keyword=${encodeURIComponent(keyword)}&offset=0`,
      );
      if (!response.ok) {
        result.message = `Next.js 数据接口返回 HTTP ${response.status}`;
        return result;
      }
      const json = JSON.parse(response.text);
      const items = json?.pageProps?.data?.data;
      if (!Array.isArray(items))
        throw new Error("Next.js 数据结构与适配器不匹配");
      result.results = items
        .slice(0, 100)
        .flatMap((item: any, index: number): SearchResult[] => {
          const $ = load(typeof item.content === "string" ? item.content : "");
          const url = $("a[href]").first().attr("href") || "";
          if (!validResourceUrl(url)) return [];
          return normalizeUpstreamJson(
            [{ title: $.text().slice(0, 180), url }],
            { items: "", title: "title", url: "url", type: "", password: "" },
            `pansearch-${index}`,
          );
        });
    } else if (source.format === "json") {
      let data: any;
      try {
        data = JSON.parse(response.text);
      } catch {
        result.message = "HTTP 200，但响应不是预期的 JSON";
        return result;
      }
      // Only the legacy disk endpoint has a mandatory business status code.
      // Generic JSON sources are validated by their configured field mapping;
      // requiring data.status === 200 would reject otherwise valid APIs.
      if (source.adapter === "disk-json") {
        const code = data.code;
        result.businessCode = String(code ?? "缺失");
        if (code !== 200) {
          result.message = `业务校验失败 · ${result.businessCode}：${String(data.msg || data.message || "缺少成功状态").slice(0, 200)}`;
          return result;
        }
      }
      result.results = normalizeUpstreamJson(data, source.mapping, source.id);
    } else if (id === "nyaa") {
      const $ = load(response.text);
      if (!$("table.torrent-list").length) {
        result.state = "warning";
        result.message = "HTTP 可达，但未识别到 Nyaa 结果表格";
        return result;
      }
      $("table.torrent-list tbody tr")
        .slice(0, 100)
        .each((index, row) => {
          const title = $(row)
            .find("td")
            .eq(1)
            .find('a[href^="/view/"]')
            .not(".comments")
            .last()
            .text()
            .trim();
          const url = $(row).find('a[href^="magnet:"]').attr("href") || "";
          if (title && validResourceUrl(url))
            result.results.push({
              unique_id: `nyaa-${index}`,
              message_id: "",
              channel: "nyaa",
              datetime: "",
              content: "",
              title,
              links: [{ url, type: "magnet", password: "" }],
            });
        });
    } else {
      result.state = "warning";
      result.message = /Just a moment|cf-chl-|captcha/i.test(response.text)
        ? "HTTP 可达，但检测到验证页面"
        : "HTTP 可达；此适配器仅探测搜索页，详情解析尚未接入工作台";
      return result;
    }
    result.state = "available";
    result.message = result.results.length
      ? `适配成功，输出 ${result.results.length} 条统一结果`
      : "接口及响应结构正常，本次关键词无有效链接";
    return result;
  } catch (error) {
    result.message = networkMessage(error);
    return result;
  } finally {
    clearTimeout(timer);
    result.elapsedMs = Date.now() - started;
  }
}
