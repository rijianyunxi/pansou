import { createError, setHeader, type H3Event } from "h3";
import { cleanupUserData, getUserPolicy, type UserPolicy } from "../core/services/policyService";
import { listUnifiedUpstreams } from "../core/services/upstreamCatalog";
import { getSqliteDatabase } from "../core/storage/sqlite";
import { getStoredChannels, getStoredSessionChannels, getUserSession, type UserSessionContext } from "./userAuth";
import { searchRateLimiter } from "../core/security/rateLimit";
import { prepareSearch, type PreparedSearchRequest } from "./executeSearch";
import { normalizeTelegramChannels } from "../../utils/telegramChannels";
import { getClientIp } from "./clientIp";

export interface AuthorizedSearch {
  prepared: PreparedSearchRequest;
  context: UserSessionContext;
  policy: UserPolicy;
  scope: "system" | "custom_channels";
  channels: string[];
  sourceIds: string[];
}

function deny(message: string, statusCode = 403): never {
  throw createError({ statusCode, statusMessage: message });
}

function authorizeSearchRateLimit(event: H3Event, context: UserSessionContext, policy: UserPolicy): void {
  const windowMs = policy.searchRateLimitWindowSeconds * 1000;
  const ip = getClientIp(event);
  const sessionDecision = searchRateLimiter.check(`search:session:${context.session.id}`, {
    limit: policy.searchRateLimitPerSession,
    windowMs,
  });
  const ipDecision = searchRateLimiter.check(`search:ip:${ip}`, {
    limit: policy.searchRateLimitPerIp,
    windowMs,
  });
  const remaining = Math.min(sessionDecision.remaining, ipDecision.remaining);
  setHeader(event, "X-RateLimit-Remaining", String(remaining));
  setHeader(event, "X-RateLimit-Session-Limit", String(policy.searchRateLimitPerSession));
  setHeader(event, "X-RateLimit-Session-Remaining", String(sessionDecision.remaining));
  setHeader(event, "X-RateLimit-IP-Limit", String(policy.searchRateLimitPerIp));
  setHeader(event, "X-RateLimit-IP-Remaining", String(ipDecision.remaining));

  if (sessionDecision.allowed && ipDecision.allowed) return;
  const retryAfterMs = Math.max(sessionDecision.retryAfterMs, ipDecision.retryAfterMs);
  setHeader(event, "Retry-After", Math.max(1, Math.ceil(retryAfterMs / 1000)));
  throw createError({ statusCode: 429, statusMessage: "搜索请求过于频繁，请稍后再试" });
}

function sourceSnapshot(prepared: PreparedSearchRequest): string[] {
  if (prepared.request.channels !== undefined) return [];
  const configured = listUnifiedUpstreams();
  return prepared.effective.sourceIds?.length
    ? configured.filter((source) => prepared.effective.sourceIds!.includes(source.id)).map((source) => source.id)
    : configured.map((source) => source.id);
}

function searchScopeAndChannels(
  prepared: PreparedSearchRequest,
  context: UserSessionContext,
  policy: UserPolicy,
): { prepared: PreparedSearchRequest; scope: "system" | "custom_channels"; channels: string[] } {
  const requested = prepared.request.channels;
  if (requested === undefined) return { prepared, scope: "system", channels: [] };
  if (context.user) {
    const stored = normalizeTelegramChannels(getStoredChannels(context.user));
    if (stored.length > policy.customChannelLimit) deny("已保存的自定义频道超过当前配额，请先删除部分频道");
    if (!stored.length) deny("请先添加至少一个公开频道");
    // The request only selects custom-channel mode. The actual channel list is
    // always loaded from the authenticated user's row, never trusted from JSON.
    const nextPrepared = {
      ...prepared,
      request: { ...prepared.request, channels: stored },
    } as PreparedSearchRequest;
    return { prepared: nextPrepared, scope: "custom_channels", channels: stored };
  }

  if (!policy.anonymousCustomChannels) deny("自定义频道仅对登录用户开放，请先登录或注册。");
  const stored = normalizeTelegramChannels(getStoredSessionChannels(context.session));
  if (stored.length > policy.customChannelLimit) deny("已保存的自定义频道超过当前配额，请先删除部分频道");
  if (!stored.length) deny("请先添加至少一个公开频道");
  // Anonymous custom channels are persisted on the anonymous session as well;
  // do not trust a client-supplied channel list when executing a search.
  const nextPrepared = {
    ...prepared,
    request: { ...prepared.request, channels: stored },
  } as PreparedSearchRequest;
  return { prepared: nextPrepared, scope: "custom_channels", channels: stored };
}

function writeSearchLog(event: H3Event, context: UserSessionContext, prepared: PreparedSearchRequest, scope: "system" | "custom_channels", channels: string[], sourceIds: string[]): void {
  const ip = getClientIp(event);
  try {
    getSqliteDatabase().run(
      "INSERT INTO search_logs(session_id,user_id,keyword,ip,search_scope,channels_json,source_ids_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
      context.session.id,
      context.user?.id ?? null,
      prepared.request.kw,
      ip,
      scope,
      JSON.stringify(channels),
      JSON.stringify(sourceIds),
      Date.now(),
    );
  } catch (error) {
    // Logging is best-effort by design; never turn an accepted search into an error.
    console.error("[search] failed to write search log", error);
  }
}

/** Shared authorization and search-scope pipeline for GET/POST SSE and JSON searches. */
export function authorizeSearch(
  event: H3Event,
  raw: unknown,
  options: { includeMeta?: boolean } = {},
): AuthorizedSearch {
  // Parse before creating an anonymous session so malformed requests do not
  // create identities or execute a search.
  let prepared = prepareSearch(raw, options);
  cleanupUserData();
  const context = getUserSession(event, { createAnonymous: true });
  const policy = getUserPolicy();
  authorizeSearchRateLimit(event, context, policy);
  const resolved = searchScopeAndChannels(prepared, context, policy);
  prepared = resolved.prepared;
  const sourceIds = sourceSnapshot(prepared);
  writeSearchLog(event, context, prepared, resolved.scope, resolved.channels, sourceIds);
  return { prepared, context, policy, scope: resolved.scope, channels: resolved.channels, sourceIds };
}
