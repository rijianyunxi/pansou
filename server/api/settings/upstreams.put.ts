import { createError, defineEventHandler, readBody } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { saveUnifiedUpstream } from "../../core/services/upstreamCatalog";
export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const body = await readBody(event);
  try { return { code: 0, message: "saved", data: saveUnifiedUpstream(body?.source) }; }
  catch (error) { throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : String(error) }); }
});
