import { createError } from "h3";
import { normalizeTelegramChannels, TG_CHANNEL_PATTERN } from "../../utils/telegramChannels";
const MAX_SYSTEM_TG_CHANNELS = 200;

export function parseSystemChannels(value: unknown): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw createError({ statusCode: 400, statusMessage: "channels must be null or an array of public usernames" });
  if (value.length > MAX_SYSTEM_TG_CHANNELS) throw createError({ statusCode: 400, statusMessage: `channels support at most ${MAX_SYSTEM_TG_CHANNELS} entries` });
  const normalized = normalizeTelegramChannels(value as string[]);
  for (const name of normalized) if (!TG_CHANNEL_PATTERN.test(name)) throw createError({ statusCode: 400, statusMessage: `invalid channel username: ${name.slice(0, 64)}` });
  return normalized;
}
export interface TelegramSettingsView {
  /** Explicitly configured channels; null means "fall back to the system defaults". */
  channels: string[] | null;
  defaultChannels: string[];
  effectiveChannels: string[];
}

export function telegramSettingsView(channels: string[] | null, defaults: string[]): TelegramSettingsView {
  const defaultChannels = normalizeTelegramChannels(defaults).filter((name) => TG_CHANNEL_PATTERN.test(name));
  return { channels, defaultChannels, effectiveChannels: channels ?? defaultChannels };
}
