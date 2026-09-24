import { createError, defineEventHandler, readBody, setHeader } from "h3";
import { getUserPolicy } from "../../../core/services/policyService";
import { parseCustomChannelInput } from "../../../../utils/customChannelInput";
import { normalizeChannelNames } from "../../../../utils/customChannels";
import { validateChannelSource, type ChannelValidationResult } from "../../../core/services/channelValidation";
import { MemoryRateLimiter } from "../../../core/security/rateLimit";
import { setPrivateNoStore } from "../../../utils/apiResponse";
import { getStoredChannels, getStoredSessionChannels, getUserSession, requireSameOriginUserRequest } from "../../../utils/userAuth";
import { getClientIp } from "../../../utils/clientIp";

const VALIDATIONS_PER_MINUTE = 12;
/** Each validation performs a real outbound request, so concurrency is capped. */
const MAX_CONCURRENT_VALIDATIONS = 4;

const limiter = new MemoryRateLimiter();
let active = 0;

/**
 * POST /api/account/channels/validate —— validate one public channel source
 * before it is added to the caller's channel list. Runs a real request through
 * the persisted source template so an unreachable or non-public channel is
 * rejected at add time, and enforces the per-session quota first.
 */
export default defineEventHandler(async (event): Promise<ChannelValidationResult> => {
  setPrivateNoStore(event);
  requireSameOriginUserRequest(event);
  const body = await readBody(event);
  const channel = parseCustomChannelInput(typeof body?.channel === "string" ? body.channel : "");
  if (!channel) {
    throw createError({
      statusCode: 400,
      statusMessage: "请输入公开频道用户名或链接，例如 @channel_name 或 t.me/s/channel_name；不支持私密邀请链接。",
    });
  }

  const context = getUserSession(event, { createAnonymous: true });
  const policy = getUserPolicy();
  if (!context.user && !policy.anonymousCustomChannels) {
    throw createError({ statusCode: 403, statusMessage: "验证自定义频道需要在微信小程序中登录后使用，或由管理员开启「允许匿名用户使用自定义频道」。" });
  }
  const stored = normalizeChannelNames(
    context.user ? getStoredChannels(context.user) : getStoredSessionChannels(context.session),
  );
  // Re-validating a channel that is already stored is always allowed.
  if (!stored.includes(channel) && stored.length >= policy.customChannelLimit) {
    throw createError({ statusCode: 403, statusMessage: `自定义频道数量已达到上限（${policy.customChannelLimit}）。` });
  }

  const decision = limiter.check(`channel-validation:session:${context.session.id}`, {
    limit: VALIDATIONS_PER_MINUTE,
    windowMs: 60 * 1000,
  });
  const ipDecision = limiter.check(`channel-validation:ip:${getClientIp(event)}`, {
    limit: VALIDATIONS_PER_MINUTE * 4,
    windowMs: 60 * 1000,
  });
  setHeader(event, "X-RateLimit-Remaining", String(Math.min(decision.remaining, ipDecision.remaining)));
  if (!decision.allowed || !ipDecision.allowed) {
    setHeader(event, "Retry-After", Math.max(1, Math.ceil(Math.max(decision.retryAfterMs, ipDecision.retryAfterMs) / 1000)));
    throw createError({ statusCode: 429, statusMessage: "频道验证请求过于频繁，请稍后再试。" });
  }
  if (active >= MAX_CONCURRENT_VALIDATIONS) {
    setHeader(event, "Retry-After", 2);
    throw createError({ statusCode: 429, statusMessage: "当前验证请求较多，请稍后再试。" });
  }

  active++;
  try {
    return await validateChannelSource(channel);
  } finally {
    active--;
  }
});
