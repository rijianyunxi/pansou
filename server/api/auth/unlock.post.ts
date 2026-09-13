import { createHash, timingSafeEqual } from "node:crypto";
import { readBody, createError } from "h3";
import { createAuthToken, setAuthCookie } from "../../utils/auth";

function hash(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig();
  const password = String(config.searchPassword || "");
  if (!password.trim()) return { ok: true };

  const body = await readBody<{ password?: string }>(event);
  const input = (body?.password ?? "").trim();
  if (!input) {
    throw createError({ statusCode: 400, statusMessage: "password required" });
  }

  const inputHash = hash(input);
  const secretHash = hash(password);
  if (
    inputHash.length !== secretHash.length ||
    !timingSafeEqual(inputHash, secretHash)
  ) {
    throw createError({ statusCode: 401, statusMessage: "invalid password" });
  }

  setAuthCookie(event, createAuthToken(password));
  return { ok: true };
});
