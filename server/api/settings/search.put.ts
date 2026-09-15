import { defineEventHandler, readBody, createError } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { parseSystemChannels } from "../../utils/telegramSettings";
import { getSearchSettingsVersion, saveSearchSettings } from "../../core/services/searchSettingsService";
import { getSystemSettings, saveSystemSettings } from "../../core/services/systemSettingsService";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const body = await readBody(event);
  if (body && Object.prototype.hasOwnProperty.call(body, "channels")) body.channels = parseSystemChannels(body.channels);
  try {
    const data = saveSearchSettings(body);
    if (body && (Object.prototype.hasOwnProperty.call(body, "cacheTtlMinutes") || Object.prototype.hasOwnProperty.call(body, "requestTimeoutMs"))) {
      saveSystemSettings({
        ...(Object.prototype.hasOwnProperty.call(body, "cacheTtlMinutes") ? { cacheTtlMinutes: body.cacheTtlMinutes } : {}),
        ...(Object.prototype.hasOwnProperty.call(body, "requestTimeoutMs") ? { requestTimeoutMs: body.requestTimeoutMs } : {}),
      });
    }
    return {
      code: 0,
      message: "success",
      data: {
        ...data,
        requestTimeoutMs: getSystemSettings(useRuntimeConfig()).requestTimeoutMs,
        cacheTtlMinutes: getSystemSettings(useRuntimeConfig()).cacheTtlMinutes,
      },
      version: getSearchSettingsVersion(),
    };
  } catch (error: any) {
    throw createError({
      statusCode: 500,
      statusMessage: error?.message || "failed to save search settings",
    });
  }
});
