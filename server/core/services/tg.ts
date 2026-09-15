import { load } from "cheerio";
import { ofetch } from "ofetch";
import type { SearchResult } from "../types/models";
import {
  abortableDelay,
  createAbortScope,
  runWithSignal,
} from "../utils/abort";
import {
  buildConfiguredTgUrl,
  getTgSourceSettings,
} from "./tgSourceSettings";
import { recordTgChannelHealth } from "./tgChannelHealthStore";
import { getTgChannelPolicy } from "./tgChannelSettings";
import { executeSourceTransform } from "../source-runtime/runtime";
import { TELEGRAM_DEFAULT_TRANSFORM } from "../source-runtime/defaults";
import { runWithFallbackRetry } from "../utils/retry";
import { validateOutboundUrl } from "../security/outboundUrl";
import { getUnifiedUpstream } from "./upstreamCatalog";
import { getUnifiedRequestTimeoutMs } from "./timeoutPolicy";

export interface TgFetchOptions {
  limitPerChannel?: number;
  userAgent?: string;
  signal?: AbortSignal;
  /** Keep earlier pages while reporting a later page failure. */
  onWarning?: (error: unknown) => void;
  /** 最多抓取的分页数；缺省按结果数推导（limit / 20）。 */
  maxPages?: number;
  /** fallback 策略：仅直连 / 仅 Jina；缺省先直连、失败后换 Jina。 */
  fallback?: "direct" | "jina";
  /** Additional channel URL templates after the primary route. */
  fallbackUrls?: string[];
  /** Retries after the first request for each candidate URL. */
  maxRetries?: number;
  /** Base delay before retrying the same candidate URL. */
  retryDelayMs?: number;
  /** Optional per-upstream transform source. */
  transform?: string;
  /** Per-upstream primary URL and headers supplied by the unified catalog. */
  primaryUrl?: string;
  headers?: Record<string, string>;
  /** User-channel searches must ignore all per-channel/unified-catalog overrides. */
  scope?: "configured" | "user";
}

export type TgProbeState = "available" | "warning" | "error";

export type TgFailureKind =
  | "channel_not_found"
  | "channel_private"
  | "network_error"
  | "structure_changed"
  | "no_results";

/** M6 诊断契约：每个 fallback 阶段（直连 / Jina）的独立耗时与结果。 */
export interface TgProbeStage {
  stage: "direct" | "jina";
  durationMs: number;
  ok: boolean;
  url?: string;
  bytes?: number;
  error?: string;
}

/** 携带机器可读失败类别（tgKind）的 Telegram 频道抓取错误，搜索 warning 通过它区分五种失败。 */
export class TgChannelError extends Error {
  readonly tgKind: TgFailureKind;

  constructor(
    kind: TgFailureKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = "TgChannelError";
    this.tgKind = kind;
    if (options?.cause !== undefined)
      (this as { cause?: unknown }).cause = options.cause;
  }
}

export interface TgChannelPageClassification {
  ok: boolean;
  kind: TgFailureKind;
  /** 面向人的中文原因短语（不含频道名前缀）。 */
  reason: string;
}

const STRUCTURE_REASON =
  "页面解析失败：未识别到公开消息结构（页面可能已改版，或频道当前没有公开消息）";

/**
 * 消息节点检测：必须出现在 class 属性内，避免页面正文/注释里提到
 * "tgme_widget_message" 字样时被误判为仍有消息结构。
 */
const TG_MESSAGE_MARKUP_RE = /class="[^"]*\btgme_widget_message/;
const JINA_MARKDOWN_HEADER_RE = /^Markdown Content:\s*$/m;
const JINA_TG_SOURCE_RE = /^URL Source:\s*https?:\/\/(?:www\.)?t\.me\/s\//im;
const JINA_MESSAGE_LINK_MARKER_RE =
  /\[\]\(\s*https?:\/\/(?:www\.)?t\.me\/(?:s\/)?[^\s/)]+\/\d+(?:\?[^)]*)?\s*\)/i;
// Jina 将 Telegram 的加入/联系页转成 Markdown，不能仅凭 "Markdown Content"
// 就当成公开频道，否则私密邀请链接会被误判为可用。
const TG_PRIVATE_PAGE_RE =
  /(?:Telegram:\s*Join\b|Join\s+(?:Group\s+Chat|Channel)|tg:\/\/join|t\.me\/\+(?:[A-Za-z0-9_-]+))/i;
