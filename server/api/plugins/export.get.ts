import { defineEventHandler, getQuery } from "h3";
import { getPluginRepository } from "../../core/plugins/repository";
import { requireAdminAuth } from "../../utils/requireAdminAuth";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const includeArchived = getQuery(event).includeArchived === "true";
  const records = await getPluginRepository().list({ includeArchived });
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    definitions: records.map((record) => record.definition),
  };
});
