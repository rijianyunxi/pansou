import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { deleteUnifiedUpstream } from "../../../core/services/upstreamCatalog";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const id = String(getRouterParam(event, "id") || "").trim().toLowerCase();
  const body = await readBody(event).catch(() => ({}));
  if (!id || String(body?.confirmation || "").trim().toLowerCase() !== id) {
    throw createError({ statusCode: 400, statusMessage: "confirmation must exactly match upstream id" });
  }
  try {
    deleteUnifiedUpstream(id);
    return { code: 0, message: "deleted", data: { id } };
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : String(error) });
  }
});