const TG_NOT_FOUND_PAGE_RE = /Telegram:\s*Contact\s+@/i;

export type TgPageFormat = "telegram-html" | "jina-markdown";

/** Jina Reader 返回 Markdown，不能交给 Telegram HTML 适配器。 */
export function detectTgPageFormat(body: string): TgPageFormat | null {
  // 先排除 Telegram 的私密/联系页；Jina 会把这些页面也包装成 Markdown。
  if (TG_PRIVATE_PAGE_RE.test(body) || TG_NOT_FOUND_PAGE_RE.test(body))
    return null;
  if (TG_MESSAGE_MARKUP_RE.test(body)) return "telegram-html";
  if (JINA_MARKDOWN_HEADER_RE.test(body) && JINA_TG_SOURCE_RE.test(body)) {
    return "jina-markdown";
  }
  return null;
}

/**
 * 统一构造 Telegram 公开搜索页地址。关键词必须进入来源 q 参数；
 * 本地 matchesSearchKeyword 仍会作为第二道过滤，避免来源搜索行为变化导致脏结果。
 */
export function buildTelegramPageUrl(
  channel: string,
  keyword: string,
  before?: string,
): string {
  return buildConfiguredTgUrl("direct", channel, keyword, before);
}

/**
 * 依据 t.me 公开预览页的 HTML 判定"拿不到消息"的原因：
 * 1. 有消息节点 → 成功；
 * 2. 标题为 "Telegram: Join…" 或含 tg://join → 私有频道 / 邀请链接页；
 * 3. 标题为 "Telegram: Contact @…" → 频道不存在（或用户名没有公开预览页）；
 * 4. 其余非空页面 → 结构变化（明确告警，而不是静默当作无结果）。
 */
export function classifyTgChannelPage(
  html: string,
): TgChannelPageClassification {
  if (TG_MESSAGE_MARKUP_RE.test(html)) {
    return { ok: true, kind: "no_results", reason: "" };
  }
  if (
    TG_PRIVATE_PAGE_RE.test(html) ||
    /<title>[^<]*Telegram:\s*Join/i.test(html)
  ) {
    return {
      ok: false,
      kind: "channel_private",
      reason: "为私有频道或仅提供邀请链接，无法抓取公开预览",
    };
  }
  if (
    TG_NOT_FOUND_PAGE_RE.test(html) ||
    /<title>[^<]*Telegram:\s*Contact\s+@/i.test(html) ||
    /property="og:title" content="Telegram:\s*Contact\s+@/i.test(html)
  ) {
    return {
      ok: false,
      kind: "channel_not_found",
      reason: "不存在或没有公开预览页（Telegram 返回了联系页）",
    };
  }
  return { ok: false, kind: "structure_changed", reason: STRUCTURE_REASON };
}

function classifyTgBody(body: string): TgChannelPageClassification {
  // 必须先分类访问状态，再识别 Jina 格式。Jina 的私密/不存在页面同样
  // 有 Markdown Content 和 t.me/s URL，不能直接视为公开频道。
  if (TG_PRIVATE_PAGE_RE.test(body)) {
    return {
      ok: false,
      kind: "channel_private",
      reason: "为私有频道或仅提供邀请链接，无法抓取公开预览",
    };
  }
  if (TG_NOT_FOUND_PAGE_RE.test(body)) {
    return {
      ok: false,
      kind: "channel_not_found",
      reason: "不存在或没有公开预览页（Telegram 返回了联系页）",
    };
  }
  const format = detectTgPageFormat(body);
  if (format === "jina-markdown") {
    // 公开频道必须至少有一个可识别的公开消息链接；否则只是一个
    // 空页面/改版页面，不能把它当成“可搜索频道”保存。
    return JINA_MESSAGE_LINK_MARKER_RE.test(body)
      ? { ok: true, kind: "no_results", reason: "" }
      : { ok: false, kind: "structure_changed", reason: STRUCTURE_REASON };
  }
  return classifyTgChannelPage(body);
}

export interface TgProbeRequestSnapshot {
  method: "GET";
  url: string;
  headers: Record<string, string>;
}

export interface TgProbeResponseSnapshot {
  status: number;
  headers: Record<string, string>;
  body: string;
  bodyLength: number;
  bodyTruncated: boolean;
}

export interface TgProbeAttempt {
  route: "telegram" | "jina";
  request: TgProbeRequestSnapshot;
  response: TgProbeResponseSnapshot | null;
  elapsedMs: number;
  error?: string;
}

