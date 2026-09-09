import { createError, defineEventHandler, readBody, setHeader } from "h3";
import { BUILTIN_UPSTREAMS } from "../../../config/upstreams";
import { probeBuiltinUpstream } from "../../core/services/upstreamProbe";
import { requireSearchAuth } from "../../utils/requireAuth";

let active = 0;
export default defineEventHandler(async (event) => {
  setHeader(event, "Cache-Control", "no-store");
  // This first-stage console is for local development, not a public proxy service.
  if (!import.meta.dev)
    throw createError({
      statusCode: 403,
      statusMessage: "Upstream diagnostics are only enabled in development",
    });
  requireSearchAuth(event);
  const body = await readBody(event);
  if (
    !body ||
    typeof body.sourceId !== "string" ||
    !BUILTIN_UPSTREAMS.some((s) => s.id === body.sourceId)
  )
    throw createError({
      statusCode: 400,
      statusMessage: "Unknown built-in upstream",
    });
  if (
    typeof body.keyword !== "string" ||
    !body.keyword.trim() ||
    body.keyword.length > 100
  )
    throw createError({
      statusCode: 400,
      statusMessage: "Keyword must contain 1 to 100 characters",
    });
  if (active >= 2)
    throw createError({
      statusCode: 429,
      statusMessage: "At most two diagnostics may run concurrently",
    });
  active++;
  try {
    return await probeBuiltinUpstream(body.sourceId, body.keyword.trim());
  } finally {
    active--;
  }
});
