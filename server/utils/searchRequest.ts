import { createError } from "h3";
import type { SearchRequest } from "../core/types/models";
import { MAX_USER_TG_CHANNELS, normalizeTelegramChannels, TG_CHANNEL_PATTERN } from "../../utils/telegramChannels";

function invalid(message: string): never { throw createError({ statusCode: 400, statusMessage: message }); }
function list(value: unknown, field: string, max = 100): string[] | undefined {
  if (value === undefined) return undefined;
  const items = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(items) || items.some((item) => typeof item !== "string")) return invalid(`${field} must be a string array or comma-separated string`);
  if (items.length > max) return invalid(`${field} has too many entries`);
  return [...new Set(items.map((item: string) => item.trim()).filter(Boolean))];
}
function integer(value: unknown, min: number, max: number, field: string): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) return invalid(`${field} must be an integer between ${min} and ${max}`);
  return n;
}

export function parseSearchRequest(raw: unknown): SearchRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid("Search request must be an object");
  const value = raw as Record<string, unknown>;
  if (typeof value.kw !== "string" || !value.kw.trim() || value.kw.trim().length > 100) return invalid("kw must contain 1 to 100 characters");
  if (Object.prototype.hasOwnProperty.call(value, "res")) return invalid("res is no longer supported; search APIs always return normalized results");
  if (Object.prototype.hasOwnProperty.call(value, "debug")) return invalid("debug is not a request parameter");
  const sourceIds = list(value.sourceIds, "sourceIds");
  // Normalize the channel list once: the same normalized value is validated
  // here and then handed to the search pipeline.
  const requestedChannels = list(value.channels, "channels", MAX_USER_TG_CHANNELS);
  const channels = requestedChannels ? normalizeTelegramChannels(requestedChannels) : undefined;
  if (channels && (!channels.length || channels.some((name) => !TG_CHANNEL_PATTERN.test(name)))) {
    return invalid("channels must contain public channel usernames");
  }
  return {
    kw: value.kw.trim(),
    channels,
    sourceIds,
    conc: integer(value.conc, 1, 16, "conc"),
    refresh: value.refresh === true || value.refresh === "true",
  };
}
