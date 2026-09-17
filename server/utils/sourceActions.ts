import { getRouterParam, type H3Event } from "h3";
import { setUnifiedSourceEnabled } from "../core/services/sourceCatalog";
import { setSearchSourceEnabled } from "../core/services/searchSettingsService";
import { toHttpError } from "./apiResponse";
import { requireAdminAuth } from "./requireAdminAuth";

/**
 * Enable or disable a source and keep the search selection in sync.
 *
 * The two writes belong together: the catalog owns the definition and its
 * enabled flag, while search settings own the explicit list of sources a search
 * loads. Toggling only one of them would leave the monitor and the search
 * pipeline disagreeing about what is active.
 */
export function setSourceEnabled(event: H3Event, enabled: boolean) {
  requireAdminAuth(event);
  try {
    const source = setUnifiedSourceEnabled(getRouterParam(event, "id") || "", enabled);
    setSearchSourceEnabled(source.id, enabled);
    return { code: 0, message: enabled ? "enabled" : "disabled", data: source };
  } catch (error) {
    throw toHttpError(error, 400, `failed to ${enabled ? "enable" : "disable"} source`);
  }
}
