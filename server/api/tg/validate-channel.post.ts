import { createError, defineEventHandler, getRequestIP, readBody, setHeader } from "h3";
import { parseTelegramChannelInput } from "../../../utils/telegramChannelInput";
import { validateTgChannel, type TgChannelValidationResult } from "../../core/services/tg";
import { MemoryRateLimiter } from "../../core/security/rateLimit";

const limiter = new MemoryRateLimiter();
const MAX_ACTIVE = 4;
let active = 0;

export default defineEventHandler(async (event): Promise<TgChannelValidationResult> => {
  setHeader(event, "Cache-Control", "private, no-store");
  const body = await readBody(event);
  const channel = parseTelegramChannelInput(typeof body?.channel === "string" ? body.channel : "");
  if (!channel) {
    throw createError({
      statusCode: 400,
      statusMessage: "请输入公开频道用户名或链接，例如 @channel_name 或 t.me/s/channel_name；不支持私密邀请链接。",
    });
  }

  const key = getRequestIP(event) || "unknown";
  const decision = limiter.check(`tg-channel-validation:${key}`, { limit: 12, windowMs: 60_000 });
  setHeader(event, "X-RateLimit-Remaining", String(decision.remaining));
  if (!decision.allowed) {
    setHeader(event, "Retry-After", Math.max(1, Math.ceil(decision.retryAfterMs / 1000)));
    throw createError({ statusCode: 429, statusMessage: "频道验证请求过于频繁，请稍后再试。" });
  }
  if (active >= MAX_ACTIVE) {
    throw createError({ statusCode: 429, statusMessage: "当前验证请求较多，请稍后再试。" });
  }

  active++;
  try {
    return await validateTgChannel(channel, { timeoutMs: 8_000 });
  } finally {
    active--;
  }
});
