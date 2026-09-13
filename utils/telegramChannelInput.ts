import { TG_CHANNEL_PATTERN } from "./telegramChannels";

/** UI convenience only: accept public channel usernames/links and send only the normalized username. */
export function parseTelegramChannelInput(input: string): string | null {
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
  return TG_CHANNEL_PATTERN.test(name) ? name.toLowerCase() : null;
}
