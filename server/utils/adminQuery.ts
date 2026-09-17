import { createError } from "h3";
import { optionalInteger, positiveInteger } from "../core/services/adminQueryHelpers";

export interface Pagination {
  page: number;
  pageSize: number;
}

const DEFAULT_PAGE = 1;
const MAX_PAGE = 1_000_000;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/** Shared `page`/`pageSize` parsing for admin list endpoints. `limit` is accepted as an alias. */
export function parsePagination(query: Record<string, unknown>): Pagination {
  return {
    page: positiveInteger(query.page, DEFAULT_PAGE, MAX_PAGE),
    pageSize: positiveInteger(query.pageSize ?? query.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
  };
}

export interface SearchLogQuery extends Pagination {
  keyword: string;
  userId?: number;
  sessionId?: number;
  ip: string;
  searchScope: string;
  from?: number;
  to?: number;
}

/**
 * Parse the shared search-log filter set. `userId` is passed explicitly when the
 * route already fixes it from the path, so a query parameter cannot widen the scope.
 */
export function parseSearchLogQuery(
  query: Record<string, unknown>,
  options: { userId?: number } = {},
): SearchLogQuery {
  const from = optionalInteger(query.from ?? query.startTime, "from");
  const to = optionalInteger(query.to ?? query.endTime, "to");
  if (from !== undefined && to !== undefined && from > to) {
    throw createError({ statusCode: 400, statusMessage: "invalid time range" });
  }
  return {
    ...parsePagination(query),
    keyword: String(query.keyword || query.q || ""),
    userId: options.userId ?? optionalInteger(query.userId, "userId"),
    sessionId: optionalInteger(query.sessionId, "sessionId"),
    ip: String(query.ip || ""),
    searchScope: String(query.searchScope || query.scope || ""),
    from,
    to,
  };
}
