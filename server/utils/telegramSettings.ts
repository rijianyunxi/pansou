import { createError } from "h3";
import { normalizeTelegramChannels, TG_CHANNEL_PATTERN } from "../../utils/telegramChannels";
export const MAX_SYSTEM_TG_CHANNELS = 200;
export interface TgChannelStateEntry { enabled: boolean; deleted: boolean; }
export type TgChannelStateMap = Record<string, TgChannelStateEntry>;

export function parseSystemChannels(value: unknown): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw createError({ statusCode: 400, statusMessage: "channels must be null or an array of public usernames" });
  if (value.length > MAX_SYSTEM_TG_CHANNELS) throw createError({ statusCode: 400, statusMessage: `channels support at most ${MAX_SYSTEM_TG_CHANNELS} entries` });
  const normalized = normalizeTelegramChannels(value as string[]);
  for (const name of normalized) if (!TG_CHANNEL_PATTERN.test(name)) throw createError({ statusCode: 400, statusMessage: `invalid channel username: ${name.slice(0, 64)}` });
  return normalized;
}
export function sanitizeChannelStates(value: unknown): TgChannelStateMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: TgChannelStateMap = {};
  for (const [rawKey, rawEntry] of Object.entries(value as Record<string, unknown>)) {
    const name = String(rawKey).trim().replace(/^@/, "").toLowerCase();
    if (!TG_CHANNEL_PATTERN.test(name) || !rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) continue;
    const input = rawEntry as Record<string, unknown>;
    const enabled = typeof input.enabled === "boolean" ? input.enabled : true;
    const deleted = typeof input.deleted === "boolean" ? input.deleted : false;
    if (enabled && !deleted) continue;
    out[name] = { enabled, deleted };
  }
  return out;
}
export function normalizeTgChannelParam(value: string | undefined | null): string { return String(value ?? "").trim().replace(/^@/, "").toLowerCase(); }
export function tgChannelOrigin(channel: string, customChannels: string[] | null, builtinDefaults: string[]): "builtin" | "custom" {
  const name = normalizeTgChannelParam(channel);
  if (new Set(normalizeTelegramChannels(customChannels ?? [])).has(name)) return "custom";
  if (new Set(normalizeTelegramChannels(builtinDefaults ?? [])).has(name)) return "builtin";
  return "custom";
}
export function telegramSettingsView(channels: string[] | null, defaults: string[]) {
  const defaultChannels = normalizeTelegramChannels(defaults).filter((name) => TG_CHANNEL_PATTERN.test(name));
  return { channels, defaultChannels, effectiveChannels: channels ?? defaultChannels };
}
