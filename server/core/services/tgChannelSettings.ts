import {
  TG_POLICY_RANGES,
  sanitizeChannelStates,
  type TgChannelPolicy,
  type TgChannelPolicyMap,
  type TgChannelStateEntry,
  type TgChannelStateMap,
} from "../../utils/telegramSettings";
import { normalizeTelegramChannels, TG_CHANNEL_PATTERN } from "../../../utils/telegramChannels";
import { getSqliteDatabase } from "../storage/sqlite";

export interface TgChannelParserBinding {
  pluginId: string | null;
  updatedAt: string;
}
export type UpstreamParserBindingMap = Record<string, TgChannelParserBinding>;

interface TgChannelSettingsState {
  policies: TgChannelPolicyMap;
  channelState: TgChannelStateMap;
  parsers: Record<string, TgChannelParserBinding>;
  upstreamParsers: UpstreamParserBindingMap;
}

const NUMERIC_FIELDS = ["timeoutMs", "maxPages", "maxResults", "maxRetries", "retryDelayMs"] as const;
let version = 0;


function sanitizePolicies(raw: unknown): TgChannelPolicyMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: TgChannelPolicyMap = {};
  for (const [rawKey, rawPolicy] of Object.entries(raw as Record<string, unknown>)) {
    const name = String(rawKey).trim().replace(/^@/, "").toLowerCase();
    if (!TG_CHANNEL_PATTERN.test(name) || !rawPolicy || typeof rawPolicy !== "object" || Array.isArray(rawPolicy)) continue;
    const input = rawPolicy as Record<string, unknown>;
    const policy: TgChannelPolicy = {};
    for (const field of NUMERIC_FIELDS) {
      const range = TG_POLICY_RANGES[field];
      const value = input[field];
      if (typeof value === "number" && Number.isInteger(value) && value >= range.min && value <= range.max) policy[field] = value;
    }
    if (input.fallback === "direct" || input.fallback === "jina") policy.fallback = input.fallback;
    if (Array.isArray(input.fallbackUrls)) {
      const urls = [...new Set(input.fallbackUrls
        .filter((url): url is string => typeof url === "string" && Boolean(url.trim()))
        .map((url) => url.trim().slice(0, 500)))].slice(0, 3);
      if (urls.length) policy.fallbackUrls = urls;
    }
    if (Object.keys(policy).length) out[name] = policy;
  }
  return out;
}


function readState(): TgChannelSettingsState {
  const db = getSqliteDatabase();
  const policies: TgChannelPolicyMap = {};
  for (const row of db.allRows<any>("SELECT * FROM tg_channel_policies ORDER BY channel")) {
    let fallbackUrls: string[] | undefined;
    try { fallbackUrls = row.fallback_urls ? JSON.parse(row.fallback_urls) : undefined; } catch { fallbackUrls = undefined; }
    const channel = String(row.channel || "").trim().replace(/^@/, "").toLowerCase();
    const policy = sanitizePolicies({ [channel]: { ...(row.timeout_ms != null ? { timeoutMs: row.timeout_ms } : {}), ...(row.max_pages != null ? { maxPages: row.max_pages } : {}), ...(row.max_results != null ? { maxResults: row.max_results } : {}), ...(row.max_retries != null ? { maxRetries: row.max_retries } : {}), ...(row.retry_delay_ms != null ? { retryDelayMs: row.retry_delay_ms } : {}), ...(row.fallback ? { fallback: row.fallback } : {}), ...(fallbackUrls ? { fallbackUrls } : {}) } })[channel];
    if (policy) policies[channel] = policy;
  }
  const channelState = sanitizeChannelStates(Object.fromEntries(db.allRows<any>("SELECT channel,enabled,deleted FROM tg_channel_states ORDER BY channel").map(row => [row.channel, { enabled: Boolean(row.enabled), deleted: Boolean(row.deleted) }])));
  const parsers: Record<string, TgChannelParserBinding> = {};
  const upstreamParsers: UpstreamParserBindingMap = {};
  for (const row of db.allRows<any>("SELECT scope,source_id,plugin_id,updated_at FROM parser_bindings ORDER BY scope,source_id")) {
    const binding = { pluginId: row.plugin_id, updatedAt: row.updated_at };
    if (row.scope === "telegram") parsers[row.source_id] = binding;
    else if (row.scope === "upstream") upstreamParsers[row.source_id] = binding;
  }
  return { policies, channelState, parsers, upstreamParsers };
}

