import { createError, defineEventHandler, readBody } from "h3";
import type { InstructionPluginDefinition } from "../../core/instructions/types";
import { getPluginRepository } from "../../core/plugins/repository";
import { requireAdminAuth } from "../../utils/requireAdminAuth";

const MAX_IMPORTS = 100;

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const body = await readBody(event);
  const definitions = (Array.isArray(body?.definitions)
    ? body.definitions
    : Array.isArray(body)
      ? body
      : []) as InstructionPluginDefinition[];
  if (!definitions.length || definitions.length > MAX_IMPORTS) {
    throw createError({
      statusCode: 400,
      statusMessage: `definitions must contain 1-${MAX_IMPORTS} plugins`,
    });
  }

  const repository = getPluginRepository();
  const actor = String(body?.actor || "admin").slice(0, 100);
  const imported = [];
  try {
    for (const definition of definitions) {
      imported.push(
        await repository.saveDraft(definition, actor, "Imported configuration")
      );
    }
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
  return { code: 0, message: "imported", data: imported };
});
