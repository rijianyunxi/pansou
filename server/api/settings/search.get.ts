import { defineEventHandler, createError } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { getSearchSettings, getSearchSettingsVersion } from "../../core/services/searchSettingsService";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  try {
    return {
      code: 0,
      message: "success",
      data: getSearchSettings(),
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
