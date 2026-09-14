import { createError } from "h3";
import type { SearchRequest } from "../core/types/models";
import { MAX_USER_TG_CHANNELS, normalizeTelegramChannels, TG_CHANNEL_PATTERN } from "../../utils/telegramChannels";

function invalid(message: string): never {
  throw createError({ statusCode: 400, statusMessage: message });
}
function list(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  const items = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(items) || items.some((item) => typeof item !== "string")) {
    return invalid(`${field} must be a string array or comma-separated string`);
  }
  if (items.length > (field === "channels" ? MAX_USER_TG_CHANNELS : 100)) {
    return invalid(`${field} has too many entries`);
  }
  return [...new Set(items.map((item: string) => item.trim()).filter(Boolean))];
}
function integer(value: unknown, min: number, max: number, field: string): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) return invalid(`${field} must be an integer between ${min} and ${max}`);
  return n;
}

/** Shared GET/POST validation. Normalize before resolving any system defaults. */
export function parseSearchRequest(raw: unknown): SearchRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid("Search request must be an object");
  const value = raw as Record<string, unknown>;
  if (typeof value.kw !== "string" || !value.kw.trim() || value.kw.trim().length > 100) {
    return invalid("kw must contain 1 to 100 characters");
  }
  if (Object.prototype.hasOwnProperty.call(value, "res")) return invalid("res is no longer supported; search APIs always return normalized results");
  const src = value.src ?? "all";
  if (!["all", "tg", "plugin"].includes(src as string)) return invalid("Invalid src");
  const mode = value.channels_mode ?? "append";
  if (!["append", "only"].includes(mode as string)) return invalid("Invalid channels_mode (append or only)");
  const channels = normalizeTelegramChannels(list(value.channels, "channels") ?? []);
  if (channels.some((name) => !TG_CHANNEL_PATTERN.test(name))) return invalid("channels must contain public Telegram usernames, not URLs");
  if (mode !== "append" && !channels.length) return invalid("channels are required when channels_mode=only");
  if (value.refresh !== undefined && ![true, false, "true", "false"].includes(value.refresh as any)) return invalid("refresh must be a boolean");
  let ext = value.ext;
  if (typeof ext === "string") {
    try { ext = JSON.parse(ext); } catch { return invalid("ext must be valid JSON"); }
  }
  if (ext !== undefined && (!ext || typeof ext !== "object" || Array.isArray(ext))) return invalid("ext must be an object");
  const extra = { ...(ext as Record<string, unknown> || {}) };
  if (extra.__plugin_timeout_ms !== undefined) {
    extra.__plugin_timeout_ms = integer(extra.__plugin_timeout_ms, 1000, 60000, "ext.__plugin_timeout_ms");
  }
  return {
    kw: value.kw.trim(), channels, channels_mode: mode as "append" | "only",
    src: src as SearchRequest["src"],
    plugins: list(value.plugins, "plugins"), cloud_types: list(value.cloud_types, "cloud_types"),
    conc: integer(value.conc, 1, 16, "conc"), refresh: value.refresh === true || value.refresh === "true",
    debug: value.debug === 1 || value.debug === "1", ext: extra,
  };
}
