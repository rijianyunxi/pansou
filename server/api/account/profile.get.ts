import { defineEventHandler } from "h3";
import { setPrivateNoStore } from "../../utils/apiResponse";
import { publicUser, requireUserSession } from "../../utils/userAuth";

export default defineEventHandler((event) => {
  const context = requireUserSession(event);
  setPrivateNoStore(event);
  return { user: publicUser(context.user) };
});
