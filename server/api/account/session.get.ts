import { defineEventHandler, setHeader } from "h3";
import { createAnonymousSession, getUserSession, publicUser } from "../../utils/userAuth";
import { cleanupUserData, getUserPolicy } from "../../core/services/policyService";

export default defineEventHandler((event) => {
  cleanupUserData();
  let context;
  try {
    context = getUserSession(event, { createAnonymous: true, allowMustChange: true });
  } catch (error: any) {
    // Expired or invalid account cookies should quietly fall back to an anonymous session.
    // An unauthenticated visitor should not see a login failure message on the homepage.
    if (error?.statusCode !== 401) throw error;
    context = createAnonymousSession(event);
  }
  setHeader(event, "Cache-Control", "no-store");
  const policy = getUserPolicy();
  return { authenticated: !!context.user, user: context.user ? publicUser(context.user) : null, sessionId: context.session.id, anonymousCustomChannels: policy.anonymousCustomChannels, showAuthButtons: policy.showAuthButtons, registrationEnabled: policy.registrationEnabled };
});
