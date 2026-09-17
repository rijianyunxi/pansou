import { defineEventHandler, readBody } from "h3";
import { updateAdminCredentials } from "../../core/services/adminUserService";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { toHttpError } from "../../utils/apiResponse";

export default defineEventHandler(async (event) => {
  const context = requireAdminAuth(event);
  const body = await readBody<{ username: unknown; password?: unknown }>(event) || { username: undefined };
  try {
    return { code: 0, message: "saved", data: { account: updateAdminCredentials(context.user.id, body) } };
  } catch (error) {
    throw toHttpError(error, 400, "invalid administrator credentials");
  }
});
