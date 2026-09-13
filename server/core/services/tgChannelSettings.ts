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

const DB_NAMESPACE = "tg_channel_settings";
const DB_KEY = "state";
const NUMERIC_FIELDS = ["timeoutMs", "maxPages", "maxResults", "maxRetries", "retryDelayMs"] as const;
let version = 0;

function emptyState(): TgChannelSettingsState {
  return { policies: {}, channelState: {}, parsers: {}, upstreamParsers: {} };
}

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

function sanitizeParsers(raw: unknown): Record<string, TgChannelParserBinding> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, TgChannelParserBinding> = {};
  for (const [rawKey, value] of Object.entries(raw as Record<string, unknown>)) {
    const channel = rawKey.trim().replace(/^@/, "").toLowerCase();
    if (!TG_CHANNEL_PATTERN.test(channel) || !value || typeof value !== "object") continue;
    const input = value as Record<string, unknown>;
    const pluginId = typeof input.pluginId === "string" && input.pluginId.trim() ? input.pluginId.trim() : null;
    if (pluginId) out[channel] = { pluginId, updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : new Date(0).toISOString() };
  }
  return out;
}

function sanitizeUpstreamParsers(raw: unknown): UpstreamParserBindingMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: UpstreamParserBindingMap = {};
  for (const [rawKey, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = rawKey.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(id) || !value || typeof value !== "object") continue;
    const input = value as Record<string, unknown>;
    const pluginId = typeof input.pluginId === "string" && input.pluginId.trim() ? input.pluginId.trim() : null;
    if (pluginId) out[id] = { pluginId, updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : new Date(0).toISOString() };
  }
  return out;
}

function readState(): TgChannelSettingsState {
  const raw = getSqliteDatabase().get(DB_NAMESPACE, DB_KEY, emptyState()) as Partial<TgChannelSettingsState>;
  return {
    policies: sanitizePolicies(raw.policies),
    channelState: sanitizeChannelStates(raw.channelState),
    parsers: sanitizeParsers(raw.parsers),
    upstreamParsers: sanitizeUpstreamParsers(raw.upstreamParsers),
  };
}

function writeState(next: TgChannelSettingsState): void {
  getSqliteDatabase().set(DB_NAMESPACE, DB_KEY, next);
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
  return `${db.getUpdatedAt(DB_NAMESPACE, DB_KEY) ?? 0}:${JSON.stringify(readState())}`;
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
