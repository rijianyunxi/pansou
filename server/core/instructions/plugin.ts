import type { SearchResult } from "../types/models";
import type { SearchPlugin, PluginSearchContext } from "../plugins/manager";
import type { InstructionPluginDefinition } from "./types";
import { executeInstructions } from "./executor";


export class InstructionsPlugin implements SearchPlugin {
  readonly manifest: InstructionPluginDefinition["manifest"];
  constructor(private readonly definition: InstructionPluginDefinition) {
    this.manifest = definition.manifest;
  }
  async search(context: PluginSearchContext): Promise<SearchResult[]> {
    const result = await executeInstructions(this.definition, context.keyword, {
      signal: context.signal,
      limit: this.manifest.maxResults,
    });
    return result.results;
  }
}
