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
  for (const row of db.allRows<any>("SELECT * FROM tg_channel_policies")) {
    let fallbackUrls: string[] | undefined;
    try { fallbackUrls = row.fallback_urls ? JSON.parse(row.fallback_urls) : undefined; } catch { fallbackUrls = undefined; }
    const policy = sanitizePolicies({ [row.channel]: { ...(row.timeout_ms != null ? { timeoutMs: row.timeout_ms } : {}), ...(row.max_pages != null ? { maxPages: row.max_pages } : {}), ...(row.max_results != null ? { maxResults: row.max_results } : {}), ...(row.max_retries != null ? { maxRetries: row.max_retries } : {}), ...(row.retry_delay_ms != null ? { retryDelayMs: row.retry_delay_ms } : {}), ...(row.fallback ? { fallback: row.fallback } : {}), ...(fallbackUrls ? { fallbackUrls } : {}) } })[row.channel];
    if (policy) policies[row.channel] = policy;
  }
  const channelState = sanitizeChannelStates(Object.fromEntries(db.allRows<any>("SELECT channel,enabled,deleted FROM tg_channel_states").map(row => [row.channel, { enabled: Boolean(row.enabled), deleted: Boolean(row.deleted) }])));
  const parsers: Record<string, TgChannelParserBinding> = {};
  const upstreamParsers: UpstreamParserBindingMap = {};
  for (const row of db.allRows<any>("SELECT scope,source_id,plugin_id,updated_at FROM parser_bindings")) {
    const target = row.scope === "telegram" ? parsers : upstreamParsers;
    target[row.source_id] = { pluginId: row.plugin_id, updatedAt: row.updated_at };
  }
  return { policies, channelState, parsers, upstreamParsers };
}

function writeState(next: TgChannelSettingsState): void {
  const db = getSqliteDatabase();
  const now = Date.now();
  db.transaction(() => {
    db.run("DELETE FROM tg_channel_policies");
    for (const [channel, policy] of Object.entries(next.policies)) {
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

    db.run("DELETE FROM tg_channel_states");
    for (const [channel, state] of Object.entries(next.channelState)) {
      db.run("INSERT INTO tg_channel_states(channel,enabled,deleted,updated_at) VALUES(?,?,?,?)", channel, state.enabled ? 1 : 0, state.deleted ? 1 : 0, now);
    }

    db.run("DELETE FROM parser_bindings");
    for (const [sourceId, binding] of Object.entries(next.parsers)) {
      db.run("INSERT INTO parser_bindings(scope,source_id,plugin_id,updated_at) VALUES(?,?,?,?)", "telegram", sourceId, binding.pluginId, binding.updatedAt);
    }
    for (const [sourceId, binding] of Object.entries(next.upstreamParsers)) {
      db.run("INSERT INTO parser_bindings(scope,source_id,plugin_id,updated_at) VALUES(?,?,?,?)", "upstream", sourceId, binding.pluginId, binding.updatedAt);
    }
  });
  version++;
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
 * Persistent cache token for every TG setting, including parser bindings.
 * The legacy numeric counter is kept for callers/tests that only need a local
 * monotonic signal; search caches must use this token so a restart or another
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

export function getTgChannelParser(channel: string): string | null {
  const name = (channel || "").trim().replace(/^@/, "").toLowerCase();
  return name ? getTgChannelParsers()[name]?.pluginId || null : null;
}

export function setTgChannelParser(channel: string, pluginId: string | null): TgChannelParserBinding | null {
  const name = (channel || "").trim().replace(/^@/, "").toLowerCase();
  if (!TG_CHANNEL_PATTERN.test(name)) throw new Error(`invalid channel username: ${String(channel).slice(0, 64)}`);
  const current = readState();
  const parsers = { ...current.parsers };
  if (!pluginId?.trim()) {
    delete parsers[name];
    writeState({ ...current, parsers });
    return null;
  }
  const binding = { pluginId: pluginId.trim(), updatedAt: new Date().toISOString() };
  parsers[name] = binding;
  writeState({ ...current, parsers });
  return { ...binding };
}

export function getUpstreamParser(id: string): string | null {
  const name = (id || "").trim().toLowerCase();
  return name ? readState().upstreamParsers[name]?.pluginId || null : null;
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
  const current = readState();
  const upstreamParsers = { ...current.upstreamParsers };
  if (!pluginId?.trim()) {
    delete upstreamParsers[name];
    writeState({ ...current, upstreamParsers });
    return null;
  }
  const binding = { pluginId: pluginId.trim(), updatedAt: new Date().toISOString() };
  upstreamParsers[name] = binding;
  writeState({ ...current, upstreamParsers });
  return { ...binding };
}

export function saveTgChannelPolicies(patch: unknown): TgChannelPolicyMap {
  const current = readState();
  const next = { ...current, policies: sanitizePolicies(patch) };
  writeState(next);
  return structuredClone(next.policies);
}

export function setTgChannelState(channel: string, patch: { enabled?: boolean; deleted?: boolean }): TgChannelStateEntry {
  const name = (channel || "").trim().replace(/^@/, "").toLowerCase();
  if (!TG_CHANNEL_PATTERN.test(name)) throw new Error(`invalid channel username: ${String(channel).slice(0, 64)}`);
  const current = readState();
  const existing = current.channelState[name] || { enabled: true, deleted: false };
  const entry = {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : existing.enabled,
    deleted: typeof patch.deleted === "boolean" ? patch.deleted : existing.deleted,
  } satisfies TgChannelStateEntry;
  const channelState = { ...current.channelState };
  if (entry.enabled && !entry.deleted) delete channelState[name];
  else channelState[name] = entry;
  writeState({ ...current, channelState });
  return { ...entry };
}

export function clearTgChannelState(channel: string): void {
  const name = (channel || "").trim().replace(/^@/, "").toLowerCase();
  if (!name) return;
  const current = readState();
  if (!current.channelState[name]) return;
  const channelState = { ...current.channelState };
  delete channelState[name];
  writeState({ ...current, channelState });
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
