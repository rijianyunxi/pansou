import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { getPluginRepository } from "../../../core/plugins/repository";
import { enforceAdminRateLimit } from "../../../utils/adminSecurity";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  enforceAdminRateLimit(event, "plugin-publish", {
    limit: 10,
    windowMs: 60_000,
  });
  const id = getRouterParam(event, "id") || "";
  const body = await readBody(event).catch(() => ({}));
  try {
    return {
      code: 0,
      message: "published",
      data: await getPluginRepository().publish(
        id,
        String(body?.actor || "admin").slice(0, 100)
      ),
    };
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
