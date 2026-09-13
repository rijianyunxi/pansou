import { createError, defineEventHandler, readBody, setHeader } from "h3";
import { getUnifiedUpstream } from "../../core/services/upstreamCatalog";
import { probeConfiguredUpstream } from "../../core/services/upstreamProbe";
import type { UpstreamProbe } from "../../../config/upstreams";
import { probeTgChannel } from "../../core/services/tg";
import { requireAdminAuth } from "../../utils/requireAdminAuth";

let active = 0;
export default defineEventHandler(async (event) => {
  setHeader(event, "Cache-Control", "no-store");
  requireAdminAuth(event);
  const body = await readBody(event);
  const source = typeof body?.sourceId === "string" ? getUnifiedUpstream(body.sourceId) : undefined;
  if (!source) throw createError({ statusCode: 400, statusMessage: "Unknown upstream" });
  if (typeof body?.keyword !== "string" || !body.keyword.trim() || body.keyword.length > 100) {
    throw createError({ statusCode: 400, statusMessage: "Keyword must contain 1 to 100 characters" });
  }
  if (active >= 2) throw createError({ statusCode: 429, statusMessage: "At most two diagnostics may run concurrently" });
  active++;
  try {
    if (source.sourceKind === "telegram" && source.channel) {
      const tg = await probeTgChannel(source.channel, body.keyword.trim(), 20, {
        fallbackUrls: source.fallbackUrls,
        maxRetries: source.retry?.maxRetries ?? source.request?.retry?.maxRetries,
        retryDelayMs: source.retry?.delayMs ?? source.request?.retry?.delayMs,
        timeoutMs: source.request?.timeoutMs,
        userAgent: source.request?.headers?.["user-agent"],
        headers: source.request?.headers,
        primaryUrl: source.url,
      });
      const report: UpstreamProbe = {
        sourceId: source.id,
        checkedAt: tg.checkedAt,
        state: tg.state,
        message: tg.message,
        elapsedMs: tg.elapsedMs,
        httpStatus: tg.httpStatus,
        traces: tg.attempts.map((attempt) => ({
          url: attempt.request.url,
          method: attempt.request.method,
          status: attempt.response?.status ?? null,
          elapsedMs: attempt.elapsedMs,
          bytes: attempt.response?.bodyLength ?? 0,
          contentType: attempt.response?.headers?.["content-type"] || "text/html",
          ...(attempt.error ? { error: attempt.error } : {}),
        })),
        raw: tg.upstreamResponse?.body || "",
        rawTruncated: tg.upstreamResponse?.bodyTruncated || false,
        results: tg.results,
      };
      return report;
    }
    return await probeConfiguredUpstream(source.id, body.keyword.trim());
  } finally {
    active--;
  }
});
