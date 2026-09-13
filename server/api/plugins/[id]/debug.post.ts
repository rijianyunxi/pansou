import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { executeInstructions } from "../../../core/instructions/executor";
import { getPluginRepository } from "../../../core/plugins/repository";
import { getPluginSecretStore } from "../../../core/plugins/secretStore";
import { enforceAdminRateLimit } from "../../../utils/adminSecurity";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  enforceAdminRateLimit(event, "plugin-debug", {
    limit: 20,
    windowMs: 60_000,
  });
  const id = getRouterParam(event, "id") || "";
  const body = await readBody(event);
  const actor = String(body?.actor || "admin").slice(0, 100);
  const repository = getPluginRepository();
  const record = await repository.get(id);
  if (!record) {
    throw createError({ statusCode: 404, statusMessage: "plugin not found" });
  }
  if (record.definition.manifest.kind !== "instructions") {
    throw createError({
      statusCode: 400,
      statusMessage: "only instructions plugins can be debugged",
    });
  }
  const keyword = typeof body?.keyword === "string" ? body.keyword.trim() : "";
  if (!keyword) {
    throw createError({ statusCode: 400, statusMessage: "keyword is required" });
  }

  const started = Date.now();
  try {
    // Admin debug runs the exact production path, including secret injection.
    const secrets = await getPluginSecretStore().getMany(
      id,
      record.definition.request.secrets ?? []
    );
    const execution = await executeInstructions(record.definition, keyword, {
      secrets,
    });
    await repository.audit(id, "debugged", actor, {
      version: record.definition.manifest.version,
      resultCount: execution.results.length,
      elapsedMs: Date.now() - started,
    });
    return { code: 0, message: "success", data: execution };
  } catch (error) {
    await repository
      .audit(id, "debug_failed", actor, {
        version: record.definition.manifest.version,
        elapsedMs: Date.now() - started,
      })
      .catch(() => undefined);
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
