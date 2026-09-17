import { defineEventHandler } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { toHttpError } from "../../utils/apiResponse";
import { getSearchSettings, getSearchSettingsVersion } from "../../core/services/searchSettingsService";

export default defineEventHandler((event) => {
  requireAdminAuth(event);
  try {
    return {
      code: 0,
      message: "success",
      data: getSearchSettings(),
      // Opaque config version (mtime+size signature); null when unknown.
      version: getSearchSettingsVersion(),
    };
  } catch (error) {
    throw toHttpError(error, 500, "failed to load search settings");
  }
});
