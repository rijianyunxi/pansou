import { defineEventHandler, readBody } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { toHttpError } from "../../utils/apiResponse";
import { saveUserPolicy } from "../../core/services/policyService";

export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  try {
    return { code: 0, message: "saved", data: saveUserPolicy(await readBody(event) || {}) };
  } catch (error) {
    throw toHttpError(error, 400, "invalid user policy");
  }
});
