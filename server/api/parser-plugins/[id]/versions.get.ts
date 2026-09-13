import { createError, defineEventHandler, getRouterParam } from "h3";
import { getParserPluginRepository } from "../../../core/parsers/repository";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const id = getRouterParam(event, "id") || "";
  const record = await getParserPluginRepository().get(id);
  if (!record) throw createError({ statusCode: 404, statusMessage: "parser plugin not found" });
  return {
    code: 0,
    data: record.versions.map(({ version, manifest, createdAt, createdBy, changelog }) => ({
      version, manifest, createdAt, createdBy, changelog,
      published: record.publishedVersion === version && record.status === "published",
    })),
  };
});
