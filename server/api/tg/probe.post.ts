import { createError, defineEventHandler, readBody, setHeader } from "h3";
import { buildUserSource } from "../../core/services/upstreamCatalog";
import { probeUpstreamDefinition } from "../../core/services/upstreamProbe";
import type { UpstreamProbe } from "../../../types/source";
import { requireAdminAuth } from "../../utils/requireAdminAuth";

let active = 0;
const channelPattern = /^[A-Za-z0-9_]{5,64}$/;

export default defineEventHandler(async (event): Promise<UpstreamProbe> => {
  setHeader(event, "Cache-Control", "no-store");
  requireAdminAuth(event);
  const body = await readBody(event);
  const channel = typeof body?.channel === "string" ? body.channel.trim().replace(/^@/, "").toLowerCase() : "";
  const keyword = typeof body?.keyword === "string" ? body.keyword.trim() : "";
  if (!channelPattern.test(channel)) throw createError({ statusCode: 400, statusMessage: "Channel must be a public Telegram username" });
  if (!keyword || keyword.length > 100) throw createError({ statusCode: 400, statusMessage: "Keyword must contain 1 to 100 characters" });
  if (active >= 2) throw createError({ statusCode: 429, statusMessage: "At most two source diagnostics may run concurrently" });
  active++;
  try { return await probeUpstreamDefinition(buildUserSource(channel), keyword); }
  finally { active--; }
});
