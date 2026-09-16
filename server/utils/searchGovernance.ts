import { createError, getRequestIP, type H3Event } from "h3";
import { cleanupUserData, getUserPolicy, type UserPolicy } from "../core/services/policyService";
import { beginSearchLease, type SearchGovernanceLimits, type SearchLease } from "../core/security/concurrency";
import { listUnifiedUpstreams } from "../core/services/upstreamCatalog";
import { getSqliteDatabase } from "../core/storage/sqlite";
import { getStoredChannels, getUserSession, type UserSessionContext } from "./userAuth";
import { prepareSearch, type PreparedSearchRequest } from "./executeSearch";
import { requireSearchAuth } from "./requireAuth";
import { normalizeTelegramChannels } from "../../utils/telegramChannels";

export interface AuthorizedSearch {
  prepared: PreparedSearchRequest;
  lease: SearchLease;
  context: UserSessionContext;
  policy: UserPolicy;
  scope: "system" | "custom_channels";
  channels: string[];
  sourceIds: string[];
}

function governanceLimits(policy: UserPolicy, loggedIn: boolean): SearchGovernanceLimits {
  return {
    perClientInFlight: loggedIn ? policy.loggedConcurrent : policy.anonymousConcurrent,
    perClientWindowMs: policy.searchWindowSeconds * 1000,
    perClientWindowLimit: loggedIn ? policy.loggedSearchLimit : policy.anonymousSearchLimit,
    globalInFlight: policy.globalConcurrent,
    globalWindowMs: policy.searchWindowSeconds * 1000,
    globalWindowLimit: policy.globalSearchLimit,
    inFlightRetryAfterSeconds: Math.max(1, Math.min(policy.searchWindowSeconds, 5)),
  };
}

function deny(message: string, statusCode = 403): never {
  throw createError({ statusCode, statusMessage: message });
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
  if (!policy.customChannelsEnabled) deny("自定义频道搜索当前未启用");

  if (context.user) {
    const stored = normalizeTelegramChannels(getStoredChannels(context.user));
    if (stored.length > policy.loggedChannelLimit) deny("已保存的自定义频道超过当前配额，请先删除部分频道");
    if (!stored.length) deny("请先添加至少一个公开频道");
    // The request only selects custom-channel mode. The actual channel list is
    // always loaded from the authenticated user's row, never trusted from JSON.
    const nextPrepared = {
      ...prepared,
      request: { ...prepared.request, channels: stored },
    } as PreparedSearchRequest;
    return { prepared: nextPrepared, scope: "custom_channels", channels: stored };
  }

  if (!policy.anonymousCustomChannels) deny("登录后才能使用自定义频道");
  if (requested.length > policy.anonymousChannelLimit) deny(`匿名用户最多使用 ${policy.anonymousChannelLimit} 个自定义频道`);
  return { prepared, scope: "custom_channels", channels: requested };
}

function writeSearchLog(event: H3Event, context: UserSessionContext, prepared: PreparedSearchRequest, scope: "system" | "custom_channels", channels: string[], sourceIds: string[]): void {
  const ip = getRequestIP(event, { xForwardedFor: false }) || "unknown";
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

/** Shared admission pipeline for GET/POST SSE and JSON searches. */
export function authorizeSearch(
  event: H3Event,
  raw: unknown,
  options: { includeMeta?: boolean } = {},
): AuthorizedSearch {
  // Parse before creating an anonymous session so malformed requests do not
  // create identities or consume a search admission.
  let prepared = prepareSearch(raw, options);
  requireSearchAuth(event);
  cleanupUserData();
  const context = getUserSession(event, { createAnonymous: true });
  const policy = getUserPolicy();
  const resolved = searchScopeAndChannels(prepared, context, policy);
  prepared = resolved.prepared;
  const sourceIds = sourceSnapshot(prepared);
  const lease = beginSearchLease(event, context.session.id, governanceLimits(policy, !!context.user));
  writeSearchLog(event, context, prepared, resolved.scope, resolved.channels, sourceIds);
  return { prepared, lease, context, policy, scope: resolved.scope, channels: resolved.channels, sourceIds };
}
