import { defineEventHandler } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { getUserPolicy } from "../../core/services/policyService";

export default defineEventHandler((event) => {
  requireAdminAuth(event);
  return { code: 0, message: "success", data: getUserPolicy() };
});
