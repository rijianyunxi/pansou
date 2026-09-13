import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { getPluginRepository } from "../../core/plugins/repository";
import { requireAdminAuth } from "../../utils/requireAdminAuth";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const id = getRouterParam(event, "id") || "";
  const body = await readBody(event);
  if (!body?.definition || body.definition.manifest?.id !== id) {
    throw createError({
      statusCode: 400,
      statusMessage: "definition.manifest.id must match route id",
    });
  }
  try {
    return {
      code: 0,
      message: "draft_saved",
      data: await getPluginRepository().saveDraft(
        body.definition,
        String(body.actor || "admin").slice(0, 100),
        body.changelog
      ),
    };
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
