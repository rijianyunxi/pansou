import { setHeader } from "h3";
import { verifyAdminAuthCookie } from "../../utils/auth";

export default defineEventHandler((event) => {
  setHeader(event, "Cache-Control", "no-store");
  const config = useRuntimeConfig();
  const password = String(config.adminPassword || "").trim();
  return {
    configured: !!password,
    locked: !password || !verifyAdminAuthCookie(event, password),
  };
});
