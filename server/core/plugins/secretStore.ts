import { getSqliteDatabase } from "../storage/sqlite";
export interface PluginSecretStore { list(pluginId: string): Promise<string[]>; get(pluginId: string, name: string): Promise<string | null>; getMany(pluginId: string, names: readonly string[]): Promise<Record<string, string>>; set(pluginId: string, name: string, value: string): Promise<void>; delete(pluginId: string, name: string): Promise<void>; }
export class SqlitePluginSecretStore implements PluginSecretStore {
  async list(pluginId: string): Promise<string[]> { return getSqliteDatabase().allRows<{ name: string }>("SELECT name FROM plugin_secrets WHERE plugin_id=? ORDER BY name", pluginId).map(row => row.name); }
  async get(pluginId: string, name: string): Promise<string | null> { return getSqliteDatabase().getRow<{ value: string }>("SELECT value FROM plugin_secrets WHERE plugin_id=? AND name=?", pluginId, name)?.value ?? null; }
  async getMany(pluginId: string, names: readonly string[]): Promise<Record<string, string>> { if (!names.length) return {}; const marks = names.map(() => "?").join(","); const rows = getSqliteDatabase().allRows<{ name: string; value: string }>(`SELECT name,value FROM plugin_secrets WHERE plugin_id=? AND name IN (${marks})`, pluginId, ...names); return Object.fromEntries(rows.map(row => [row.name, row.value])); }
  async set(pluginId: string, name: string, value: string): Promise<void> { getSqliteDatabase().run("INSERT INTO plugin_secrets(plugin_id,name,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(plugin_id,name) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", pluginId, name, value, Date.now()); }
  async delete(pluginId: string, name: string): Promise<void> { getSqliteDatabase().run("DELETE FROM plugin_secrets WHERE plugin_id=? AND name=?", pluginId, name); }
}
let secretStore: PluginSecretStore | undefined;
export function getPluginSecretStore(): PluginSecretStore { return secretStore || (secretStore = new SqlitePluginSecretStore()); }
