import { defineEventHandler, getQuery, setHeader } from "h3";
import { authorizeSearch } from "../../utils/searchGovernance";
import { executePreparedSearch } from "../../utils/executeSearch";
import { withRequestSignal } from "../../utils/requestSignal";

/**
 * GET /api/search/json — synchronous JSON search using the same authorization,
 * session, policy, custom-channel and logging pipeline as SSE searches.
 */
export default defineEventHandler(async (event) => {
  const authorized = authorizeSearch(event, getQuery(event), { includeMeta: true });
  setHeader(event, "Content-Type", "application/json; charset=utf-8");
  return await withRequestSignal(event, (signal) => executePreparedSearch(authorized.prepared, signal));
});
