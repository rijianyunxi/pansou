import { createError, defineEventHandler, readBody, setHeader } from "h3";
import { getUnifiedUpstream, prepareUnifiedUpstreamForProbe } from "../../core/services/upstreamCatalog";
import { probeUpstreamDefinition } from "../../core/services/upstreamProbe";
import { requireAdminAuth } from "../../utils/requireAdminAuth";

let active = 0;
export default defineEventHandler(async (event) => {
  setHeader(event, "Cache-Control", "no-store");
  requireAdminAuth(event);
  const body = await readBody(event);
  if (typeof body?.keyword !== "string" || !body.keyword.trim() || body.keyword.length > 100) {
    throw createError({ statusCode: 400, statusMessage: "Keyword must contain 1 to 100 characters" });
  }

  let source;
  try {
    source = body?.source
      ? prepareUnifiedUpstreamForProbe(body.source)
      : typeof body?.sourceId === "string"
        ? getUnifiedUpstream(body.sourceId)
        : undefined;
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : String(error) });
  }
  if (!source) throw createError({ statusCode: 400, statusMessage: "Unknown upstream" });
  if (active >= 2) throw createError({ statusCode: 429, statusMessage: "At most two diagnostics may run concurrently" });

  active++;
  try {
    return await probeUpstreamDefinition(source, body.keyword.trim());
  } finally {
    active--;
  }
});
