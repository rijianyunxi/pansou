import { createError, defineEventHandler, readBody, setHeader } from "h3";
import { getUnifiedUpstream } from "../../core/services/upstreamCatalog";
import { probeUpstreamDefinition } from "../../core/services/upstreamProbe";
import { requireAdminAuth } from "../../utils/requireAdminAuth";

let active = 0;
export default defineEventHandler(async (event) => {
  setHeader(event, "Cache-Control", "no-store");
  requireAdminAuth(event);
  const body = await readBody(event);
  const sourceId = typeof body?.sourceId === "string" ? body.sourceId.trim() : "";
  const kw = typeof body?.kw === "string" ? body.kw.trim() : "";
  if (!sourceId) throw createError({ statusCode: 400, statusMessage: "sourceId is required" });
  if (!kw || kw.length > 100) {
    throw createError({ statusCode: 400, statusMessage: "kw must contain 1 to 100 characters" });
  }

  const source = getUnifiedUpstream(sourceId);
  if (!source) throw createError({ statusCode: 404, statusMessage: "Unknown upstream" });
  if (active >= 2) throw createError({ statusCode: 429, statusMessage: "At most two diagnostics may run concurrently" });

  active++;
  try {
    return await probeUpstreamDefinition(source, kw);
  } finally {
    active--;
  }
});
