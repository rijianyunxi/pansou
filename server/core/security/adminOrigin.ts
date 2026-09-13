const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface AdminOriginInput {
  method: string;
  host?: string;
  origin?: string;
  secFetchSite?: string;
}

/** Browser mutations must be same-origin; origin-less API/CLI clients stay usable. */
export function isAllowedAdminOrigin(input: AdminOriginInput): boolean {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return true;
  if (input.secFetchSite === "cross-site") return false;
  if (!input.origin) return true;
  if (!input.host) return false;
  try {
    return new URL(input.origin).host.toLowerCase() === input.host.toLowerCase();
  } catch {
    return false;
  }
}
