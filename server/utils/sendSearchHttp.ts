import { setHeader, type H3Event } from "h3";
import type { SearchLease } from "../core/security/concurrency";
import { executePreparedSearch, type PreparedSearch } from "./executeSearch";
import { withRequestSignal } from "./requestSignal";

/** Executes a search and returns the complete result as a regular JSON response. */
export async function sendSearchHttp(
  event: H3Event,
  prepared: PreparedSearch,
  lease: SearchLease,
) {
  setHeader(event, "Cache-Control", "private, no-store");
  try {
    return await withRequestSignal(event, (signal) => executePreparedSearch(prepared, signal));
  } finally {
    lease.release();
  }
}
