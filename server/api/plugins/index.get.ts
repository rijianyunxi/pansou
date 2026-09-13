import { defineEventHandler, getQuery } from "h3";
import { getPluginRepository } from "../../core/plugins/repository";
import { requireAdminAuth } from "../../utils/requireAdminAuth";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const query = getQuery(event);
  const includeArchived = String(query.includeArchived || "") === "true";
  return {
    code: 0,
    message: "success",
    data: await getPluginRepository().list({ includeArchived }),
  };
});
