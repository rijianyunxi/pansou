import type { InstructionPluginDefinition, InstructionResponse } from "../core/instructions/types";
import { validateInstructionDefinition } from "../core/instructions/validator";

/** Change response parsing only. Never rebuild request stages, secrets, or pagination from UI shorthand. */
export function updateResponseAdapter(definition: InstructionPluginDefinition, response: InstructionResponse): InstructionPluginDefinition {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(definition.manifest.version);
  if (!match) throw new Error("当前版本不是标准语义版本，请先修正解析器版本。");
  return validateInstructionDefinition({
    ...structuredClone(definition),
    manifest: { ...definition.manifest, version: `${match[1]}.${match[2]}.${Number(match[3]) + 1}` },
    response,
  });
}
