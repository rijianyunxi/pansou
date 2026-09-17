import { defineEventHandler, readBody } from "h3";
import { requireAdminAuth } from "../../utils/requireAdminAuth";
import { toHttpError } from "../../utils/apiResponse";
import { saveUnifiedSource } from "../../core/services/sourceCatalog";
export default defineEventHandler(async (event) => {
  requireAdminAuth(event);
  const body = await readBody(event);
  try { return { code: 0, message: "saved", data: saveUnifiedSource(body?.source) }; }
  catch (error) { throw toHttpError(error, 400, "failed to save source"); }
});
