import { createError, defineEventHandler, readBody } from "h3";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";
import { importConfiguredUpstreams } from "../../../core/services/upstreamCatalog";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const body = await readBody(event);
  const input = typeof body === "string" ? body : body?.file ?? body?.source ?? body;
  try {
    const data = importConfiguredUpstreams(input, String(body?.actor || "admin").slice(0, 100));
    return { code: 0, message: "imported", data };
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : String(error) });
  }
});
