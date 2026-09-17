import { defineEventHandler } from "h3";
import { getAdminUser } from "../../core/services/adminUserService";
import { requireAdminAuth } from "../../utils/requireAdminAuth";

export default defineEventHandler((event) => {
  const context = requireAdminAuth(event);
  const user = getAdminUser(context.user.id);
  return { code: 0, message: "success", data: { account: { id: user.id, username: user.username, role: user.role } } };
});
