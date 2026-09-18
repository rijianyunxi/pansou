import { defineEventHandler } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { getSearchAnalytics } from "../../core/services/searchAnalyticsService";

export default defineEventHandler((event) => {
  requireAdminAuth(event);
  return { code: 0, message: "success", data: getSearchAnalytics() };
});
