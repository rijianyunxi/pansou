import { defineEventHandler, getQuery, setHeader } from "h3";
import { requireSearchAuth } from "../utils/requireAuth";
import { executeSearch } from "../utils/executeSearch";
import { withRequestSignal } from "../utils/requestSignal";
import { beginSearchLease } from "../core/security/concurrency";

export default defineEventHandler(async (event) => {
  setHeader(event, "Cache-Control", "private, no-store");
  requireSearchAuth(event);
  const lease = beginSearchLease(event);
  try {
    return await withRequestSignal(event, (signal) => executeSearch(getQuery(event), signal));
  } finally {
    lease.release();
  }
});
