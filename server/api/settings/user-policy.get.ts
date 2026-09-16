import { defineEventHandler, setHeader } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { getUserPolicy } from "../../core/services/policyService";

export default defineEventHandler((event) => {
  requireAdminAuth(event);
  setHeader(event, "Cache-Control", "no-store");
  return { code: 0, message: "success", data: getUserPolicy() };
});
