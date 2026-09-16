import { defineEventHandler, readBody } from "h3";
import { authorizeSearch } from "../utils/searchGovernance";
import { sendSearchStream } from "../utils/sendSearchStream";

export default defineEventHandler(async (event) => {
  const authorized = authorizeSearch(event, await readBody(event));
  return sendSearchStream(event, authorized.prepared);
});
