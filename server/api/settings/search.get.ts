import { defineEventHandler, createError } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { getSearchSettings, getSearchSettingsVersion } from "../../core/services/searchSettingsService";
import { getSystemSettings } from "../../core/services/systemSettingsService";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  try {
    return {
      code: 0,
      message: "success",
      data: {
        ...getSearchSettings(),
        requestTimeoutMs: getSystemSettings(useRuntimeConfig()).requestTimeoutMs,
        cacheTtlMinutes: getSystemSettings(useRuntimeConfig()).cacheTtlMinutes,
      },
      // Opaque config version (mtime+size signature); null when unknown.
      version: getSearchSettingsVersion(),
    };
  } catch (error: any) {
    throw createError({
      statusCode: 500,
      statusMessage: error?.message || "failed to load search settings",
    });
  }
});
