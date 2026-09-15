import type { SearchResult } from "../types/models";
import type { SearchPlugin, PluginSearchContext } from "../plugins/manager";
import type { SourceDefinition } from "./types";
import { executeSource } from "./executor";


export class ConfiguredSourcePlugin implements SearchPlugin {
  readonly manifest: SourceDefinition["manifest"];
  constructor(private readonly definition: SourceDefinition) {
    this.manifest = definition.manifest;
  }
  async search(context: PluginSearchContext): Promise<SearchResult[]> {
    const result = await executeSource(this.definition, context.keyword, {
      signal: context.signal,
      limit: this.manifest.maxResults,
    });
    return result.results;
  }
}
