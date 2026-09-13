import { getSqliteDatabase } from "../storage/sqlite";

/**
 * Secrets are kept in SQLite separately from versioned/exportable plugin
 * definitions. The API never returns values unless they are injected into the
 * server-side execution context.
 */
export interface PluginSecretStore {
  list(pluginId: string): Promise<string[]>;
  get(pluginId: string, name: string): Promise<string | null>;
  getMany(pluginId: string, names: readonly string[]): Promise<Record<string, string>>;
  set(pluginId: string, name: string, value: string): Promise<void>;
  delete(pluginId: string, name: string): Promise<void>;
}

type SecretState = Record<string, Record<string, string>>;
const NAMESPACE = "plugin_secrets";
const KEY = "state";

function read(): SecretState {
  const value = getSqliteDatabase().get<SecretState>(NAMESPACE, KEY, {});
  return value && typeof value === "object" ? value : {};
}

export class SqlitePluginSecretStore implements PluginSecretStore {
  async list(pluginId: string): Promise<string[]> {
    return Object.keys(read()[pluginId] || {}).sort();
  }

  async get(pluginId: string, name: string): Promise<string | null> {
    return read()[pluginId]?.[name] ?? null;
  }

  async getMany(pluginId: string, names: readonly string[]): Promise<Record<string, string>> {
    const bucket = read()[pluginId] || {};
    const out: Record<string, string> = {};
    for (const name of names) if (bucket[name]) out[name] = bucket[name];
    return out;
  }

  async set(pluginId: string, name: string, value: string): Promise<void> {
    const state = read();
    state[pluginId] = { ...(state[pluginId] || {}), [name]: value };
    getSqliteDatabase().set(NAMESPACE, KEY, state);
  }

  async delete(pluginId: string, name: string): Promise<void> {
    const state = read();
    if (!state[pluginId]) return;
    const bucket = { ...state[pluginId] };
    delete bucket[name];
    if (Object.keys(bucket).length) state[pluginId] = bucket;
    else delete state[pluginId];
    getSqliteDatabase().set(NAMESPACE, KEY, state);
  }
}


/** Legacy JSON adapter kept only for importing old data and isolated tests. */
export class JsonPluginSecretStore implements PluginSecretStore {
  private state: { secrets: Record<string, Record<string, string>> } = { secrets: {} };
  private loaded = false;
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const fs = await import("node:fs/promises");
    const path = this.filePath;
    try {
      const raw = await fs.readFile(path, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.secrets && typeof parsed.secrets === "object") this.state = { secrets: parsed.secrets };
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    this.loaded = true;
  }
  constructor(private readonly filePath = process.env.PANHUB_PLUGIN_SECRETS || "data/plugin-secrets.json") {}
  private async persist(): Promise<void> {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(this.state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await fs.rename(temp, this.filePath);
  }
  async list(pluginId: string): Promise<string[]> { await this.ensureLoaded(); return Object.keys(this.state.secrets[pluginId] || {}).sort(); }
  async get(pluginId: string, name: string): Promise<string | null> { await this.ensureLoaded(); return this.state.secrets[pluginId]?.[name] ?? null; }
  async getMany(pluginId: string, names: readonly string[]): Promise<Record<string, string>> { await this.ensureLoaded(); const out: Record<string, string> = {}; for (const name of names) if (this.state.secrets[pluginId]?.[name]) out[name] = this.state.secrets[pluginId][name]!; return out; }
  async set(pluginId: string, name: string, value: string): Promise<void> { await this.ensureLoaded(); this.state.secrets[pluginId] = { ...(this.state.secrets[pluginId] || {}), [name]: value }; await this.persist(); }
  async delete(pluginId: string, name: string): Promise<void> { await this.ensureLoaded(); if (!this.state.secrets[pluginId]) return; delete this.state.secrets[pluginId][name]; if (!Object.keys(this.state.secrets[pluginId]).length) delete this.state.secrets[pluginId]; await this.persist(); }
}

let secretStore: PluginSecretStore | undefined;
export function getPluginSecretStore(): PluginSecretStore {
  return secretStore || (secretStore = new SqlitePluginSecretStore());
}
export function setPluginSecretStore(value: PluginSecretStore): void {
  secretStore = value;
}
