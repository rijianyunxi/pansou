import { defineEventHandler, getQuery } from "h3";
import { beginSearchLease } from "../core/security/concurrency";
import { prepareSearch } from "../utils/executeSearch";
import { requireSearchAuth } from "../utils/requireAuth";
import { sendSearchStream } from "../utils/sendSearchStream";

export default defineEventHandler((event) => {
  requireSearchAuth(event);
  const prepared = prepareSearch(getQuery(event));
  const lease = beginSearchLease(event);
  return sendSearchStream(event, prepared, lease);
});
