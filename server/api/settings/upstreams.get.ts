import { defineEventHandler, setResponseHeader } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { UPSTREAM_DRIVE_TYPES, UPSTREAM_RESOURCE_TYPES } from "../../../config/upstreams";
import { getUnifiedUpstreamVersion, listUnifiedUpstreams } from "../../core/services/upstreamCatalog";
export default defineEventHandler((event) => {
  requireAdminAuth(event);
  setResponseHeader(event, "Cache-Control", "private, no-store");
  return {
    code: 0,
    data: listUnifiedUpstreams(),
    version: getUnifiedUpstreamVersion(),
    meta: {
      driveTypes: UPSTREAM_DRIVE_TYPES,
      resourceTypes: UPSTREAM_RESOURCE_TYPES,
      sourceKinds: ["http", "telegram"],
    },
  };
});
