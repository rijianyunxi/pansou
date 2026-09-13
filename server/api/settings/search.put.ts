import { defineEventHandler, readBody, createError } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { parseSystemChannels } from "../../utils/telegramSettings";
import { getSearchSettingsVersion, saveSearchSettings } from "../../core/services/searchSettingsService";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const body = await readBody(event);
  if (body && Object.prototype.hasOwnProperty.call(body, "channels")) body.channels = parseSystemChannels(body.channels);
  try {
    const data = saveSearchSettings(body);
    return { code: 0, message: "success", data, version: getSearchSettingsVersion() };
  } catch (error: any) {
    throw createError({
      statusCode: 500,
      statusMessage: error?.message || "failed to save search settings",
    });
  }
});