function bumpVersion(): void {
  version++;
}

function insertPolicyRows(policies: TgChannelPolicyMap, now: number): void {
  const db = getSqliteDatabase();
  for (const [channel, policy] of Object.entries(policies)) {
    db.run(
      "INSERT INTO tg_channel_policies(channel,timeout_ms,max_pages,max_results,max_retries,retry_delay_ms,fallback,fallback_urls,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
      channel,
      policy.timeoutMs ?? null,
      policy.maxPages ?? null,
      policy.maxResults ?? null,
      policy.maxRetries ?? null,
      policy.retryDelayMs ?? null,
      policy.fallback ?? null,
      policy.fallbackUrls ? JSON.stringify(policy.fallbackUrls) : null,
      now,
    );
  }
}

export function getTgChannelPolicies(): TgChannelPolicyMap {
  return structuredClone(readState().policies);
}

export function getTgChannelPolicy(channel: string): TgChannelPolicy | undefined {
  const name = (channel || "").trim().replace(/^@/, "").toLowerCase();
  return name ? getTgChannelPolicies()[name] : undefined;
}

export function getTgChannelStates(): TgChannelStateMap {
  return structuredClone(readState().channelState);
}

export function getTgChannelState(channel: string): TgChannelStateEntry | undefined {
  const name = (channel || "").trim().replace(/^@/, "").toLowerCase();
  return name ? getTgChannelStates()[name] : undefined;
}

export function getTgChannelPoliciesVersion(): number {
  return version;
}

/**
 * Persistent cache token for every Telegram setting, including parser bindings.
 * The numeric counter is a process-local monotonic signal; search caches must
 * use this persistent token so a restart or another
 * process cannot serve results parsed with an older binding.
 */
export function getTgChannelSettingsVersion(): string {
  const db = getSqliteDatabase();
  const row = db.getRow<{ updated_at: number | null }>(
    "SELECT MAX(updated_at) AS updated_at FROM (SELECT updated_at FROM tg_channel_policies UNION ALL SELECT updated_at FROM tg_channel_states)",
  );
  const parserRow = db.getRow<{ updated_at: string | null }>(
    "SELECT MAX(updated_at) AS updated_at FROM parser_bindings",
  );
  return `${row?.updated_at ?? 0}:${parserRow?.updated_at ?? ""}:${JSON.stringify(readState())}`;
}

export function getTgChannelParsers(): Record<string, TgChannelParserBinding> {
  return structuredClone(readState().parsers);
}


export function setTgChannelParser(channel: string, pluginId: string | null): TgChannelParserBinding | null {
  const name = (channel || "").trim().replace(/^@/, "").toLowerCase();
  if (!TG_CHANNEL_PATTERN.test(name)) throw new Error(`invalid channel username: ${String(channel).slice(0, 64)}`);
  const db = getSqliteDatabase();
  const normalizedPluginId = pluginId?.trim();
  if (!normalizedPluginId) {
    const result = db.run("DELETE FROM parser_bindings WHERE scope=? AND source_id=?", "telegram", name);
    if (result.changes) bumpVersion();
    return null;
  }
  const binding = { pluginId: normalizedPluginId, updatedAt: new Date().toISOString() };
  db.run(
    "INSERT INTO parser_bindings(scope,source_id,plugin_id,updated_at) VALUES(?,?,?,?) ON CONFLICT(scope,source_id) DO UPDATE SET plugin_id=excluded.plugin_id,updated_at=excluded.updated_at",
    "telegram", name, binding.pluginId, binding.updatedAt,
  );
  bumpVersion();
  return { ...binding };
}


