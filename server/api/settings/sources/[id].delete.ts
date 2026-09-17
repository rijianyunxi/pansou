import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { deleteUnifiedSource } from "../../../core/services/sourceCatalog";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";
import { toHttpError } from "../../../utils/apiResponse";
import { normalizeSourceParam } from "../../../utils/sourceLifecycle";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const id = normalizeSourceParam(getRouterParam(event, "id"));
  const body = await readBody(event).catch(() => ({}));
  if (!id || normalizeSourceParam(body?.confirmation) !== id) {
    throw createError({ statusCode: 400, statusMessage: "confirmation must exactly match source id" });
  }
  try {
    deleteUnifiedSource(id);
    return { code: 0, message: "deleted", data: { id } };
  } catch (error) {
    throw toHttpError(error, 400, "failed to delete source");
  }
});
