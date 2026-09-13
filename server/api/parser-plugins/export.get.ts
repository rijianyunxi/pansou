import { defineEventHandler, getQuery } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { getParserPluginRepository } from "../../core/parsers/repository";
export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const includeArchived = String(getQuery(event).includeArchived || "") === "true";
  const records = await getParserPluginRepository().list({ includeArchived });
  return { schemaVersion: 1, exportedAt: new Date().toISOString(), plugins: records.map(({ id, status, manifest, code }) => ({ id, status, manifest, code })) };
});
