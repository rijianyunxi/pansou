import { createError, defineEventHandler, readBody, setHeader } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { saveUserPolicy } from "../../core/services/policyService";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  try {
    const data = saveUserPolicy(await readBody(event) || {});
    setHeader(event, "Cache-Control", "no-store");
    return { code: 0, message: "saved", data };
  } catch (error: any) {
    throw createError({ statusCode: 400, statusMessage: error?.message || "invalid user policy" });
  }
});
