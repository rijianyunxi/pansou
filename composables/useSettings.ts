import { computed, onMounted, type Ref } from "vue";
import { MAX_USER_TG_CHANNELS, normalizeTelegramChannels, TG_CHANNEL_PATTERN } from "../utils/telegramChannels";
import { useAuth } from "./useAuth";

const USER_SETTINGS_STORAGE_KEY = "panhub.settings";

export interface UserSettings {
  /** 用户添加的 Telegram 频道：仅在首页选择“自定义频道”时使用 */
  userTgChannels: string[];
  /** 首页视觉风格 */
  theme: "classic" | "geometric";
}

export interface UseSettingsReturn {
  settings: Ref<UserSettings>;
  loadSettings: () => void;
  syncWithSession: () => Promise<void>;
  saveSettings: () => boolean;
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
  return normalizeTelegramChannels(value.filter((item): item is string => typeof item === "string"))
    .filter((name) => TG_CHANNEL_PATTERN.test(name)).slice(0, MAX_USER_TG_CHANNELS);
}

function sanitizeTheme(value: unknown): UserSettings["theme"] {
  return value === "geometric" ? "geometric" : "classic";
}

export function useSettings(): UseSettingsReturn {
  const auth = useAuth();
  const settings = useState<UserSettings>("user-search-settings", () => ({ userTgChannels: [], theme: "classic" }));
  // Channels are no longer stored in localStorage; both authenticated and
  // permitted anonymous channels live in SQLite (users.custom_channels_json or
  // sessions.custom_channels_json).
  const channelLimit = useState<number>("user-search-channel-limit", () => MAX_USER_TG_CHANNELS);
  const serverManaged = useState<boolean>("user-search-channels-server-managed", () => false);
  const settingsReady = useState<boolean>("user-search-settings-ready", () => false);
  const storageError = useState<string>("user-search-settings-error", () => "");

  function readLocalSettings(): void {
    if (typeof window === "undefined") return;
    try {
      const raw = localStorage.getItem(USER_SETTINGS_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      const theme = sanitizeTheme(parsed && typeof parsed === "object" ? (parsed as { theme?: unknown }).theme : undefined);
      // Remove legacy browser channel data while retaining the visual setting.
      settings.value = { userTgChannels: [], theme };
      localStorage.setItem(USER_SETTINGS_STORAGE_KEY, JSON.stringify({ theme }));
    } catch {
      settings.value = { ...settings.value, userTgChannels: [] };
      storageError.value = "无法读取浏览器设置，当前使用默认配置。";
    }
  }

  function loadSettings(): void {
    if (typeof window === "undefined" || settingsReady.value) return;
    readLocalSettings();
    settingsReady.value = true;
  }

  function applyChannels(channels: string[]): void {
    settings.value = { ...settings.value, userTgChannels: sanitizeChannels(channels).slice(0, channelLimit.value) };
  }

  async function syncWithSession(): Promise<void> {
    if (!settingsReady.value) loadSettings();
    // Never fall back to a browser copy. A logout must leave the UI empty, and
    // an anonymous session gets its own server-side channel list when allowed.
    applyChannels([]);
    serverManaged.value = false;
    channelLimit.value = MAX_USER_TG_CHANNELS;

    try {
      const result = await $fetch<{
        channels: string[];
        limit: number;
        anonymousCustomChannels?: boolean;
      }>("/api/account/channels", {
        credentials: "include", cache: "no-store", retry: 0,
      });
      if (typeof result.anonymousCustomChannels === "boolean") {
        auth.anonymousCustomChannels.value = result.anonymousCustomChannels;
      }
      serverManaged.value = true;
      channelLimit.value = Math.min(MAX_USER_TG_CHANNELS, Math.max(0, Number(result.limit) || MAX_USER_TG_CHANNELS));
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

  function saveSettings(): boolean {
    if (typeof window === "undefined" || !settingsReady.value) return false;
    try {
      // Theme is the only browser-persisted setting. Channel data is always
      // written through /api/account/channels.
      localStorage.setItem(USER_SETTINGS_STORAGE_KEY, JSON.stringify({
        theme: settings.value.theme,
      }));
      storageError.value = "";
      return true;
    } catch {
      storageError.value = "无法保存到浏览器：刷新后可能丢失本地设置，请检查浏览器存储权限。";
      return false;
    }
  }

  async function saveChannels(channels = settings.value.userTgChannels): Promise<boolean> {
    const next = sanitizeChannels(channels).slice(0, channelLimit.value);
    if (!auth.sessionReady.value) {
      applyChannels([]);
      storageError.value = "匿名会话尚未准备好，请稍后重试。";
      return false;
    }
    try {
      const result = await $fetch<{
        channels: string[];
        limit: number;
        anonymousCustomChannels?: boolean;
      }>("/api/account/channels", {
        method: "POST", body: { channels: next }, credentials: "include", retry: 0,
      });
      if (typeof result.anonymousCustomChannels === "boolean") {
        auth.anonymousCustomChannels.value = result.anonymousCustomChannels;
      }
      serverManaged.value = true;
      channelLimit.value = Math.min(MAX_USER_TG_CHANNELS, Number(result.limit) || channelLimit.value);
      applyChannels(result.channels || next);
      storageError.value = "";
      return true;
    } catch (error: any) {
      const status = error?.statusCode || error?.response?.status;
      if (status === 401 && auth.user.value) auth.handleSessionExpired();
      if (status === 403 && !auth.user.value) applyChannels([]);
      storageError.value = status === 403
        ? "自定义频道仅对登录用户开放，请先登录或注册。"
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
    saveSettings,
    saveChannels,
    applyChannels,
    channelLimit,
    isServerManaged: computed(() => serverManaged.value),
    storageError,
    settingsReady,
    resetToDefault,
  };
}
