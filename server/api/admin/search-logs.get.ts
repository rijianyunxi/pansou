import { defineEventHandler, getQuery } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { parseSearchLogQuery } from "../../utils/adminQuery";
import { listAdminSearchLogs } from "../../core/services/adminSearchLogService";

export default defineEventHandler((event) => {
  requireAdminAuth(event);
  return {
    code: 0,
    message: "success",
    data: listAdminSearchLogs(parseSearchLogQuery(getQuery(event))),
  };
});