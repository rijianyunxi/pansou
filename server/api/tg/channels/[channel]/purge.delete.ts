import { createError, defineEventHandler, getRouterParam, readBody, setResponseHeader } from "h3";
import { requireAdminAuth } from "../../../../utils/requireAdminAuth";
import { getSearchSettings } from "../../../../core/services/searchSettingsService";
import { getSystemSettings } from "../../../../core/services/systemSettingsService";
import {
  countEffectiveTgChannels,
  getTgChannelState,
  purgeTgChannel,
} from "../../../../core/services/tgChannelSettings";
import { normalizeTgChannelParam } from "../../../../utils/telegramSettings";
import { TG_CHANNEL_PATTERN } from "../../../../../utils/telegramChannels";

/** DELETE /api/tg/channels/:channel/purge —— permanently remove an archived channel. */
export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  setResponseHeader(event, "Cache-Control", "private, no-store");
  const channel = normalizeTgChannelParam(getRouterParam(event, "channel"));
  if (!TG_CHANNEL_PATTERN.test(channel)) {
    throw createError({
      statusCode: 400,
      statusMessage: "Channel must be a public Telegram username (5-64 chars: A-Za-z0-9_)",
    });
  }

  const body = await readBody(event).catch(() => ({}));
  const confirmation = normalizeTgChannelParam(body?.confirmation);
  if (confirmation !== channel) {
    throw createError({ statusCode: 400, statusMessage: "confirmation must exactly match channel username" });
  }
  if (!getTgChannelState(channel)?.deleted) {
    throw createError({ statusCode: 409, statusMessage: "channel must be in recycle bin before permanent deletion" });
  }

  try {
    const purged = purgeTgChannel(channel);
    const settings = getSearchSettings();
    const system = getSystemSettings(useRuntimeConfig());
    return {
      code: 0,
      message: "purged",
      data: {
        ...purged,
        effectiveCount: countEffectiveTgChannels(settings.channels ?? system.defaultChannels),
      },
    };
  } catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage: error instanceof Error ? error.message : "failed to permanently delete channel",
    });
  }
});
