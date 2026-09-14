import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { getParserPluginRepository } from "../../../core/parsers/repository";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const id = getRouterParam(event, "id") || "";
  const body = await readBody(event).catch(() => ({}));
  const version = String(body?.version || "").trim();
  if (!version) throw createError({ statusCode: 400, statusMessage: "version is required" });
  const record = await getParserPluginRepository().get(id);
  if (!record) throw createError({ statusCode: 404, statusMessage: "parser plugin not found" });
  const target = record.versions.find((item) => item.version === version);
  if (!target) throw createError({ statusCode: 400, statusMessage: `找不到解析器版本: ${version}` });
  try {
    // Rollback is a hot operation: the selected immutable version becomes the
    // published version immediately and no service restart is required.
    const saved = await getParserPluginRepository().saveDraft(
      { manifest: target.manifest, code: target.code },
      String(body?.actor || "admin").slice(0, 100),
      `Rollback to ${version}`,
    );
    const published = await getParserPluginRepository().publish(id, String(body?.actor || "admin").slice(0, 100));
    return { code: 0, message: "rollback", data: published ?? saved };
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : String(error) });
  }
});
