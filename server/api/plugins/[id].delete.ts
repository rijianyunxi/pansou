import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { getPluginRepository } from "../../core/plugins/repository";
import { requireAdminAuth } from "../../utils/requireAdminAuth";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const id = getRouterParam(event, "id") || "";
  const body = await readBody(event).catch(() => ({}));
  const confirmation = String(body?.confirmation || "");
  if (!id || confirmation !== id) {
    throw createError({
      statusCode: 400,
      statusMessage: "confirmation must exactly match the plugin id",
    });
  }
  try {
    await getPluginRepository().purge(
      id,
      String(body?.actor || "admin").slice(0, 100)
    );
    return { code: 0, message: "deleted" };
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
