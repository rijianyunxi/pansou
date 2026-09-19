import { createError, setHeader, type H3Event } from "h3";
import { cleanupUserData, getUserPolicy, type UserPolicy } from "../core/services/policyService";
import { searchRateLimiter } from "../core/security/rateLimit";
import { listUnifiedSources } from "../core/services/sourceCatalog";
import { normalizeChannelNames } from "../../utils/customChannels";
import { getClientIp } from "./clientIp";
import { prepareSearch, type PreparedSearch } from "./executeSearch";
import { getStoredChannels, getStoredSessionChannels, getUserSession, type UserSessionContext } from "./userAuth";
import { createSearchLog } from "../core/services/searchAnalyticsService";

export type SearchScope = "system" | "custom_channels";

export interface AuthorizedSearch {
  prepared: PreparedSearch;
  context: UserSessionContext;
  policy: UserPolicy;
  scope: SearchScope;
  channels: string[];
  sourceIds: string[];
}

function deny(message: string, statusCode = 403): never {
  throw createError({ statusCode, statusMessage: message });
}

function authorizeSearchRateLimit(event: H3Event, context: UserSessionContext, policy: UserPolicy): void {
  const accountType = context.user ? "logged" : "anonymous";
  // Logged-in and anonymous callers have separate budgets; pick the tier once
  // instead of branching on every individual limit.
  const tier = context.user
    ? {
        windowSeconds: policy.loggedSearchRateLimitWindowSeconds,
        sessionLimit: policy.loggedSearchRateLimitPerSession,
        ipLimit: policy.loggedSearchRateLimitPerIp,
      }
    : {
        windowSeconds: policy.anonymousSearchRateLimitWindowSeconds,
        sessionLimit: policy.anonymousSearchRateLimitPerSession,
        ipLimit: policy.anonymousSearchRateLimitPerIp,
      };
  const windowMs = tier.windowSeconds * 1000;
  const ip = getClientIp(event);
  const sessionDecision = searchRateLimiter.check(`search:${accountType}:session:${context.session.id}`, {
    limit: tier.sessionLimit,
    windowMs,
  });
  const ipDecision = searchRateLimiter.check(`search:${accountType}:ip:${ip}`, {
    limit: tier.ipLimit,
    windowMs,
  });
  setHeader(event, "X-RateLimit-Account-Type", accountType);
  setHeader(event, "X-RateLimit-Remaining", String(Math.min(sessionDecision.remaining, ipDecision.remaining)));
  setHeader(event, "X-RateLimit-Window-Seconds", String(tier.windowSeconds));
  setHeader(event, "X-RateLimit-Session-Limit", String(tier.sessionLimit));
  setHeader(event, "X-RateLimit-Session-Remaining", String(sessionDecision.remaining));
  setHeader(event, "X-RateLimit-IP-Limit", String(tier.ipLimit));
  setHeader(event, "X-RateLimit-IP-Remaining", String(ipDecision.remaining));

  if (sessionDecision.allowed && ipDecision.allowed) return;
  const retryAfterMs = Math.max(sessionDecision.retryAfterMs, ipDecision.retryAfterMs);
  setHeader(event, "Retry-After", Math.max(1, Math.ceil(retryAfterMs / 1000)));
  throw createError({ statusCode: 429, statusMessage: "搜索请求过于频繁，请稍后再试" });
}

/** Which configured sources a search would actually load, recorded for audit. */
function sourceSnapshot(prepared: PreparedSearch): string[] {
  // User-owned custom sources are ephemeral (they are materialized from the
  // account row for this request), but they still belong in the audit snapshot
  // under the same source id field as catalogue sources.
  if (prepared.request.channels !== undefined) return prepared.request.channels;
  const configured = listUnifiedSources();
  const selected = prepared.effective.sourceIds;
  return selected?.length
    ? configured.filter((source) => selected.includes(source.id)).map((source) => source.id)
    : configured.map((source) => source.id);
}

function searchScopeAndChannels(
  prepared: PreparedSearch,
  context: UserSessionContext,
  policy: UserPolicy,
): { prepared: PreparedSearch; scope: SearchScope; channels: string[] } {
  if (prepared.request.channels === undefined) {
    return { prepared, scope: "system", channels: [] };
  }
  // The request only selects custom-channel mode. The actual channel list is
  // always read back from the server-side store (the account row for a
  // logged-in caller, the anonymous session otherwise) and never trusted from
  // client JSON.
  const stored = context.user
    ? normalizeChannelNames(getStoredChannels(context.user))
    : policy.anonymousCustomChannels
      ? normalizeChannelNames(getStoredSessionChannels(context.session))
      : deny("自定义频道需要在微信小程序中登录后使用，或由管理员开启「允许匿名用户使用自定义频道」。");
  if (stored.length > policy.customChannelLimit) deny("已保存的自定义频道超过当前配额，请先删除部分频道");
  if (!stored.length) deny("请先添加至少一个公开频道");
  return {
    prepared: { ...prepared, request: { ...prepared.request, channels: stored } },
    scope: "custom_channels",
    channels: stored,
  };
}

function writeSearchLog(
  event: H3Event,
  context: UserSessionContext,
  prepared: PreparedSearch,
  scope: SearchScope,
  channels: string[],
  sourceIds: string[],
): number | undefined {
  try {
    return createSearchLog({
      sessionId: context.session.id,
      userId: context.user?.id ?? null,
      keyword: prepared.request.kw,
      ip: getClientIp(event),
      searchScope: scope,
      channels,
      sourceIds,
    });
  } catch (error) {
    // Logging is best-effort by design; never turn an accepted search into an error.
    console.error("[search] failed to write search log", error);
    return undefined;
  }
}

/** Shared authorization and search-scope pipeline for GET/POST SSE and JSON searches. */
export function authorizeSearch(
  event: H3Event,
  raw: unknown,
  options: { includeDebug?: boolean } = {},
): AuthorizedSearch {
  // Parse before creating an anonymous session so malformed requests do not
  // create identities or execute a search.
  const parsed = prepareSearch(raw, options);
  cleanupUserData();
  const context = getUserSession(event, { createAnonymous: true });
  const policy = getUserPolicy();
  authorizeSearchRateLimit(event, context, policy);
  const resolved = searchScopeAndChannels(parsed, context, policy);
  const sourceIds = sourceSnapshot(resolved.prepared);
  const searchLogId = writeSearchLog(event, context, resolved.prepared, resolved.scope, resolved.channels, sourceIds);
  return { prepared: searchLogId ? { ...resolved.prepared, searchLogId } : resolved.prepared, context, policy, scope: resolved.scope, channels: resolved.channels, sourceIds };
}
