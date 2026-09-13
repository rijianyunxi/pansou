import {
  createError,
  defineEventHandler,
  getRouterParam,
  readBody,
} from "h3";
import { getPluginRepository } from "../../../core/plugins/repository";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const id = getRouterParam(event, "id") || "";
  const body = await readBody(event).catch(() => ({}));
  try {
    return {
      code: 0,
      message: "restored",
      data: await getPluginRepository().restore(
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
