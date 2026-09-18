/**
 * Name rules for public sources a user picks as their own custom search scope
 * (`custom_channels_json`).
 *
 * A "channel" is a Telegram public channel today: `CHANNEL_NAME_PATTERN` is
 * Telegram's username rule, and `customChannelInput.ts` only accepts `t.me` /
 * `telegram.me` links. The naming here stays provider-neutral because the UI
 * and the storage layer already say "channel" — the shared source template
 * turns the stored username into a searchable resource source.
 */

/** Upper bound on how many channels one account may store. */
export const MAX_USER_CHANNELS = 50;

/** Telegram public-channel username rule; also rejects the reserved paths. */
export const CHANNEL_NAME_PATTERN = /^[A-Za-z0-9_]{5,64}$/;

/** Trim, drop a leading `@`, lowercase, and de-duplicate while keeping order. */
export function normalizeChannelNames(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim().replace(/^@/, "").toLowerCase()))];
}
