import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { requireAdminAuth } from "../../../../utils/requireAdminAuth";
import { toHttpError } from "../../../../utils/apiResponse";
import { getSearchSettings } from "../../../../core/services/searchSettingsService";
import { getSystemSettings } from "../../../../core/services/systemSettingsService";
import {
  countEffectiveChannelSources,
  getSourceLifecycleState,
  purgeChannelSource,
} from "../../../../core/services/sourceLifecycleStore";
import { normalizeSourceParam } from "../../../../utils/sourceLifecycle";
import { TG_CHANNEL_PATTERN } from "../../../../../utils/telegramChannels";

/**
 * DELETE /api/settings/sources/:id/purge —— permanently remove an archived
 * channel source. Deleting a channel source only archives it, so this is the
 * second, destructive step the recycle bin exposes.
 */
export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const sourceId = normalizeSourceParam(getRouterParam(event, "id"));
  if (!TG_CHANNEL_PATTERN.test(sourceId)) {
    throw createError({
      statusCode: 400,
      statusMessage: "Source id must be a public Telegram username (5-64 chars: A-Za-z0-9_)",
    });
  }

  const body = await readBody(event).catch(() => ({}));
  const confirmation = normalizeSourceParam(body?.confirmation);
  if (confirmation !== sourceId) {
    throw createError({ statusCode: 400, statusMessage: "confirmation must exactly match source id" });
  }
  if (!getSourceLifecycleState(sourceId)?.deleted) {
    throw createError({ statusCode: 409, statusMessage: "source must be in recycle bin before permanent deletion" });
  }

  try {
    const purged = purgeChannelSource(sourceId);
    const settings = getSearchSettings();
    const system = getSystemSettings(useRuntimeConfig());
    return {
      code: 0,
      message: "purged",
      data: {
        ...purged,
        effectiveCount: countEffectiveChannelSources(settings.channels ?? system.defaultChannels),
      },
    };
  } catch (error) {
    throw toHttpError(error, 500, "failed to permanently delete source");
  }
});
