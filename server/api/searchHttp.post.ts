import { defineEventHandler, readBody } from "h3";
import { beginSearchLease } from "../core/security/concurrency";
import { prepareSearch } from "../utils/executeSearch";
import { requireSearchAuth } from "../utils/requireAuth";
import { sendSearchHttp } from "../utils/sendSearchHttp";

export default defineEventHandler(async (event) => {
  requireSearchAuth(event);
  const prepared = prepareSearch(await readBody(event));
  const lease = beginSearchLease(event);
  return sendSearchHttp(event, prepared, lease);
});
