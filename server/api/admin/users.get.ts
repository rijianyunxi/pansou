import { defineEventHandler, getQuery, setHeader } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { listAdminUsers } from "../../core/services/adminUserService";
import { positiveInteger } from "../../core/services/adminQueryHelpers";

export default defineEventHandler((event) => {
  requireAdminAuth(event);
  setHeader(event, "Cache-Control", "no-store");
  const query = getQuery(event);
  const page = positiveInteger(query.page, 1, 1000000);
  const pageSize = positiveInteger(query.pageSize ?? query.limit, 20, 100);
  return { code: 0, message: "success", data: listAdminUsers({ page, pageSize, username: String(query.username || query.q || ""), status: String(query.status || "") }) };
});
