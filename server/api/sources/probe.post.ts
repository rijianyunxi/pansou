import { createError, defineEventHandler, readBody } from "h3";
import { getUnifiedSource } from "../../core/services/sourceCatalog";
import { prepareSourceForProbe, probeSourceDefinition } from "../../core/services/sourceProbe";
import { requireAdminAuth } from "../../utils/requireAdminAuth";

/** Each probe performs a real outbound request, so concurrency is capped. */
const MAX_CONCURRENT_PROBES = 2;

let active = 0;

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const body = await readBody(event);
  const sourceId = typeof body?.sourceId === "string" ? body.sourceId.trim() : "";
  const kw = typeof body?.kw === "string" ? body.kw.trim() : "";
  if (!sourceId) throw createError({ statusCode: 400, statusMessage: "sourceId is required" });
  if (!kw || kw.length > 100) {
    throw createError({ statusCode: 400, statusMessage: "kw must contain 1 to 100 characters" });
  }

  let source;
  try {
    source = body?.source !== undefined
      ? prepareSourceForProbe(body.source, sourceId)
      : getUnifiedSource(sourceId);
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
  if (!source) throw createError({ statusCode: 404, statusMessage: "Unknown source" });
  if (active >= MAX_CONCURRENT_PROBES) {
    throw createError({ statusCode: 429, statusMessage: "At most two diagnostics may run concurrently" });
  }

  active++;
  try {
    return await probeSourceDefinition(source, kw);
  } finally {
    active--;
  }
});
