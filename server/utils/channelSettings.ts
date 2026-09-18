import { createError } from "h3";
import { normalizeChannelNames, CHANNEL_NAME_PATTERN } from "../../utils/customChannels";

/**
 * Validation and the derived view for the administrator-configured channel
 * list (`system_channels`) — the defaults a user falls back to when they have
 * not added any channel of their own. Read-side helpers live here; the
 * account-facing list is handled in `utils/userAuth.ts`.
 */

/** Upper bound on the administrator's channel list. */
const MAX_SYSTEM_CHANNELS = 200;

/** `null` means "no explicit configuration, fall back to the defaults". */
export function parseSystemChannels(value: unknown): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw createError({ statusCode: 400, statusMessage: "channels must be null or an array of public usernames" });
  if (value.length > MAX_SYSTEM_CHANNELS) throw createError({ statusCode: 400, statusMessage: `channels support at most ${MAX_SYSTEM_CHANNELS} entries` });
  const normalized = normalizeChannelNames(value as string[]);
  for (const name of normalized) if (!CHANNEL_NAME_PATTERN.test(name)) throw createError({ statusCode: 400, statusMessage: `invalid channel username: ${name.slice(0, 64)}` });
  return normalized;
}
export interface ChannelSettingsView {
  /** Explicitly configured channels; null means "fall back to the system defaults". */
  channels: string[] | null;
  defaultChannels: string[];
  effectiveChannels: string[];
}

export function channelSettingsView(channels: string[] | null, defaults: string[]): ChannelSettingsView {
  const defaultChannels = normalizeChannelNames(defaults).filter((name) => CHANNEL_NAME_PATTERN.test(name));
  return { channels, defaultChannels, effectiveChannels: channels ?? defaultChannels };
}
