import { computed, inject, provide, ref, type InjectionKey } from "vue";
import { useAuth } from "../useAuth";
import { apiErrorMessage } from "../../src/appRuntime";

function createSession() {
  const auth = useAuth();
  const checking = ref(true);
  const locked = ref(true);
  const error = ref("");
  const authenticated = ref(false);
  let pending: Promise<void> | undefined;
  async function check() {
    if (pending) return pending;
    checking.value = true;
    error.value = "";
    pending = (async () => {
      try {
        if (!(await auth.initializeSession(true)))
          throw new Error(auth.sessionError.value);
        authenticated.value = !!auth.user.value;
        locked.value = auth.user.value?.role !== "admin";
      } catch (e) {
        error.value = apiErrorMessage(e);
        locked.value = true;
      } finally {
        checking.value = false;
        pending = undefined;
      }
    })();
    return pending;
  }
  async function logout() {
    await auth.logout();
    authenticated.value = false;
    locked.value = true;
  }
  return {
    checking,
    locked,
    error,
    authenticated,
    user: computed(() => auth.user.value),
    check,
    logout,
  };
}
type AdminSession = ReturnType<typeof createSession>;
const key: InjectionKey<AdminSession> = Symbol.for("pansou.admin.session");
export function provideAdminSession() {
  const session = createSession();
  provide(key, session);
  return session;
}
export function useAdminSession() {
  const session = inject(key);
  if (!session) throw new Error("管理页面必须嵌套在 AdminLayout 中");
  return session;
}
