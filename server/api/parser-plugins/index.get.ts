import { defineEventHandler, getQuery } from "h3";
import { getParserPluginRepository } from "../../core/parsers/repository";
import { requireAdminAuth } from "../../utils/requireAdminAuth";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const includeArchived = String(getQuery(event).includeArchived || "") === "true";
  return { code: 0, message: "success", data: await getParserPluginRepository().list({ includeArchived }) };
});
