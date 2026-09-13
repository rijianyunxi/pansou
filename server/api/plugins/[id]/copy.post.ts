import {
  createError,
  defineEventHandler,
  getRouterParam,
  readBody,
} from "h3";
import { getPluginRepository } from "../../../core/plugins/repository";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const sourceId = getRouterParam(event, "id") || "";
  const body = await readBody(event);
  const targetId = String(body?.id || "").trim().toLowerCase();
  if (!ID_PATTERN.test(targetId)) {
    throw createError({
      statusCode: 400,
      statusMessage: "id must contain 2-64 lowercase letters, numbers or hyphens",
    });
  }

  const repository = getPluginRepository();
  const source = await repository.get(sourceId);
  if (!source) {
    throw createError({ statusCode: 404, statusMessage: "plugin not found" });
  }
  if (await repository.get(targetId)) {
    throw createError({ statusCode: 409, statusMessage: "target plugin already exists" });
  }

  const definition = structuredClone(source.definition);
  definition.manifest = {
    ...definition.manifest,
    id: targetId,
    name: String(body?.name || `${definition.manifest.name} Copy`).slice(0, 100),
    version: String(body?.version || "1.0.0").slice(0, 40),
  };
  try {
    return {
      code: 0,
      message: "copied",
      data: await repository.saveDraft(
        definition,
        String(body?.actor || "admin").slice(0, 100),
        `Copied from ${sourceId}`
      ),
    };
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
});
