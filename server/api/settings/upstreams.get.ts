import { defineEventHandler, setResponseHeader } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { getUnifiedUpstreamVersion, listUnifiedUpstreams } from "../../core/services/upstreamCatalog";
export default defineEventHandler((event) => {
  requireAdminAuth(event);
  setResponseHeader(event, "Cache-Control", "private, no-store");
  return {
    code: 0,
    data: listUnifiedUpstreams(),
    version: getUnifiedUpstreamVersion(),
    meta: {
      sourceKinds: ["http", "telegram"],
    },
  };
});
