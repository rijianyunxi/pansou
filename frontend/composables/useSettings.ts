import { useSharedState, apiFetch } from "../src/appRuntime";
import { computed, onMounted, type Ref } from "vue";
import { MAX_USER_CHANNELS, normalizeChannelNames, CHANNEL_NAME_PATTERN } from "../utils/customChannels";
import { useAuth } from "./useAuth";

const USER_SETTINGS_STORAGE_KEY = "pansou.settings";

export interface UserSettings {
  /** 用户添加的公开频道（当前即 Telegram 公开频道）：仅在首页选择“自定义频道”时使用 */
  userChannels: string[];
}

interface UseSettingsReturn {
  settings: Ref<UserSettings>;
  loadSettings: () => void;
  syncWithSession: () => Promise<void>;
  saveChannels: (channels?: string[]) => Promise<boolean>;
  applyChannels: (channels: string[]) => void;
  channelLimit: Ref<number>;
  isServerManaged: Ref<boolean>;
  storageError: Ref<string>;
  settingsReady: Ref<boolean>;
  resetToDefault: () => void;
}

function sanitizeChannels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return normalizeChannelNames(value.filter((item): item is string => typeof item === "string"))
    .filter((name) => CHANNEL_NAME_PATTERN.test(name)).slice(0, MAX_USER_CHANNELS);
}

export function useSettings(): UseSettingsReturn {
  const auth = useAuth();
  const settings = useSharedState<UserSettings>("user-search-settings", () => ({ userChannels: [] }));
  // Channels are no longer stored in localStorage; both authenticated and
  // permitted anonymous channels live in PostgreSQL (users.custom_channels_json or
  // sessions.custom_channels_json).
  const channelLimit = useSharedState<number>("user-search-channel-limit", () => MAX_USER_CHANNELS);
  const serverManaged = useSharedState<boolean>("user-search-channels-server-managed", () => false);
  const settingsReady = useSharedState<boolean>("user-search-settings-ready", () => false);
  const storageError = useSharedState<string>("user-search-settings-error", () => "");

  function loadSettings(): void {
    if (typeof window === "undefined" || settingsReady.value) return;
    // Nothing is persisted in the browser anymore; drop the key older
    // versions used for theme/channel data so stale entries do not linger.
    localStorage.removeItem(USER_SETTINGS_STORAGE_KEY);
    settingsReady.value = true;
  }

  function applyChannels(channels: string[]): void {
    settings.value = { ...settings.value, userChannels: sanitizeChannels(channels).slice(0, channelLimit.value) };
  }

  async function syncWithSession(): Promise<void> {
    if (!settingsReady.value) loadSettings();
    // Never fall back to a browser copy. A logout must leave the UI empty, and
    // an anonymous session gets its own server-side channel list when allowed.
    applyChannels([]);
    serverManaged.value = false;
    channelLimit.value = MAX_USER_CHANNELS;

    try {
      const result = await apiFetch<{
        channels: string[];
        limit: number;
        anonymousCustomChannels?: boolean;
      }>("/api/account/channels", {
        credentials: "include", cache: "no-store",
        // A 403 here is an expected policy state for anonymous visitors; the
        // catch branch handles it. Never broadcast it as a global page error.
        silentError: true,
      });
      if (typeof result.anonymousCustomChannels === "boolean") {
        auth.anonymousCustomChannels.value = result.anonymousCustomChannels;
      }
      serverManaged.value = true;
      channelLimit.value = Math.min(MAX_USER_CHANNELS, Math.max(0, Number(result.limit) || MAX_USER_CHANNELS));
      applyChannels(result.channels || []);
      storageError.value = "";
    } catch (error: any) {
      const status = error?.statusCode || error?.response?.status;
      if (status === 401 && auth.user.value) auth.handleSessionExpired("登录已过期，已切换为匿名会话。");
      applyChannels([]);
      // 403 is expected for anonymous visitors when anonymousCustomChannels is
      // false; do not turn that policy decision into an alarming page error.
      storageError.value = status === 403 && !auth.user.value
        ? ""
        : status === 403
          ? "当前账号暂时不能管理自定义频道。"
          : status === 401
            ? "登录已过期，请重新登录。"
            : "无法读取账号频道，请稍后重试。";
    }
  }

  async function saveChannels(channels = settings.value.userChannels): Promise<boolean> {
    const next = sanitizeChannels(channels).slice(0, channelLimit.value);
    if (!auth.sessionReady.value) {
      applyChannels([]);
      storageError.value = "匿名会话尚未准备好，请稍后重试。";
      return false;
    }
    try {
      const result = await apiFetch<{
        channels: string[];
        limit: number;
        anonymousCustomChannels?: boolean;
      }>("/api/account/channels", {
        method: "POST", body: { channels: next }, credentials: "include",
        // Callers surface failures inline (settings drawer / storageError);
        // a global toast would only duplicate that feedback.
        silentError: true,
      });
      if (typeof result.anonymousCustomChannels === "boolean") {
        auth.anonymousCustomChannels.value = result.anonymousCustomChannels;
      }
      serverManaged.value = true;
      channelLimit.value = Math.min(MAX_USER_CHANNELS, Number(result.limit) || channelLimit.value);
      applyChannels(result.channels || next);
      storageError.value = "";
      return true;
    } catch (error: any) {
      const status = error?.statusCode || error?.response?.status;
      if (status === 401 && auth.user.value) auth.handleSessionExpired();
      if (status === 403 && !auth.user.value) applyChannels([]);
      storageError.value = status === 403
        ? "未登录不可使用"
        : error?.data?.statusMessage || error?.message || "频道保存失败，请稍后重试。";
      return false;
    }
  }


  function resetToDefault(): void {
    void saveChannels([]);
  }

  onMounted(loadSettings);

  return {
    settings,
    loadSettings,
    syncWithSession,
    saveChannels,
    applyChannels,
    channelLimit,
    isServerManaged: computed(() => serverManaged.value),
    storageError,
    settingsReady,
    resetToDefault,
  };
}
