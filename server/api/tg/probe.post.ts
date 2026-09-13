import { createError, defineEventHandler, readBody, setHeader } from "h3";
import { probeTgChannel, type TgProbeResult } from "../../core/services/tg";
import { requireAdminAuth } from "../../utils/requireAdminAuth";

let active = 0;
const channelPattern = /^[A-Za-z0-9_]{5,64}$/;

export default defineEventHandler(async (event): Promise<TgProbeResult> => {
  setHeader(event, "Cache-Control", "no-store");
  requireAdminAuth(event);
  const body = await readBody(event);
  const channel =
    typeof body?.channel === "string"
      ? body.channel.trim().replace(/^@/, "")
      : "";
  const keyword = typeof body?.keyword === "string" ? body.keyword.trim() : "";
  const limit = Number(body?.limit ?? 20);
  if (!channelPattern.test(channel)) {
    throw createError({
      statusCode: 400,
      statusMessage: "Channel must be a public Telegram username",
    });
  }
  if (!keyword || keyword.length > 100) {
    throw createError({
      statusCode: 400,
      statusMessage: "Keyword must contain 1 to 100 characters",
    });
  }
  if (!Number.isFinite(limit) || limit < 1 || limit > 50) {
    throw createError({
      statusCode: 400,
      statusMessage: "Limit must be between 1 and 50",
    });
  }
  if (active >= 2) {
    throw createError({
      statusCode: 429,
      statusMessage: "At most two Telegram diagnostics may run concurrently",
    });
  }
  active++;
  try {
    return await probeTgChannel(channel, keyword, limit);
  } finally {
    active--;
  }
});