export interface TgProbeResult {
  channel: string;
  keyword: string;
  state: TgProbeState;
  message: string;
  elapsedMs: number;
  checkedAt: string;
  route: "telegram" | "jina" | "none";
  httpStatus: number | null;
  results: SearchResult[];
  attempts: TgProbeAttempt[];
  upstreamRequest: TgProbeRequestSnapshot | null;
  upstreamResponse: TgProbeResponseSnapshot | null;
  /** M6 additive：每个 fallback 阶段（直连 / Jina）的耗时与成败。 */
  stages: TgProbeStage[];
  /** M6 additive：五种失败的机器可读类别；成功提取到结果时省略。 */
  failureKind?: TgFailureKind;
}

/** Resolve channel behavior while keeping the request timeout global. */
function resolveChannelDefaults(
  channel: string,
  options: TgFetchOptions,
): {
  timeoutMs: number;
  limitPerChannel?: number;
  maxPages?: number;
  fallback?: "direct" | "jina";
  fallbackUrls?: string[];
  maxRetries: number;
  retryDelayMs: number;
  primaryUrl?: string;
  headers?: Record<string, string>;
  transform?: string;
} {
  const source = getTgSourceSettings();
  const isUserChannelSearch = options.scope === "user";
  const useConfiguredSettings = !isUserChannelSearch;
  const policy = useConfiguredSettings ? getTgChannelPolicy(channel) : undefined;
  // User-supplied channels intentionally do not resolve against the managed
  // catalog. They always use the built-in system parser. Managed searches use
  // the channel's own catalog request settings and transform.
  const configured = useConfiguredSettings ? getUnifiedUpstream(`tg-${channel}`) : undefined;
  const configuredAddress = useConfiguredSettings ? options.primaryUrl || configured?.url : undefined;
  return {
    timeoutMs: getUnifiedRequestTimeoutMs(),
    limitPerChannel: policy?.maxResults ?? options.limitPerChannel,
    maxPages: policy?.maxPages ?? options.maxPages,
    // A managed Telegram source follows the same single-address contract as
    // HTTP sources. Legacy Telegram fallback policy remains available only for
    // channel validation before the source exists in the catalog.
    fallback: configuredAddress ? "direct" : policy?.fallback ?? options.fallback,
    fallbackUrls: configuredAddress ? undefined : policy?.fallbackUrls ?? options.fallbackUrls ?? source.fallbackUrls,
    maxRetries: policy?.maxRetries ?? options.maxRetries ?? source.retry.maxRetries,
    retryDelayMs: policy?.retryDelayMs ?? options.retryDelayMs ?? source.retry.delayMs,
    primaryUrl: configuredAddress,
    headers: options.headers || (useConfiguredSettings ? configured?.request?.headers : undefined),
    // User-supplied channels always use the built-in system parser. Managed
    // channels use their own transform from the unified source catalog.
    transform: isUserChannelSearch
      ? TELEGRAM_DEFAULT_TRANSFORM
      : options.transform || configured?.transform || TELEGRAM_DEFAULT_TRANSFORM,
  };
}

function buildMirrorPageUrl(pageUrl: string, channel: string): string {
  const parsed = new URL(pageUrl);
  return buildConfiguredTgUrl(
    "jina",
    channel,
    parsed.searchParams.get("q") || "",
    parsed.searchParams.get("before") || undefined,
  );
}

function buildCustomTgUrl(
  template: string,
  channel: string,
  keyword: string,
  before?: string,
): string {
  const filled = template
    .replaceAll("{{channel}}", encodeURIComponent(channel.trim().replace(/^@/, "")))
    .replaceAll("{{keyword}}", encodeURIComponent(keyword.trim()))
    .replaceAll("{{before}}", encodeURIComponent(before || ""));
  const url = new URL(filled);
  if (keyword.trim()) url.searchParams.set("q", keyword.trim());
  else url.searchParams.delete("q");
  if (before) url.searchParams.set("before", before);
  else url.searchParams.delete("before");
  validateOutboundUrl(url.toString(), { allowHttp: false });
  return url.toString();
}

