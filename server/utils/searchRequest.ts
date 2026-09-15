import { createError } from "h3";
import type { SearchRequest } from "../core/types/models";
import { MAX_USER_TG_CHANNELS, normalizeTelegramChannels, TG_CHANNEL_PATTERN } from "../../utils/telegramChannels";

function invalid(message: string): never {
  throw createError({ statusCode: 400, statusMessage: message });
}
function list(value: unknown, field: string, max = 100): string[] | undefined {
  if (value === undefined) return undefined;
  const items = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(items) || items.some((item) => typeof item !== "string")) {
    return invalid(`${field} must be a string array or comma-separated string`);
  }
  if (items.length > max) return invalid(`${field} has too many entries`);
  return [...new Set(items.map((item: string) => item.trim()).filter(Boolean))];
}
function integer(value: unknown, min: number, max: number, field: string): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) return invalid(`${field} must be an integer between ${min} and ${max}`);
  return n;
}
interface ParsedCommonRequest {
  value: Record<string, unknown>;
  extra: Record<string, unknown>;
  channels?: string[];
}

function parseCommonRequest(raw: unknown, mode: "system" | "user-channels"): ParsedCommonRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid("Search request must be an object");
  const value = raw as Record<string, unknown>;
  if (typeof value.kw !== "string" || !value.kw.trim() || value.kw.trim().length > 100) {
    return invalid("kw must contain 1 to 100 characters");
  }
  if (Object.prototype.hasOwnProperty.call(value, "res")) return invalid("res is no longer supported; search APIs always return normalized results");
  if (value.refresh !== undefined && ![true, false, "true", "false"].includes(value.refresh as any)) return invalid("refresh must be a boolean");
  let ext = value.ext;
  if (typeof ext === "string") {
    try { ext = JSON.parse(ext); } catch { return invalid("ext must be valid JSON"); }
  }
  if (ext !== undefined && (!ext || typeof ext !== "object" || Array.isArray(ext))) return invalid("ext must be an object");
  const extra = { ...(ext as Record<string, unknown> || {}) };
  if (Object.prototype.hasOwnProperty.call(extra, "__plugin_timeout_ms")) {
    return invalid("ext.__plugin_timeout_ms is server-configured and cannot be overridden");
  }
  const channels = list(value.channels, "channels", MAX_USER_TG_CHANNELS);
  if (mode === "system" && (Object.prototype.hasOwnProperty.call(value, "channels") || Object.prototype.hasOwnProperty.call(value, "channels_mode"))) {
    return invalid("channels is only supported by /api/search/channels or /api/searchHttp/channels; channels_mode is not supported");
  }
  if (mode === "user-channels" && Object.prototype.hasOwnProperty.call(value, "channels_mode")) {
    return invalid("channels_mode is not supported; use /api/search/channels");
  }
  return { value, extra, channels };
}

/** Validate the server-configured search API request. */
export function parseSearchRequest(raw: unknown): SearchRequest {
  const parsed = parseCommonRequest(raw, "system");
  const { value, extra } = parsed;
  const src = value.src ?? "all";
  if (!["all", "tg", "plugin"].includes(src as string)) return invalid("Invalid src");
  return {
    kw: (value.kw as string).trim(),
    src: src as SearchRequest["src"],
    plugins: list(value.plugins, "plugins"),
    cloud_types: list(value.cloud_types, "cloud_types"),
    conc: integer(value.conc, 1, 16, "conc"),
    refresh: value.refresh === true || value.refresh === "true",
    debug: value.debug === 1 || value.debug === "1",
    ext: extra,
  };
}

export interface UserChannelSearchRequest {
  kw: string;
  channels: string[];
  conc?: number;
  refresh?: boolean;
  debug?: boolean;
  ext?: Record<string, any>;
  cloud_types?: string[];
}

/** Validate a user-owned, per-request Telegram channel search. */
export function parseUserChannelSearchRequest(raw: unknown): UserChannelSearchRequest {
  const parsed = parseCommonRequest(raw, "user-channels");
  const channels = normalizeTelegramChannels(parsed.channels ?? []);
  if (!channels.length) return invalid("channels must contain at least one public Telegram channel");
  if (channels.some((name) => !TG_CHANNEL_PATTERN.test(name))) return invalid("channels must contain public Telegram usernames, not URLs");
  return {
    kw: (parsed.value.kw as string).trim(),
    channels,
    conc: integer(parsed.value.conc, 1, 16, "conc"),
    refresh: parsed.value.refresh === true || parsed.value.refresh === "true",
    debug: parsed.value.debug === 1 || parsed.value.debug === "1",
    ext: parsed.extra,
    cloud_types: list(parsed.value.cloud_types, "cloud_types"),
  };
}
