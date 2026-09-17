import { createError, defineEventHandler, readBody } from "h3";
import { getUnifiedSource } from "../../core/services/sourceCatalog";
import { probeSourceDefinition } from "../../core/services/sourceProbe";
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

  const source = getUnifiedSource(sourceId);
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
