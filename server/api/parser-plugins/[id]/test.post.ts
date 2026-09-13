import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { getParserPluginRepository } from "../../../core/parsers/repository";
import { parseWithParserPlugin } from "../../../core/parsers/runtime";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";
export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const id = getRouterParam(event, "id") || "";
  const body = await readBody(event);
  const record = await getParserPluginRepository().get(id);
  if (!record) throw createError({ statusCode: 404, statusMessage: "parser plugin not found" });
  if (typeof body?.rawBody !== "string" || body.rawBody.length > 5_000_000) throw createError({ statusCode: 400, statusMessage: "rawBody is required and limited to 5MB" });
  const requestedFormat = body?.context?.format;
  const format = requestedFormat === "html" || requestedFormat === "json" || requestedFormat === "text"
    ? requestedFormat
    : record.manifest.format === "json" ? "json" : record.manifest.format === "html" ? "html" : "text";
  const started = Date.now();
  try {
    const results = parseWithParserPlugin(record, body.rawBody, { ...body.context, rawBody: body.rawBody, format }, { allowUnpublished: true });
    await getParserPluginRepository().markTest(id, results.length);
    return { code: 0, message: "success", data: { results, elapsedMs: Date.now() - started } };
  } catch (error) {
    await getParserPluginRepository().markTest(id, 0, error instanceof Error ? error.message : String(error));
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : String(error) });
  }
});
