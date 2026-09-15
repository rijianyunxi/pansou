import { onMounted, type Ref } from "vue";
import { MAX_USER_TG_CHANNELS, normalizeTelegramChannels, TG_CHANNEL_PATTERN } from "../utils/telegramChannels";

const USER_SETTINGS_STORAGE_KEY = "panhub.settings";

export interface UserSettings {
  /** 用户添加的 Telegram 频道：仅在首页选择“自定义频道”时使用 */
  userTgChannels: string[];
  /** 首页视觉风格：classic 保留原始风格，geometric 使用明快几何风格 */
  theme: "classic" | "geometric";
}

export interface UseSettingsReturn {
  settings: Ref<UserSettings>;
  loadSettings: () => void;
  saveSettings: () => boolean;
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
  // Nuxt request-scoped state avoids sharing user preferences across SSR requests.
  const settings = useState<UserSettings>("user-search-settings", () => ({ userTgChannels: [], theme: "classic" }));

  const settingsReady = useState<boolean>("user-search-settings-ready", () => false);
  const storageError = useState<string>("user-search-settings-error", () => "");

  // Load once per browser session: page remounts must not replace in-memory edits.
  // 加载设置
  function loadSettings(): void {
    if (typeof window === "undefined" || settingsReady.value) return;

    try {
      const raw = localStorage.getItem(USER_SETTINGS_STORAGE_KEY);
      if (!raw) return;

      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return;

      settings.value = {
        userTgChannels: sanitizeChannels(parsed.userTgChannels),
        theme: sanitizeTheme(parsed.theme),
      };
    } catch (_error) {
      storageError.value = "无法读取浏览器设置，当前使用默认配置。";
    } finally {
      settingsReady.value = true;
    }
  }

  // 保存失败不丢弃内存设置，本次搜索仍然可用。
  function saveSettings(): boolean {
    if (typeof window === "undefined" || !settingsReady.value) return false;
    try {
      localStorage.setItem(USER_SETTINGS_STORAGE_KEY, JSON.stringify({
        userTgChannels: settings.value.userTgChannels,
        theme: settings.value.theme,
      }));
      storageError.value = "";
      return true;
    } catch {
      storageError.value = "无法保存到浏览器：当前页面仍可使用这些频道，刷新后可能丢失。请检查浏览器存储权限。";
      return false;
    }
  }

  function resetToDefault(): void {
    settings.value = { ...settings.value, userTgChannels: [] };
    saveSettings();
  }

  // 页面加载时自动加载设置
  onMounted(loadSettings);

  return {
    settings,
    settingsReady,
    storageError,
    loadSettings,
    saveSettings,
    resetToDefault,
  };
}