export function getUpstreamParsers(): UpstreamParserBindingMap {
  return structuredClone(readState().upstreamParsers);
}

export interface ParserPluginBindingReference {
  scope: "upstream" | "telegram";
  id: string;
}

export function getParserPluginBindingReferences(pluginId: string): ParserPluginBindingReference[] {
  const target = pluginId.trim().toLowerCase();
  if (!target) return [];
  const state = readState();
  const references: ParserPluginBindingReference[] = [];
  for (const [id, binding] of Object.entries(state.upstreamParsers)) {
    if (binding.pluginId?.trim().toLowerCase() === target) references.push({ scope: "upstream", id });
  }
  for (const [id, binding] of Object.entries(state.parsers)) {
    if (binding.pluginId?.trim().toLowerCase() === target) references.push({ scope: "telegram", id });
  }
  return references;
}

export function setUpstreamParser(id: string, pluginId: string | null): TgChannelParserBinding | null {
  const name = (id || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(name)) throw new Error(`invalid upstream id: ${id}`);
  const db = getSqliteDatabase();
  const normalizedPluginId = pluginId?.trim();
  if (!normalizedPluginId) {
    const result = db.run("DELETE FROM parser_bindings WHERE scope=? AND source_id=?", "upstream", name);
    if (result.changes) bumpVersion();
    return null;
  }
  const binding = { pluginId: normalizedPluginId, updatedAt: new Date().toISOString() };
  db.run(
    "INSERT INTO parser_bindings(scope,source_id,plugin_id,updated_at) VALUES(?,?,?,?) ON CONFLICT(scope,source_id) DO UPDATE SET plugin_id=excluded.plugin_id,updated_at=excluded.updated_at",
    "upstream", name, binding.pluginId, binding.updatedAt,
  );
  bumpVersion();
  return { ...binding };
}

export function saveTgChannelPolicies(patch: unknown): TgChannelPolicyMap {
  const policies = sanitizePolicies(patch);
  const db = getSqliteDatabase();
  db.transaction(() => {
    db.run("DELETE FROM tg_channel_policies");
    insertPolicyRows(policies, Date.now());
  });
  bumpVersion();
  return structuredClone(policies);
}

export function setTgChannelState(channel: string, patch: { enabled?: boolean; deleted?: boolean }): TgChannelStateEntry {
  const name = (channel || "").trim().replace(/^@/, "").toLowerCase();
  if (!TG_CHANNEL_PATTERN.test(name)) throw new Error(`invalid channel username: ${String(channel).slice(0, 64)}`);
  const db = getSqliteDatabase();
  const enabled = typeof patch.enabled === "boolean" ? (patch.enabled ? 1 : 0) : null;
  const deleted = typeof patch.deleted === "boolean" ? (patch.deleted ? 1 : 0) : null;
  const entry = db.transaction(() => {
    db.run(
      `INSERT INTO tg_channel_states(channel,enabled,deleted,updated_at) VALUES(?,?,?,?)
       ON CONFLICT(channel) DO UPDATE SET
         enabled=COALESCE(?,tg_channel_states.enabled),
         deleted=COALESCE(?,tg_channel_states.deleted),
         updated_at=excluded.updated_at`,
      name, enabled ?? 1, deleted ?? 0, Date.now(), enabled, deleted,
    );
    const row = db.getRow<{ enabled: number; deleted: number }>(
      "SELECT enabled,deleted FROM tg_channel_states WHERE channel=?",
      name,
    )!;
    const next = { enabled: Boolean(row.enabled), deleted: Boolean(row.deleted) };
    if (next.enabled && !next.deleted) db.run("DELETE FROM tg_channel_states WHERE channel=?", name);
    return next;
  });
  bumpVersion();
  return entry;
}

