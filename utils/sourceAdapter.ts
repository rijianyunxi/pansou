import type { CloudType } from "../server/core/types/models";
import { CLOUD_TYPE_ALIASES, CLOUD_TYPE_HOSTS } from "../shared/cloudTypes";

/** Deliberately restricted dot paths; never evaluates expressions or follows prototypes. */
export function readMappingPath(value: unknown, path: string): unknown {
  if (!path) return value;
  return path.split(".").reduce<unknown>((current, key) => {
    if (["__proto__", "constructor", "prototype"].includes(key))
      return undefined;
    if (
      !current ||
      typeof current !== "object" ||
      !Object.prototype.hasOwnProperty.call(current, key)
    )
      return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}
const text = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";
export function validResourceUrl(value: string): boolean {
  if (/^magnet:\?/i.test(value) || /^ed2k:\/\//i.test(value))
    return true;
  try {
    return ["https:", "http:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
export type { CloudType } from "../server/core/types/models";

function isDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export function normalizeCloudType(value: unknown): CloudType | undefined {
  const normalized = String(value ?? "").trim().toLowerCase();
  return CLOUD_TYPE_ALIASES[normalized];
}

/**
 * Determines the canonical cloud type exclusively from the resource URL. A
 * source-provided label cannot manufacture a cloud type for an unknown host.
 */
export function inferDriveType(url: string, _value = ""): CloudType {
  if (/^magnet:/i.test(url)) return "magnet";
  if (/^ed2k:\/\//i.test(url)) return "others";

  try {
    const host = new URL(url).hostname.toLowerCase();
    const match = CLOUD_TYPE_HOSTS.find(([domain]) => isDomain(host, domain));
    if (match) return match[1];
    // 蓝奏分享 links rotate through lanzou.com/lanzoux.com/lanzoui.com
    // and similar resolver domains; keep the whole family on one canonical type.
    if (/(^|\.)lanzou[a-z0-9-]*\.com$/.test(host)) return "lanzou";
  } catch {
    // Invalid or non-HTTP resource URLs are kept under others.
  }

  return "others";
}
