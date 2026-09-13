import type { PluginHealthStatus } from "./pluginHealth";
import { getSqliteDatabase } from "../storage/sqlite";

export interface PluginHealthStore {
  load(): Promise<Record<string, PluginHealthStatus>>;
  save(snapshot: Record<string, PluginHealthStatus>): Promise<void>;
}

export class SqlitePluginHealthStore implements PluginHealthStore {
  private readonly database;
  constructor(path?: string) { this.database = getSqliteDatabase(path); }
  async load(): Promise<Record<string, PluginHealthStatus>> {
    return this.database.get("plugin_health", "state", {});
  }
  async save(snapshot: Record<string, PluginHealthStatus>): Promise<void> {
    this.database.set("plugin_health", "state", snapshot);
  }
}

/** Legacy name retained for imports; runtime factory uses SQLite. */
export class JsonPluginHealthStore extends SqlitePluginHealthStore {}
let healthStore: PluginHealthStore | undefined;
export function getPluginHealthStore(): PluginHealthStore { return healthStore || (healthStore = new SqlitePluginHealthStore()); }
export function setPluginHealthStore(value: PluginHealthStore): void { healthStore = value; }
