import { defineEventHandler, getQuery } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { parsePagination } from "../../utils/adminQuery";
import { listAdminHotSearches } from "../../core/services/adminHotSearchService";

export default defineEventHandler((event) => {
  requireAdminAuth(event);
  const query = getQuery(event);
  return { code: 0, message: "success", data: listAdminHotSearches({ ...parsePagination(query), q: String(query.q || ""), status: String(query.status || ""), source: String(query.source || "") }) };
});
