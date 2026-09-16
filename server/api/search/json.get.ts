import { defineEventHandler, getQuery, setHeader } from "h3";
import { beginSearchLease } from "../../core/security/concurrency";
import { executePreparedSearch, prepareSearch } from "../../utils/executeSearch";
import { requireSearchAuth } from "../../utils/requireAuth";
import { withRequestSignal } from "../../utils/requestSignal";

/**
 * GET /api/search/json — synchronous JSON search for diagnostics.
 *
 * It runs the same search pipeline as POST /api/search, but keeps source
 * provenance in the response. Debug mode is fixed by this route and is not
 * controlled by a client query parameter.
 */
export default defineEventHandler(async (event) => {
  requireSearchAuth(event);
  setHeader(event, "Content-Type", "application/json; charset=utf-8");
  const prepared = prepareSearch(getQuery(event), { includeMeta: true });
  const lease = beginSearchLease(event);
  try {
    return await withRequestSignal(event, (signal) => executePreparedSearch(prepared, signal));
  } finally {
    lease.release();
  }
});
