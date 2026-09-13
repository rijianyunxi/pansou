import {
  createError,
  defineEventHandler,
  getRouterParam,
  readBody,
} from "h3";
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
  const body = await readBody(event).catch(() => ({}));
  const actor = String(body?.actor || "admin").slice(0, 100);
  const keyword = typeof body?.keyword === "string" ? body.keyword.trim() : "";
  const repository = getPluginRepository();
  const record = await repository.get(id);
  if (!record) {
    throw createError({ statusCode: 404, statusMessage: "plugin not found" });
  }

  try {
    if (!keyword) throw new Error("keyword is required for sample parsing");
    const secrets = await getPluginSecretStore().getMany(
      id,
      record.definition.request.secrets ?? []
    );
    const execution = await executeInstructions(record.definition, keyword, {
      secrets,
    });
    const validated = await repository.validate(id, actor, {
      sampleParsed: true,
      sampleResultCount: execution.results.length,
    });
    return {
      code: 0,
      message: "validated",
      data: validated,
      sample: execution,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await repository
      .validate(id, actor, { sampleParsed: false, errors: [message] })
      .catch(() => undefined);
    throw createError({ statusCode: 400, statusMessage: message });
  }
});
