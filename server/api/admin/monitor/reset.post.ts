import { defineEventHandler } from "h3";
import { getOrCreateSearchService } from "../../../core/services";
import { resetAllProxyNodeHealth } from "../../../core/services/proxyPoolService";
import { requireAdminAuth } from "../../../utils/requireAdminAuth";

/** Reset source and proxy health snapshots while preserving configuration and quota usage. */
export default defineEventHandler((event) => {
  requireAdminAuth(event);
  const searchService = getOrCreateSearchService();
  searchService.resetSourceHealth();
  const proxyNodes = resetAllProxyNodeHealth();
  return {
    code: 0,
    message: "health_reset",
    data: { proxyNodes },
  };
});