function buildCandidates(
  pageUrl: string,
  channel: string,
  fallback: "direct" | "jina" | undefined,
  fallbackUrls: string[] | undefined = undefined,
): Array<{ url: string; mirror: boolean }> {
  const primary = {
    url: pageUrl,
    mirror: /(^|\.)r\.jina\.ai$/i.test(new URL(pageUrl).hostname),
  };
  if (fallback === "direct") return [primary];
  if (fallback === "jina")
    return [{ url: buildMirrorPageUrl(pageUrl, channel), mirror: true }];
  const custom = (fallbackUrls || []).map((template) => {
    const parsed = new URL(pageUrl);
    const url = buildCustomTgUrl(template, channel, parsed.searchParams.get("q") || "", parsed.searchParams.get("before") || undefined);
    return { url, mirror: /(^|\.)r\.jina\.ai(?:[/:]|$)/i.test(new URL(url).hostname) };
  });
  return [primary, ...custom, { url: buildMirrorPageUrl(pageUrl, channel), mirror: true }];
}

async function fetchTgText(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  maxRetries: number,
  retryDelayMs: number,
): Promise<string> {
  const request = () => ofetch<string, "text">(url, {
    headers,
    retry: 0,
    responseType: "text",
    timeout: timeoutMs,
    signal,
  } as any);
  return runWithFallbackRetry(
    [url],
    () => (signal ? runWithSignal(request, signal) : request()),
    { signal, maxRetries, delayMs: retryDelayMs },
  );
}

/**
 * 带 q 搜索无匹配时，t.me 返回的空页面与"结构变化"无法从单次响应区分。
 * 二次抓取不带关键词的频道页：有消息节点 → 只是关键词无匹配；否则才是结构变化。
 */
async function channelHasMessagesWithoutKeyword(
  channel: string,
  headers: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const body = await fetchTgText(
      buildTelegramPageUrl(channel, ""),
      headers,
      signal,
      timeoutMs,
      0,
      0,
    );
    return typeof body === "string" && TG_MESSAGE_MARKUP_RE.test(body);
  } catch {
    return false;
  }
}

function buildChannelFailure(
  channel: string,
  lastBody: string,
  lastError: unknown,
): unknown {
  if (lastBody) {
    const classification = classifyTgBody(lastBody);
    if (!classification.ok) {
      return new TgChannelError(
        classification.kind,
        `Telegram 频道 ${channel} ${classification.reason}`,
      );
    }
  }
  if (lastError instanceof TgChannelError) return lastError;
  if (lastError instanceof Error) {
    return new TgChannelError(
      "network_error",
      `Telegram 频道 ${channel} 请求失败：${lastError.message}`,
      { cause: lastError },
    );
  }
  return (
    lastError ??
    new TgChannelError("network_error", `Telegram 频道 ${channel} 请求失败`)
  );
}

function detectCandidateFormat(
  body: string,
  mirror: boolean,
): TgPageFormat | null {
  const format = detectTgPageFormat(body);
  if (!format) return null;
  // Jina 的正式响应是 Markdown；保留 HTML 兼容分支，避免某些代理/缓存
  // 把原始 Telegram HTML 透传给 r.jina.ai 时丢失结果。
  if (mirror || format === "telegram-html") return format;
  return null;
}

export async function fetchTgChannelPosts(
  channel: string,
  keyword: string,
  options: TgFetchOptions = {},
): Promise<SearchResult[]> {
  const resolved = resolveChannelDefaults(channel, options);
  const scope = createAbortScope(
    resolved.timeoutMs,
    `Telegram 频道 ${channel} 请求超时 (${resolved.timeoutMs}ms)`,
    options.signal,
  );
  try {
    return await fetchChannelPages(
      channel,
      keyword,
      options,
      resolved,
      scope.signal,
    );
  } finally {
    scope.dispose();
  }
}

export interface TgChannelValidationResult {
  ok: boolean;
  channel: string;
  /** available 表示已确认有公开预览；其余值对应 TgFailureKind。 */
  kind: "available" | TgFailureKind;
  message: string;
  route: "telegram" | "jina" | "none";
}

/**
 * 在用户保存个人频道前，只验证公开预览是否可访问，不解析消息、不写健康记录。
 * 直连失败时自动尝试 Jina；返回 false 时调用方不应保存该频道。
 */
