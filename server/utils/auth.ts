import { createHmac, timingSafeEqual } from "node:crypto";
import type { H3Event } from "h3";
import { getCookie, getRequestURL, setHeader } from "h3";

const SEARCH_COOKIE_NAME = "panhub_unlock";
const SEARCH_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
const COOKIE_PATH = "/";

export function createAuthToken(secret: string): string {
  const ts = String(Date.now());
  const sig = createHmac("sha256", secret).update(ts).digest("hex");
  return `${ts}.${sig}`;
}

export function verifyAuthToken(
  token: string,
  secret: string,
  maxAgeSeconds = SEARCH_COOKIE_MAX_AGE
): boolean {
  if (!token || !secret) return false;
  const [ts, sig] = token.split(".");
  if (!ts || !sig) return false;
  const expected = createHmac("sha256", secret).update(ts).digest("hex");
  try {
    if (!timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))) {
      return false;
    }
  } catch {
    return false;
  }
  const age = Date.now() - Number.parseInt(ts, 10);
  return age >= 0 && age < maxAgeSeconds * 1000;
}

function verifyNamedCookie(
  event: H3Event,
  name: string,
  secret: string,
  maxAgeSeconds: number
): boolean {
  const cookie = getCookie(event, name);
  return !!cookie && verifyAuthToken(cookie, secret, maxAgeSeconds);
}

function setNamedCookie(
  event: H3Event,
  name: string,
  token: string,
  maxAgeSeconds: number
): void {
  setHeader(
    event,
    "Set-Cookie",
    `${name}=${token}; Path=${COOKIE_PATH}; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Strict${
      getRequestURL(event).protocol === "https:" ? "; Secure" : ""
    }`
  );
}

export function verifyAuthCookie(event: H3Event, secret: string): boolean {
  return verifyNamedCookie(
    event,
    SEARCH_COOKIE_NAME,
    secret,
    SEARCH_COOKIE_MAX_AGE
  );
}

export function setAuthCookie(event: H3Event, token: string): void {
  setNamedCookie(event, SEARCH_COOKIE_NAME, token, SEARCH_COOKIE_MAX_AGE);
}
