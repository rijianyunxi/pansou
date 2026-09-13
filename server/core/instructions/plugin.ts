import type { SearchResult } from "../types/models";
import type { SearchPlugin, PluginSearchContext } from "../plugins/manager";
import type { InstructionPluginDefinition } from "./types";
import { executeInstructions } from "./executor";


export type SecretValuesLoader = (
  pluginId: string,
  names: readonly string[]
) => Promise<Record<string, string>>;

export class InstructionsPlugin implements SearchPlugin {
  readonly manifest: InstructionPluginDefinition["manifest"];
  constructor(
    private readonly definition: InstructionPluginDefinition,
    private readonly loadSecrets?: SecretValuesLoader,
  ) {
    this.manifest = definition.manifest;
  }
  async search(context: PluginSearchContext): Promise<SearchResult[]> {
    const declared = this.definition.request.secrets ?? [];
    const secrets =
      declared.length && this.loadSecrets
        ? await this.loadSecrets(this.manifest.id, declared)
        : undefined;
    const result = await executeInstructions(this.definition, context.keyword, {
      signal: context.signal,
      limit: this.manifest.maxResults,
      secrets,
    });
    return result.results;
  }
}
