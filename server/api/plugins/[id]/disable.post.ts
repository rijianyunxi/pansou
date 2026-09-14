import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { getPluginRepository } from "../../../core/plugins/repository";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";
import { setSearchPluginEnabled } from "../../../core/services/searchSettingsService";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const id = getRouterParam(event, "id") || "";
  const body = await readBody(event).catch(() => ({}));
  try {
    const data = await getPluginRepository().disable(
      id,
      String(body?.actor || "admin").slice(0, 100)
    );
    setSearchPluginEnabled(id, false);
    return { code: 0, message: "disabled", data };
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
