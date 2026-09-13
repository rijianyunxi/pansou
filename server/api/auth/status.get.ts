import { verifyAuthCookie } from "../../utils/auth";

export default defineEventHandler((event) => {
  const config = useRuntimeConfig();
  const password = String(config.searchPassword || "");
  return { locked: !!password.trim() && !verifyAuthCookie(event, password) };
});
