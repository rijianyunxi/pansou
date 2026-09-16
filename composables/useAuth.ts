const API_BASE = "/api";

export interface AuthUser {
  id: number;
  username: string;
  nickname: string | null;
  status: "active" | "disabled";
  mustChangePassword: boolean;
  channels: string[];
  lastLoginAt: number | null;
  createdAt: number;
}

type SessionResponse = { authenticated: boolean; user: AuthUser | null; sessionId: number };
type ApiError = { statusCode?: number; statusMessage?: string; message?: string; data?: { statusMessage?: string; message?: string } };

function errorStatus(error: ApiError | undefined): number | undefined {
  return error?.statusCode || (error as any)?.status || (error as any)?.response?.status;
}

function errorMessage(error: ApiError | undefined, fallback: string): string {
  const status = errorStatus(error);
  const message = error?.data?.statusMessage || error?.data?.message || error?.statusMessage || error?.message;
  if (status === 400) return message || "提交内容不符合要求。";
  if (status === 401) return "用户名或密码错误，或登录已过期。";
  if (status === 403) return message || "当前操作不被允许。";
  if (status === 409) return message || "用户名已存在，请换一个。";
  if (status === 429) return "操作过于频繁，请稍后再试。";
  return message || fallback;
}

export function useAuth() {
  const locked = useState("auth-locked", () => false);
  const loading = useState("auth-loading", () => true);
  const error = useState("auth-error", () => "");
  const user = useState<AuthUser | null>("auth-user", () => null);
  const sessionReady = useState("auth-session-ready", () => false);
  const sessionId = useState<number | null>("auth-session-id", () => null);
  const sessionError = useState("auth-session-error", () => "");
  const initialized = useState("auth-session-initialized", () => false);
  let initializePromise: Promise<boolean> | undefined;

  async function fetchStatus() {
    loading.value = true;
    error.value = "";
    try {
      const data = await $fetch<{ locked: boolean }>(`${API_BASE}/auth/status`, { credentials: "include" });
      locked.value = !!data.locked;
    } catch (e: any) {
      error.value = errorMessage(e, "获取搜索状态失败");
    } finally {
      loading.value = false;
    }
  }

  async function initializeSession(force = false): Promise<boolean> {
    if (initializePromise && !force) return initializePromise;
    if (sessionReady.value && !force) return true;
    initializePromise = (async () => {
      sessionError.value = "";
      try {
        const data = await $fetch<SessionResponse>(`${API_BASE}/account/session`, {
          credentials: "include",
          cache: "no-store",
          retry: 0,
        });
        user.value = data.authenticated ? data.user : null;
        sessionId.value = data.sessionId || null;
        sessionReady.value = true;
        initialized.value = true;
        return true;
      } catch (e: any) {
        sessionError.value = errorMessage(e, "匿名会话初始化失败，请刷新页面重试。");
        sessionReady.value = false;
        return false;
      } finally {
        initializePromise = undefined;
      }
    })();
    return initializePromise;
  }

  function setAuthenticatedUser(next: AuthUser | null) {
    user.value = next;
    sessionReady.value = true;
    initialized.value = true;
  }

  async function unlock(password: string): Promise<boolean> {
    error.value = "";
    const pwd = (password || "").trim();
    if (!pwd) return false;
    try {
      await $fetch<{ ok: boolean }>(`${API_BASE}/auth/unlock`, {
        method: "POST",
        body: { password: pwd },
        credentials: "include",
        retry: 0,
      });
      locked.value = false;
      return true;
    } catch (e: any) {
      error.value = errorMessage(e, "解锁失败");
      return false;
    }
  }

  async function login(username: string, password: string): Promise<AuthUser | null> {
    error.value = "";
    try {
      const data = await $fetch<{ ok: boolean; user: AuthUser }>(`${API_BASE}/account/login`, {
        method: "POST", body: { username, password }, credentials: "include", retry: 0,
      });
      setAuthenticatedUser(data.user);
      return data.user;
    } catch (e: any) {
      error.value = errorMessage(e, "登录失败，请检查用户名和密码。");
      return null;
    }
  }

  async function register(username: string, password: string, nickname?: string): Promise<AuthUser | null> {
    error.value = "";
    try {
      const data = await $fetch<{ ok: boolean; user: AuthUser }>(`${API_BASE}/account/register`, {
        method: "POST", body: { username, password, nickname: nickname || undefined }, credentials: "include", retry: 0,
      });
      setAuthenticatedUser(data.user);
      return data.user;
    } catch (e: any) {
      error.value = errorMessage(e, "注册失败，请检查填写内容。");
      return null;
    }
  }

  async function logout(): Promise<boolean> {
    error.value = "";
    try {
      await $fetch(`${API_BASE}/account/logout`, { method: "POST", credentials: "include", retry: 0 });
    } catch (e: any) {
      error.value = errorMessage(e, "退出登录失败");
      // 本地仍清理账号，避免失效凭证继续被 UI 使用。
    } finally {
      user.value = null;
      sessionId.value = null;
      sessionReady.value = false;
      await initializeSession(true);
    }
    return !error.value;
  }

  async function updateProfile(nickname: string): Promise<AuthUser | null> {
    try {
      const data = await $fetch<{ ok: boolean; user: AuthUser }>(`${API_BASE}/account/profile`, {
        method: "PUT", body: { nickname }, credentials: "include", retry: 0,
      });
      setAuthenticatedUser(data.user);
      return data.user;
    } catch (e: any) {
      error.value = errorMessage(e, "昵称保存失败");
      return null;
    }
  }

  async function changePassword(currentPassword: string, newPassword: string): Promise<boolean> {
    try {
      await $fetch(`${API_BASE}/account/password`, {
        method: "PUT", body: { currentPassword, newPassword }, credentials: "include", retry: 0,
      });
      user.value = null;
      sessionReady.value = false;
      await initializeSession(true);
      return true;
    } catch (e: any) {
      error.value = errorMessage(e, "密码修改失败");
      if (errorStatus(e) === 401) {
        user.value = null;
        await initializeSession(true);
      }
      return false;
    }
  }

  function handleSessionExpired(message = "登录已过期，请重新登录。") {
    user.value = null;
    error.value = message;
    sessionReady.value = true;
  }

  return {
    locked, loading, error, user, sessionReady, sessionId, sessionError, initialized,
    fetchStatus, initializeSession, unlock, login, register, logout, updateProfile,
    changePassword, handleSessionExpired,
  };
}