export async function validateTgChannel(
  channel: string,
  options: Pick<
    TgFetchOptions,
    "userAgent" | "signal" | "fallback" | "headers"
  > = {},
): Promise<TgChannelValidationResult> {
  const normalized = channel.trim().replace(/^@/, "").toLowerCase();
  const resolved = resolveChannelDefaults(normalized, options);
  const scope = createAbortScope(
    resolved.timeoutMs,
    `验证 Telegram 频道 ${normalized} 超时`,
    options.signal,
  );
  const sourceSettings = getTgSourceSettings();
  const requestHeaders = {
    ...sourceSettings.headers,
    ...(resolved.headers || {}),
    ...(options.headers || {}),
    ...(options.userAgent ? { "user-agent": options.userAgent } : {}),
  };
  let lastBody = "";
  let lastError: unknown;
  let route: TgChannelValidationResult["route"] = "none";
  const classifications: TgChannelPageClassification[] = [];
  try {
    const pageUrl = buildTelegramPageUrl(normalized, "");
    for (const candidate of buildCandidates(
      pageUrl,
      normalized,
      resolved.fallback,
      resolved.fallbackUrls,
    )) {
      scope.signal.throwIfAborted();
      route = candidate.mirror ? "jina" : "telegram";
      try {
        const body = await fetchTgText(
          candidate.url,
          requestHeaders,
          scope.signal,
          resolved.timeoutMs,
          resolved.maxRetries,
          resolved.retryDelayMs,
        );
        if (typeof body !== "string") continue;
        lastBody = body;
        const classification = classifyTgBody(body);
        classifications.push(classification);
        if (
          !classification.ok &&
          (classification.kind === "channel_private" ||
            classification.kind === "channel_not_found")
        ) {
          const message =
            classification.kind === "channel_private"
              ? "这个频道不是公开频道，或仅提供私密邀请链接，无法添加。"
              : "找不到这个公开频道，或它没有公开预览页，无法添加。";
          return {
            ok: false,
            channel: normalized,
            kind: classification.kind,
            message,
            route,
          };
        }
        if (
          classification.ok &&
          detectCandidateFormat(body, candidate.mirror)
        ) {
          return {
            ok: true,
            channel: normalized,
            kind: "available",
            message: "已确认这是可访问的公开频道。",
            route,
          };
        }
        lastError = new TgChannelError(
          classification.kind,
          classification.reason || STRUCTURE_REASON,
        );
      } catch (error: any) {
        scope.signal.throwIfAborted();
        // ofetch 在 4xx/5xx 时会把响应放在 error.response；尽量读取错误页，
        // 否则“频道不存在”会被错误地降级成普通网络失败。
        const errorBody =
          typeof error?.response?._data === "string"
            ? error.response._data
            : "";
        if (errorBody) {
          lastBody = errorBody;
          const classification = classifyTgBody(errorBody);
          classifications.push(classification);
          lastError = classification.ok
            ? error
            : new TgChannelError(
                classification.kind,
                classification.reason || STRUCTURE_REASON,
                { cause: error },
              );
        } else if (error?.response?.status === 404) {
          classifications.push({
            ok: false,
            kind: "channel_not_found",
            reason: "不存在或没有公开预览页（Telegram 返回 404）",
          });
          lastError = new TgChannelError(
            "channel_not_found",
            `Telegram 频道 ${normalized} 返回 404`,
            { cause: error },
          );
        } else {
          lastError = error;
        }
      }
    }

    // 优先保留 Telegram 明确返回的“私有/不存在”结论；例如直连拿到
    // 私有页后，Jina 失败时也不能被最后一次网络错误覆盖。
    const classification =
      classifications.find(
        (item) =>
          !item.ok &&
          (item.kind === "channel_private" ||
            item.kind === "channel_not_found"),
      ) ||
      classifications.find((item) => !item.ok) ||
      (lastBody ? classifyTgBody(lastBody) : null);
    if (classification && !classification.ok) {
      const message =
        classification.kind === "channel_private"
          ? "这个频道不是公开频道，或仅提供私密邀请链接，无法添加。"
          : classification.kind === "channel_not_found"
            ? "找不到这个公开频道，或它没有公开预览页，无法添加。"
            : "无法确认这个频道的公开消息结构，请稍后重试。";
      return {
        ok: false,
        channel: normalized,
        kind: classification.kind,
        message,
        route,
      };
    }
    const errorMessage =
      lastError instanceof Error ? lastError.message : "连接失败";
    return {
      ok: false,
      channel: normalized,
      kind: "network_error",
      message: `暂时无法连接 Telegram，频道尚未添加（${errorMessage.slice(0, 120)}）。请稍后重试。`,
      route,
    };
  } finally {
    scope.dispose();
  }
}

