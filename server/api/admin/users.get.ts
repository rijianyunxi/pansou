import { defineEventHandler, getQuery } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { parsePagination } from "../../utils/adminQuery";
import { listAdminUsers } from "../../core/services/adminUserService";

export default defineEventHandler((event) => {
  requireAdminAuth(event);
  const query = getQuery(event);
  return {
    code: 0,
    message: "success",
    data: listAdminUsers({
      ...parsePagination(query),
      username: String(query.username || query.q || ""),
      status: String(query.status || ""),
    }),
  };
});
