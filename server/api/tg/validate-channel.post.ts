import { createError, defineEventHandler, readBody, setHeader } from "h3";
import { getUserPolicy } from "../../core/services/policyService";
import { parseTelegramChannelInput } from "../../../utils/telegramChannelInput";
import { normalizeTelegramChannels } from "../../../utils/telegramChannels";
import { validateTgChannel, type TgChannelValidationResult } from "../../core/services/tg";
import { MemoryRateLimiter } from "../../core/security/rateLimit";
import { getStoredChannels, getUserSession } from "../../utils/userAuth";
import { requireSearchAuth } from "../../utils/requireAuth";

const limiter = new MemoryRateLimiter();
let active = 0;

export default defineEventHandler(async (event): Promise<TgChannelValidationResult> => {
  setHeader(event, "Cache-Control", "private, no-store");
  requireSearchAuth(event);
  const body = await readBody(event);
  const channel = parseTelegramChannelInput(typeof body?.channel === "string" ? body.channel : "");
  if (!channel) {
    throw createError({
      statusCode: 400,
      statusMessage: "请输入公开频道用户名或链接，例如 @channel_name 或 t.me/s/channel_name；不支持私密邀请链接。",
    });
  }

  const context = getUserSession(event, { createAnonymous: true });
  const policy = getUserPolicy();
  if (!policy.customChannelsEnabled) {
    throw createError({ statusCode: 403, statusMessage: "自定义频道当前未启用。" });
  }
  if (!context.user && !policy.anonymousCustomChannels) {
    throw createError({ statusCode: 403, statusMessage: "登录后才能验证自定义频道。" });
  }
  if (context.user) {
    const stored = normalizeTelegramChannels(getStoredChannels(context.user));
    if (!stored.includes(channel) && stored.length >= policy.loggedChannelLimit) {
      throw createError({ statusCode: 403, statusMessage: `自定义频道数量已达到上限（${policy.loggedChannelLimit}）。` });
    }
  } else if (policy.anonymousChannelLimit < 1) {
    throw createError({ statusCode: 403, statusMessage: "匿名用户暂不能使用自定义频道。" });
  }

  const decision = limiter.check(`tg-channel-validation:session:${context.session.id}`, {
    limit: policy.channelValidationLimit,
    windowMs: policy.channelValidationWindowSeconds * 1000,
  });
  setHeader(event, "X-RateLimit-Remaining", String(decision.remaining));
  if (!decision.allowed) {
    setHeader(event, "Retry-After", Math.max(1, Math.ceil(decision.retryAfterMs / 1000)));
    throw createError({ statusCode: 429, statusMessage: "频道验证请求过于频繁，请稍后再试。" });
  }
  if (active >= policy.channelValidationConcurrent) {
    setHeader(event, "Retry-After", 2);
    throw createError({ statusCode: 429, statusMessage: "当前验证请求较多，请稍后再试。" });
  }

  active++;
  try {
    return await validateTgChannel(channel);
  } finally {
    active--;
  }
});