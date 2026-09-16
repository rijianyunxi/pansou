import { defineEventHandler, getQuery } from "h3";
import { authorizeSearch } from "../utils/searchGovernance";
import { sendSearchStream } from "../utils/sendSearchStream";

/** GET /api/search — the same SSE search pipeline as POST /api/search. */
export default defineEventHandler(async (event) => {
  const admission = authorizeSearch(event, getQuery(event));
  return sendSearchStream(event, admission.prepared, admission.lease);
});