export function clearTgChannelState(channel: string): void {
  const name = (channel || "").trim().replace(/^@/, "").toLowerCase();
  if (!name) return;
  const result = getSqliteDatabase().run("DELETE FROM tg_channel_states WHERE channel=?", name);
  if (result.changes) bumpVersion();
}

export interface PurgedTgChannel {
  channel: string;
  removedSystemEntries: number;
  removedSearchEntries: number;
  removedPolicy: boolean;
  removedParserBindings: number;
  removedHealthRecords: number;
  removedUpstreamDefinitions: number;
}

/**
 * Permanently remove an archived Telegram channel and all of its local configuration/history.
 * A channel must already be in the recycle bin (`deleted=true`) before it can be purged.
 */
export function purgeTgChannel(channel: string): PurgedTgChannel {
  const name = (channel || "").trim().replace(/^@/, "").toLowerCase();
  if (!TG_CHANNEL_PATTERN.test(name)) throw new Error(`invalid channel username: ${String(channel).slice(0, 64)}`);
  const db = getSqliteDatabase();
  const archived = db.getRow<{ deleted: number }>("SELECT deleted FROM tg_channel_states WHERE channel=?", name);
  if (!archived?.deleted) throw new Error("Telegram channel must be archived before permanent deletion");

  const result = db.transaction(() => {
    const now = Date.now();
    const removedSystemEntries = db.run("DELETE FROM system_channels WHERE name=?", name).changes;
    const removedSearchEntries = db.run("DELETE FROM search_setting_channels WHERE channel=?", name).changes;
    const removedPolicy = db.run("DELETE FROM tg_channel_policies WHERE channel=?", name).changes > 0;
    const removedParserBindings =
      db.run("DELETE FROM parser_bindings WHERE scope='telegram' AND source_id=?", name).changes +
      db.run("DELETE FROM parser_bindings WHERE scope='upstream' AND source_id=?", `tg-${name}`).changes;
    const removedHealthRecords = db.run("DELETE FROM tg_channel_health WHERE channel=?", name).changes;
    const removedUpstreamDefinitions = db.run(
      "DELETE FROM upstream_definitions WHERE source_kind='telegram' AND (channel=? OR id=?)",
      name,
      `tg-${name}`,
    ).changes;
    db.run("DELETE FROM deleted_upstreams WHERE id=?", `tg-${name}`);
    db.run("DELETE FROM tg_channel_states WHERE channel=?", name);

    for (const kind of ["priority", "default"]) {
      const rows = db.allRows<{ name: string }>("SELECT name FROM system_channels WHERE kind=? ORDER BY position,name", kind);
      rows.forEach((row, position) => db.run("UPDATE system_channels SET position=? WHERE kind=? AND name=?", position, kind, row.name));
    }
    const searchRows = db.allRows<{ channel: string }>("SELECT channel FROM search_setting_channels ORDER BY position,channel");
    searchRows.forEach((row, position) => db.run("UPDATE search_setting_channels SET position=? WHERE channel=?", position, row.channel));

    if (removedSystemEntries) db.run("UPDATE system_settings SET updated_at=? WHERE id=1", now);
    if (removedSearchEntries) db.run("UPDATE search_settings SET updated_at=? WHERE id=1", now);

    return {
      channel: name,
      removedSystemEntries,
      removedSearchEntries,
      removedPolicy,
      removedParserBindings,
      removedHealthRecords,
      removedUpstreamDefinitions,
    };
  });
  bumpVersion();
  return result;
}


export function filterEffectiveTgChannels(channels: string[]): string[] {
  const normalized = normalizeTelegramChannels(Array.isArray(channels) ? channels : []).filter((name) => TG_CHANNEL_PATTERN.test(name));
  const states = getTgChannelStates();
  return normalized.filter((name) => {
    const state = states[name];
    return !state || (state.enabled && !state.deleted);
  });
}

export function countEffectiveTgChannels(channels: string[]): number {
  return filterEffectiveTgChannels(channels).length;
}
