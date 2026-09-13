/** Public channel usernames only; never accept URLs or private invite links. */
export const MAX_USER_TG_CHANNELS = 50;
export const TG_CHANNEL_PATTERN = /^[A-Za-z0-9_]{5,64}$/;

export function normalizeTelegramChannels(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim().replace(/^@/, "").toLowerCase()))];
}
