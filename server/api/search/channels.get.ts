import { defineEventHandler, getQuery } from "h3";
import { beginSearchLease } from "../../core/security/concurrency";
import { prepareUserChannelSearch } from "../../utils/executeSearch";
import { requireSearchAuth } from "../../utils/requireAuth";
import { sendSearchStream } from "../../utils/sendSearchStream";

/** Search only the Telegram channels explicitly supplied by the user. */
export default defineEventHandler((event) => {
  requireSearchAuth(event);
  const prepared = prepareUserChannelSearch(getQuery(event));
  const lease = beginSearchLease(event);
  return sendSearchStream(event, prepared, lease);
});
