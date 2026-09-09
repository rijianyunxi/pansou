import { load } from "cheerio";
import {
  BUILTIN_UPSTREAMS,
  buildUpstreamRequest,
  type UpstreamProbe,
  type ProbeTrace,
} from "../../../config/upstreams";
import {
  normalizeUpstreamJson,
  validResourceUrl,
} from "../../../utils/upstreamAdapter";
import type { SearchResult } from "../types/models";

function networkMessage(error: any): string {
  const cause = error?.cause || error;
  const code = cause?.code || error?.name || "NETWORK_ERROR";
  return `${code}: ${cause?.message || "请求失败"}`;
}

/** Fixed destinations only. No custom URLs, redirects, retries, or TLS overrides. */
export async function probeBuiltinUpstream(
  id: string,
  keyword: string,
): Promise<UpstreamProbe> {
  const source = BUILTIN_UPSTREAMS.find((s) => s.id === id);
  if (!source) throw new Error("Unknown upstream");
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
      const referrers: Record<string, string> = {
        jikepan: "https://jikepan.xyz/",
        qupansou: "https://pan.funletu.com/",
      };
      const response = await fetch(url, {
        method,
        body: body ? JSON.stringify(body) : undefined,
        headers: {
          "user-agent": "Mozilla/5.0",
          referer: referrers[id] || `${new URL(source.url).origin}/search`,
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
    const req = buildUpstreamRequest(id, keyword);
    let response = await request(req.url, req.method, req.body);
    if (!response.ok) {
      result.message =
        response.status >= 300 && response.status < 400
          ? `HTTP ${response.status} 重定向（安全模式不自动跟随）`
          : `HTTP ${response.status}：上游拒绝请求或接口不可用`;
      if (/Just a moment|cf-chl-|captcha/i.test(response.text))
        result.message += "；检测到验证页面";
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
        `https://www.pansearch.me/_next/data/${encodeURIComponent(buildId)}/search.json?keyword=${encodeURIComponent(keyword)}&offset=0`,
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
      const code =
        source.adapter === "disk-json"
          ? data.code
          : id === "jikepan"
            ? data.msg
            : data.status;
      result.businessCode = String(code ?? "缺失");
      if (code !== (id === "jikepan" ? "success" : 200)) {
        result.message = `业务校验失败 · ${result.businessCode}：${String(data.msg || data.message || "缺少成功状态").slice(0, 200)}`;
        return result;
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
