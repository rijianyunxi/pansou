import { CHANNEL_NAME_PATTERN } from "./customChannels";

/**
 * UI convenience only: accept what a user is likely to paste (`@name`,
 * `t.me/name`, `t.me/s/name`, or a public post link) and hand the rest of the
 * system nothing but the bare channel username.
 *
 * Telegram-specific by nature: the reserved path segments below are Telegram's
 * own routes, and private invite links (`t.me/+…`, `joinchat`) are rejected
 * outright so they can never be stored.
 */
export function parseCustomChannelInput(input: string): string | null {
  let name = input.trim();
  if (/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\//i.test(name)) {
    try {
      const url = new URL(/^https?:\/\//i.test(name) ? name : `https://${name}`);
      if (!["t.me", "telegram.me"].includes(url.hostname.toLowerCase()) || url.username || url.password || url.port) return null;
      const parts = url.pathname.replace(/\/+$/, "").split("/").slice(1);
      if (parts[0] === "s") parts.shift();
      if (parts.length < 1 || parts.length > 2 || (parts.length === 2 && !/^\d+$/.test(parts[1]!))) return null;
      name = parts[0] || "";
      if (["joinchat", "share", "proxy", "socks", "addstickers", "login", "confirmphone", "boost"].includes(name.toLowerCase())) return null;
    } catch { return null; }
  } else {
    name = name.replace(/^@/, "");
  }
  return CHANNEL_NAME_PATTERN.test(name) ? name.toLowerCase() : null;
}
