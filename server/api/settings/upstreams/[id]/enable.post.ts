import { createError, defineEventHandler, getRouterParam } from "h3";
import { setUnifiedUpstreamEnabled } from "../../../../core/services/upstreamCatalog";
import { requireAdminAuth } from "../../../../utils/requireAdminAuth";
import { setSearchSourceEnabled } from "../../../../core/services/searchSettingsService";

export default defineEventHandler((event) => {
  requireAdminAuth(event);
  try {
    const source = setUnifiedUpstreamEnabled(getRouterParam(event, "id") || "", true);
    setSearchSourceEnabled(source.id, true);
    return { code: 0, message: "enabled", data: source };
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : String(error) });
  }
});