async function parseTelegramPayload(
  body: string,
  channel: string,
  keyword: string,
  limit: number,
  format: TgPageFormat,
  url: string,
  page: number,
  route: "telegram" | "jina",
  timeoutMs: number,
  configuredTransform?: string,
): Promise<SearchResult[]> {
  const transformFormat = format === "telegram-html" ? "html" : "text";
  return executeSourceTransform({
    id: `tg-${channel}`,
    version: "catalog",
    format: "auto",
    maxResults: 200,
    code: configuredTransform || TELEGRAM_DEFAULT_TRANSFORM,
  }, body, {
    rawBody: body,
    format: transformFormat,
    channel,
    keyword,
    source: "telegram",
    url,
    page,
    route,
  }).slice(0, limit);
}

async function fetchChannelPages(
  channel: string,
  keyword: string,
  options: TgFetchOptions,
  resolved: ReturnType<typeof resolveChannelDefaults>,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  signal.throwIfAborted();
  const sourceSettings = getTgSourceSettings();
  const requestHeaders = {
    ...sourceSettings.headers,
    ...(resolved.headers || {}),
    ...(options.headers || {}),
    ...(options.userAgent ? { "user-agent": options.userAgent } : {}),
  };
  const limit = Math.min(
    200,
    Math.max(1, Math.floor(resolved.limitPerChannel ?? 50)),
  );
  const maxPages = resolved.maxPages
    ? Math.min(50, Math.max(1, Math.floor(resolved.maxPages)))
    : Math.ceil(limit / 20);
  const allResults: SearchResult[] = [];
  const seenCursors = new Set<string>();
  let before: string | undefined;

  for (let page = 0; page < maxPages && allResults.length < limit; page++) {
    signal.throwIfAborted();
    const pageUrl = resolved.primaryUrl
      ? buildCustomTgUrl(resolved.primaryUrl, channel, keyword, before)
      : buildTelegramPageUrl(channel, keyword, before);
    let pageBody = "";
    let pageFormat: TgPageFormat | null = null;
    let lastBody = "";
    let lastError: unknown;

    for (const candidate of buildCandidates(
      pageUrl,
      channel,
      resolved.fallback,
      resolved.fallbackUrls,
    )) {
      signal.throwIfAborted();
      try {
        const body = await fetchTgText(
          candidate.url,
          requestHeaders,
          signal,
          resolved.timeoutMs,
          resolved.maxRetries,
          resolved.retryDelayMs,
        );
        signal.throwIfAborted();
        const format =
          typeof body === "string"
            ? detectCandidateFormat(body, candidate.mirror)
            : null;
        if (format) {
          pageBody = body;
          pageFormat = format;
          break;
        }
        lastBody = typeof body === "string" ? body : "";
        lastError = new TgChannelError(
          "structure_changed",
          `Telegram 频道 ${channel} ${STRUCTURE_REASON}`,
        );
      } catch (error) {
        signal.throwIfAborted(); // Never start the mirror after cancellation.
        lastError = error;
      }
    }
    if (!pageBody || !pageFormat) {
      // 带 q 翻页到无匹配页时，页面没有消息节点属于正常"搜完了"；
      // 二次确认频道本体有消息后，以已累计结果正常结束，不误报结构变化。
      if (
        keyword.trim() &&
        lastBody &&
        classifyTgBody(lastBody).kind === "structure_changed"
      ) {
        const hasMessages = await channelHasMessagesWithoutKeyword(
          channel,
          requestHeaders,
          resolved.timeoutMs,
          signal,
        );
        if (hasMessages) break;
      }
      const failure = buildChannelFailure(channel, lastBody, lastError);
      if (options.onWarning) {
        options.onWarning(failure);
        break;
      }
      throw failure;
    }

    const pageResults = await parseTelegramPayload(
      pageBody,
      channel,
      keyword,
      limit - allResults.length,
      pageFormat,
      pageUrl,
      page + 1,
      pageFormat === "jina-markdown" ? "jina" : "telegram",
      resolved.timeoutMs,
      resolved.transform,
    );
    allResults.push(...pageResults);

    const cursor = extractTgPaginationCursor(pageBody, pageFormat);
    if (!cursor || seenCursors.has(cursor)) break;
    seenCursors.add(cursor);
    before = cursor;
    if (page < maxPages - 1 && allResults.length < limit) {
      await abortableDelay(100, signal);
    }
  }
  return allResults;
}

function cleanUrlCandidate(raw: string): string {
  return raw
    .trim()
    .replace(/\\([\\`*_{}\[\]()#+.!-])/g, "$1")
    .replace(/[#\p{Extended_Pictographic}\uFE0F\u200D]+$/gu, "")
    .replace(/[，。！？；：、）》】]+$/u, "");
}

function extractTgPaginationCursor(
  body: string,
  format: TgPageFormat,
): string | undefined {
  if (format === "telegram-html") {
    const href = load(body)("a[href*='before=']").first().attr("href");
    return href?.match(/[?&]before=(\d+)(?:&|$)/)?.[1];
  }
  const urls = [...body.matchAll(/https?:\/\/[^\s)]+/gi)].map(
    (match) => match[0],
  );
  for (const raw of urls) {
    try {
      const url = new URL(cleanUrlCandidate(raw));
      const before = url.searchParams.get("before");
      if (before && /^\d+$/.test(before)) return before;
    } catch {
      // Ignore unrelated malformed Markdown links.
    }
  }
  return undefined;
}

const TG_RAW_BODY_LIMIT = 30_000;

function snapshotResponse(
  status: number,
  headers: Headers | undefined,
  body: string,
): TgProbeResponseSnapshot {
  const headerRecord: Record<string, string> = {};
  headers?.forEach((value, key) => {
    headerRecord[key] = value;
  });
  return {
    status,
    headers: headerRecord,
    body: body.slice(0, TG_RAW_BODY_LIMIT),
    bodyLength: body.length,
    bodyTruncated: body.length > TG_RAW_BODY_LIMIT,
  };
}

/**
 * 诊断探针完成后记录频道健康（source: "probe"）：
 * - 可用（或页面正常但该关键词零结果）视为成功；
 * - 页面不可用（不存在/私有/结构变化）与网络失败视为失败。
 */
function recordProbeHealth(result: TgProbeResult): void {
  recordTgChannelHealth({
    channel: result.channel,
    at: Date.now(),
    ok: result.state === "available" || result.failureKind === "no_results",
    elapsedMs: result.elapsedMs,
    resultsCount: result.results.length,
    ...(result.failureKind ? { failureKind: result.failureKind } : {}),
    message: result.message,
    source: "probe",
  });
}

/**
 * Lightweight diagnostic for the public-channel tester.
 * It only accepts a Telegram channel username and talks to two fixed public
 * web endpoints; it is not an arbitrary URL fetcher.
 */
export async function probeTgChannel(
  channel: string,
  keyword: string,
  limit = 20,
  options: TgFetchOptions = {},
): Promise<TgProbeResult> {
  const started = Date.now();
  const sourceSettings = getTgSourceSettings();
  const safeLimit = Math.min(50, Math.max(1, Math.floor(limit)));
  const resolved = resolveChannelDefaults(channel, options);
  const requestHeaders = {
    ...sourceSettings.headers,
    ...(resolved.headers || {}),
    ...(options.headers || {}),
    ...(options.userAgent ? { "user-agent": options.userAgent } : {}),
  };
  const baseUrl = resolved.primaryUrl
    ? buildCustomTgUrl(resolved.primaryUrl, channel, keyword)
    : buildTelegramPageUrl(channel, keyword);
  const candidates = buildCandidates(baseUrl, channel, resolved.fallback, resolved.fallbackUrls).map(
    (candidate) => ({
      url: candidate.url,
      mirror: candidate.mirror,
      route: (candidate.mirror ? "jina" : "telegram") as "telegram" | "jina",
      stage: (candidate.mirror ? "jina" : "direct") as "direct" | "jina",
    }),
  );
  let route: TgProbeResult["route"] = "none";
  let status: number | null = null;
  let pageBody = "";
  let pageFormat: TgPageFormat | null = null;
  let lastBody = "";
  let lastError = "";
  const attempts: TgProbeAttempt[] = [];
  const stages: TgProbeStage[] = [];

  for (const candidate of candidates) {
    const attemptStarted = Date.now();
    const request: TgProbeRequestSnapshot = {
      method: "GET",
      url: candidate.url,
      headers: requestHeaders,
    };
    try {
      const response = await runWithFallbackRetry(
        [candidate.url],
        () => ofetch.raw<string>(candidate.url, {
          headers: request.headers,
          retry: 0,
          timeout: resolved.timeoutMs,
          signal: options.signal,
              } as any),
        {
          signal: options.signal,
          maxRetries: resolved.maxRetries,
          delayMs: resolved.retryDelayMs,
        },
      );
      status = response.status;
      const body = typeof response._data === "string" ? response._data : "";
      const format = detectCandidateFormat(body, candidate.mirror);
      route = candidate.route;
      if (!format) lastBody = body;
      const usable = format !== null;
      stages.push({
        stage: candidate.stage,
        durationMs: Date.now() - attemptStarted,
        ok: usable,
        url: candidate.url,
        bytes: body.length,
        ...(usable ? {} : { error: classifyTgBody(body).reason }),
      });
      attempts.push({
        route: candidate.route,
        request,
        response: snapshotResponse(response.status, response.headers, body),
        elapsedMs: Date.now() - attemptStarted,
      });
      if (usable) {
        pageBody = body;
        pageFormat = format;
        break;
      }
    } catch (error: any) {
      const errorResponse = error?.response;
      const errorBody =
        typeof errorResponse?._data === "string" ? errorResponse._data : "";
      if (typeof errorResponse?.status === "number") {
        status = errorResponse.status;
      }
      // runWithFallbackRetry wraps the last transport error in a
      // FallbackExhaustedError. Keep the root error in probe diagnostics so
      // retry/fallback policy details do not hide the actionable cause.
      const rootError =
        error?.name === "FallbackExhaustedError" ? error?.cause : error;
      lastError =
        rootError?.cause?.code ||
        rootError?.code ||
        rootError?.message ||
        error?.message ||
        "请求失败";
      if (errorBody) lastBody = errorBody;
      attempts.push({
        route: candidate.route,
        request,
        response:
          typeof errorResponse?.status === "number"
            ? snapshotResponse(
                errorResponse.status,
                errorResponse.headers,
                errorBody,
              )
            : null,
        elapsedMs: Date.now() - attemptStarted,
        error: lastError,
      });
      stages.push({
        stage: candidate.stage,
        durationMs: Date.now() - attemptStarted,
        ok: false,
        url: candidate.url,
        ...(errorBody ? { bytes: errorBody.length } : {}),
        error: lastError,
      });
    }
  }

  const elapsedMs = Date.now() - started;
  const lastAttempt = attempts[attempts.length - 1];
  const lastAttemptWithResponse =
    [...attempts].reverse().find((attempt) => attempt.response) || lastAttempt;
  const diagnostics = {
    attempts,
    upstreamRequest: lastAttemptWithResponse?.request || null,
    upstreamResponse: lastAttemptWithResponse?.response || null,
  };
  if (!pageBody || !pageFormat) {
    // 已拿到页面但缺少对应线路的响应结构 → 明确告警；完全没拿到 → 网络失败。
    const classification = lastBody ? classifyTgBody(lastBody) : null;
    let failureKind = classification ? classification.kind : "network_error";
    let failureMessage = classification
      ? classification.kind === "structure_changed"
        ? classification.reason
        : `频道${classification.reason}`
      : `公开页面请求失败：${lastError}`;
    if (classification?.kind === "structure_changed" && keyword.trim()) {
      const hasMessages = await channelHasMessagesWithoutKeyword(
        channel,
        requestHeaders,
        resolved.timeoutMs,
        options.signal,
      );
      if (hasMessages) {
        failureKind = "no_results";
        failureMessage = "关键词无匹配";
      }
    }
    const result: TgProbeResult = {
      channel,
      keyword,
      state: classification ? "warning" : "error",
      message: failureMessage,
      elapsedMs,
      checkedAt: new Date().toISOString(),
      route,
      httpStatus: status,
      results: [],
      failureKind,
      stages,
      ...diagnostics,
    };
    recordProbeHealth(result);
    return result;
  }

  const results = await parseTelegramPayload(
    pageBody,
    channel,
    keyword,
    safeLimit,
    pageFormat,
    attempts.find((attempt) => attempt.response?.body === pageBody)?.request
      .url || "",
    1,
    route === "jina" ? "jina" : "telegram",
    resolved.timeoutMs,
    resolved.transform,
  );
  const result: TgProbeResult = {
    channel,
    keyword,
    state: results.length ? "available" : "warning",
    message: results.length
      ? `找到 ${results.length} 条匹配消息`
      : "频道可访问，但当前关键词没有提取到网盘链接",
    elapsedMs,
    checkedAt: new Date().toISOString(),
    route,
    httpStatus: status,
    results,
    ...(results.length ? {} : { failureKind: "no_results" as const }),
    stages,
    ...diagnostics,
  };
  recordProbeHealth(result);
  return result;
}
