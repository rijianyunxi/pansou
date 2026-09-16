<template>
  <div v-if="isAdminConsole" class="upstream-console-layout"><NuxtPage /></div>
  <div v-else class="layout" :class="`theme-${settings.theme}`">
    <!-- 顶部导航：左侧 Logo，右侧接口文档 / 设置 -->
    <header class="topnav" :inert="openSettings">
      <NuxtLink to="/" class="brand">
        <span class="brand-mark">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round">
            <circle cx="11" cy="11" r="7"></circle>
            <path d="m20.5 20.5-4-4"></path>
          </svg>
        </span>
        <span class="brand-text">PanHub</span>
      </NuxtLink>
      <nav class="topnav-actions" aria-label="主导航">
        <NuxtLink
          v-if="adminSessionActive"
          class="admin-console-entry"
          to="/admin"
          aria-label="打开管理控制台"
          title="管理控制台">
          <ConsoleIcon name="shield" :size="16" />
          <span>管理控制台</span>
        </NuxtLink>
        <div class="theme-switcher" role="group" aria-label="首页风格">
          <button
            type="button"
            :class="{ active: settings.theme === 'classic' }"
            :aria-pressed="settings.theme === 'classic'"
            @click="setTheme('classic')">
            原始
          </button>
          <button
            type="button"
            :class="{ active: settings.theme === 'geometric' }"
            :aria-pressed="settings.theme === 'geometric'"
            @click="setTheme('geometric')">
            明快
          </button>
        </div>
        <button class="btn-icon" type="button" @click="openSettings = true" aria-label="打开设置" title="设置">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
          </svg>
        </button>
      </nav>
    </header>

    <!-- 主内容区 -->
    <main class="main" :inert="openSettings">
      <NuxtPage />
    </main>

    <!-- 设置抽屉 -->
    <ClientOnly>
      <SettingsDrawer
        v-model="settings"
        v-model:open="openSettings"
        :storage-error="storageError"
        @reset-default="resetToDefault" />
    </ClientOnly>

    <!-- Toast 通知 -->
    <div v-if="toast.show" class="toast" :class="toast.type" role="status" aria-live="polite">
      {{ toast.message }}
    </div>

    <!-- 密码门（仅在用户发起搜索时弹出） -->
    <ClientOnly>
      <PasswordGate
        :show="showPasswordGate"
        :error="auth.error.value || ''"
        :submitting="unlockSubmitting"
        @unlock="onUnlock" />
    </ClientOnly>
  </div>
</template>

<script setup lang="ts">
import ConsoleIcon from "./components/upstreams/ConsoleIcon.vue";

const route = useRoute();
const isAdminConsole = computed(
  () => route.path === "/admin" || route.path.startsWith("/admin/"),
);
const { settings, settingsReady, storageError, loadSettings, saveSettings, resetToDefault } = useSettings();
const auth = useAuth();
const adminStatus = await useFetch<{ configured: boolean; locked: boolean }>(
  "/api/auth/admin-status",
  { key: "public-admin-status", server: true },
);
const adminSessionActive = computed(() =>
  adminStatus.data.value?.configured === true && adminStatus.data.value?.locked === false,
);
const openSettings = ref(false);

function setTheme(theme: "classic" | "geometric") {
  settings.value.theme = theme;
}

watch(() => route.path, () => {
  openSettings.value = false;
  if (!isAdminConsole.value) void adminStatus.refresh();
});
provide("openChannelSettings", () => { openSettings.value = true; });
const showPasswordGate = ref(false);
const unlockSubmitting = ref(false);
const pendingOnUnlock = ref<(() => void) | null>(null);

function requestUnlock(onSuccess?: () => void) {
  pendingOnUnlock.value = onSuccess ?? null;
  showPasswordGate.value = true;
}

async function onUnlock(password: string) {
  unlockSubmitting.value = true;
  const ok = await auth.unlock(password);
  unlockSubmitting.value = false;
  if (ok) {
    showPasswordGate.value = false;
    const cb = pendingOnUnlock.value;
    pendingOnUnlock.value = null;
    if (cb) {
      nextTick(() => cb());
    }
  }
}

provide("requestUnlock", requestUnlock);

// Toast 状态
const toast = ref({
  show: false,
  message: "",
  type: "info" as "info" | "success" | "error",
});

// 显示 Toast
function showToast(message: string, type: "info" | "success" | "error" = "info") {
  toast.value = { show: true, message, type };
  setTimeout(() => {
    toast.value.show = false;
  }, 3000);
}

// 监听设置变化并持久化（设置抽屉内即时生效）
watch(() => JSON.stringify(settings.value), (newVal, oldVal) => {
  if (settingsReady.value && oldVal !== newVal) {
    saveSettings();
  }
}, { flush: "sync" });

onMounted(() => {
  loadSettings();
  auth.fetchStatus();
});

// 暴露给子组件使用
provide('showToast', showToast);
</script>

<style>
/* 全局样式：干净扁平的浅色设计系统 */
@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Noto+Sans+SC:wght@400;500;700;900&display=swap");

:root {
  --primary: #2563eb;
  --primary-dark: #1d4ed8;
  --primary-soft: #eff6ff;
  --secondary: #f59e0b;
  --success: #10b981;
  --warning: #d97706;
  --error: #ef4444;

  /* 黑色主按钮（Genspark 风格） */
  --ink: #111827;
  --ink-hover: #000000;

  --bg-primary: #ffffff;
  --bg-secondary: #f6f7f9;
  --bg-glass: #ffffff;

  --text-primary: #111827;
  --text-secondary: #4b5563;
  --text-tertiary: #9ca3af;

  --border-light: #e5e7eb;
  --border-medium: #d1d5db;

  --shadow-sm: 0 1px 2px 0 rgba(17, 24, 39, 0.04);
  --shadow-md: 0 4px 12px 0 rgba(17, 24, 39, 0.06);
  --shadow-lg: 0 8px 28px 0 rgba(17, 24, 39, 0.08);
  --shadow-xl: 0 16px 40px -8px rgba(17, 24, 39, 0.14);

  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;
  --radius-xl: 24px;

  --transition-fast: 150ms ease;
  --transition-normal: 250ms ease;
  --transition-slow: 350ms ease;
}

/* 基础重置 */
* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  padding: 0;
  font-family: "Inter", "Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  background: #ffffff;
  color: var(--text-primary);

  /* iOS Safari兼容性 */
  -webkit-text-size-adjust: 100%;
  -webkit-tap-highlight-color: transparent;
  -webkit-overflow-scrolling: touch;
}

/* 滚动条美化 */
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

::-webkit-scrollbar-track {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  background: var(--border-light);
  border-radius: 4px;
}

::-webkit-scrollbar-thumb:hover {
  background: var(--border-medium);
}

/* 输入框基础样式 */
input[type="text"],
input[type="search"],
input[type="email"],
input[type="password"],
input[type="number"],
textarea,
select {
  -webkit-appearance: none;
  -webkit-border-radius: 0;
  border-radius: 0;
  -webkit-text-size-adjust: 100%;
  font-family: inherit;
}

/* 按钮基础样式 */
button {
  -webkit-appearance: none;
  -webkit-tap-highlight-color: transparent;
  font-family: inherit;
  cursor: pointer;
}

/* iOS Safari触摸区域优化 */
@media (max-width: 640px) {
  button,
  input,
  select,
  textarea {
    min-height: 44px;
    min-width: 44px;
  }

  .admin-console-entry {
    width: 38px;
    min-width: 38px;
    padding: 0;
    justify-content: center;
  }

  .admin-console-entry span {
    display: none;
  }
}

/* 动画定义 */
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes slideInRight {
  from { transform: translateX(100%); }
  to { transform: translateX(0); }
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
</style>

<style>
/* 明快几何主题：仅作用于搜索站点，不影响后台控制台 */
.layout.theme-geometric {
  --primary: #3155e7;
  --primary-dark: #243fb5;
  --primary-soft: #e9edff;
  --ink: #20201e;
  --ink-hover: #000000;
  --bg-primary: #fffefa;
  --bg-secondary: #fffbed;
  --text-primary: #20201e;
  --text-secondary: #56564f;
  --text-tertiary: #76766b;
  --border-light: #252621;
  --border-medium: #20201e;
  --shadow-sm: 3px 3px 0 rgba(32, 32, 30, 0.92);
  --shadow-md: 4px 4px 0 rgba(32, 32, 30, 0.92);
  --shadow-lg: 5px 5px 0 rgba(32, 32, 30, 0.92);
  --shadow-xl: 6px 6px 0 rgba(32, 32, 30, 0.92);
  --radius-sm: 5px;
  --radius-md: 6px;
  --radius-lg: 10px;
  --radius-xl: 10px;
  background: #fffbed;
}

.layout.theme-geometric .topnav {
  background: #fffbed;
  border-bottom: 2px solid #20201e;
}

.layout.theme-geometric .brand-mark {
  background: #ffe48a;
  border: 2px solid #20201e;
}

.layout.theme-geometric .brand-mark svg { stroke: #20201e; }
.layout.theme-geometric .brand-text { font-weight: 850; }
.layout.theme-geometric .theme-switcher {
  display: inline-flex;
  gap: 3px;
  padding: 3px;
  border: 2px solid #20201e;
  border-radius: 7px;
  background: #fffefa;
}
.layout.theme-geometric .theme-switcher button {
  min-height: 30px;
  padding: 0 9px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #56564f;
  font-size: 11px;
  font-weight: 700;
}
.layout.theme-geometric .theme-switcher button.active {
  background: #ffe48a;
  color: #20201e;
}
.layout.theme-geometric .theme-switcher button:focus-visible {
  outline: 2px solid #3155e7;
  outline-offset: 2px;
}
.layout.theme-geometric .btn-icon:hover { background: #ffe48a; color: #20201e; }
.layout.theme-geometric .main { max-width: 1240px; padding: 30px 28px 42px; }
.layout.theme-geometric .home { max-width: 1040px; gap: 20px; }
.layout.theme-geometric .hero {
  position: relative;
  text-align: left;
  padding: 28px 150px 18px 8px;
}
.layout.theme-geometric .hero::after {
  content: "";
  position: absolute;
  right: 25px;
  top: 15px;
  width: 92px;
  height: 92px;
  border: 2px solid #20201e;
  border-radius: 50%;
  background: #ffe48a;
  box-shadow: 18px 22px 0 -5px #ffb687, 18px 22px 0 -3px #20201e;
}
.layout.theme-geometric .hero-title {
  max-width: 650px;
  font-size: clamp(37px, 5vw, 58px);
  line-height: 1.15;
  letter-spacing: -0.05em;
}
.layout.theme-geometric .hero-title::after {
  content: "";
  display: block;
  width: 184px;
  height: 10px;
  margin-top: -12px;
  background: #ffe48a;
  transform: rotate(-2deg);
  position: relative;
  z-index: -1;
}
.layout.theme-geometric .hero-description { color: #56564f; font-weight: 500; }
.layout.theme-geometric .search-workspace {
  position: relative;
  gap: 12px;
  padding: 18px 20px 20px;
  border: 2px solid #20201e;
  border-radius: 10px;
  background: #3155e7;
  box-shadow: 5px 5px 0 #20201e;
}
.layout.theme-geometric .search-toolbar { align-items: center; }
.layout.theme-geometric .search-workspace .scope-control {
  padding: 3px;
  border: 0;
  border-radius: 6px;
  background: transparent;
}
.layout.theme-geometric .search-workspace .scope-control button {
  color: #fffefa;
  border: 1px solid transparent;
  border-radius: 5px;
}
.layout.theme-geometric .search-workspace .scope-control button[aria-pressed="true"] {
  background: #ffe48a;
  color: #20201e;
  border-color: #20201e;
  box-shadow: 2px 2px 0 #20201e;
}
.layout.theme-geometric .search-workspace .scope-control .count {
  background: #fffefa;
  color: #20201e;
}
.layout.theme-geometric .manage-channels { color: #fffefa; }
.layout.theme-geometric .manage-channels:hover { background: rgba(255,255,255,.16); }
.layout.theme-geometric .search-workspace .search-box {
  padding: 13px 14px 12px;
  gap: 11px;
  background: #fffefa;
  border: 2px solid #20201e;
  border-radius: 5px;
  box-shadow: none;
}
.layout.theme-geometric .search-workspace .search-box.focused {
  border-color: #20201e;
  box-shadow: 3px 3px 0 #ffe48a;
}
.layout.theme-geometric .search-workspace .search-input { color: #20201e; font-weight: 550; }
.layout.theme-geometric .search-workspace .search-input::placeholder { color: #76766b; }
.layout.theme-geometric .search-workspace .search-icon { color: #20201e; }
.layout.theme-geometric .search-workspace .action-btn.primary {
  background: #ffe48a;
  color: #20201e;
  border: 1px solid #20201e;
  border-radius: 4px;
  box-shadow: 2px 2px 0 #20201e;
}
.layout.theme-geometric .search-workspace .action-btn.primary:hover:not(:disabled) {
  background: #ffb687;
  transform: translate(1px, 1px);
  box-shadow: 1px 1px 0 #20201e;
}
.layout.theme-geometric .search-workspace .action-btn.reset,
.layout.theme-geometric .search-workspace .action-btn.pause,
.layout.theme-geometric .search-workspace .action-btn.resume {
  border-color: #20201e;
  border-radius: 4px;
  color: #20201e;
  background: #fffbed;
}
.layout.theme-geometric .channel-configuration-notice,
.layout.theme-geometric .search-notice,
.layout.theme-geometric .stats-bar {
  border: 2px solid #20201e;
  border-radius: 6px;
  background: #fffefa;
  box-shadow: 3px 3px 0 #20201e;
}
.layout.theme-geometric .scope-summary { color: #fffefa; }
.layout.theme-geometric .channel-chip { color: #20201e; background: #ffe48a; border-color: #20201e; border-radius: 4px; }
.layout.theme-geometric .configure-channels { border: 2px solid #20201e; border-radius: 4px; background: #ffe48a; color: #20201e; }
.layout.theme-geometric .hot-search-section .tag-cloud-card {
  padding: 18px;
  border: 2px solid #20201e;
  border-radius: 6px;
  background: #fffefa;
  box-shadow: 4px 4px 0 #20201e;
}
.layout.theme-geometric .hot-search-section .cloud-title {
  color: #20201e;
  text-align: left;
  font-weight: 800;
  letter-spacing: .04em;
}
.layout.theme-geometric .hot-search-section .hot-tagcloud-item { color: #3155e7 !important; }
.layout.theme-geometric .hot-search-section .hot-tagcloud-item:hover { color: #d65f3f !important; }
.layout.theme-geometric .filter-pill.active { background: #ffe48a; color: #20201e; border-color: #20201e; }
.layout.theme-geometric .sort-select { border: 2px solid #20201e; border-radius: 4px; background: #fffefa; color: #20201e; }

@media (max-width: 640px) {
  .layout.theme-geometric .main { padding: 16px 14px 30px; }
  .layout.theme-geometric .hero { padding: 25px 8px 12px; }
  .layout.theme-geometric .hero::after { right: 12px; top: 9px; width: 58px; height: 58px; box-shadow: 12px 14px 0 -4px #ffb687, 12px 14px 0 -2px #20201e; }
  .layout.theme-geometric .hero-title { padding-right: 42px; font-size: 38px; }
  .layout.theme-geometric .search-workspace { padding: 13px; }
  .layout.theme-geometric .theme-switcher button { padding: 0 7px; }
}
</style>

<style scoped>
/* 主布局：顶部导航 + 内容区 */
.layout {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

/* 顶部导航 */
.topnav {
  position: sticky;
  top: 0;
  z-index: 100;
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 24px;
  background: var(--bg-primary);
  border-bottom: 1px solid var(--border-light);
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  text-decoration: none;
  color: var(--text-primary);
}

.brand-mark {
  width: 30px;
  height: 30px;
  border-radius: 9px;
  background: var(--ink);
  display: flex;
  align-items: center;
  justify-content: center;
}

.brand-text {
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.topnav-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.theme-switcher {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--border-light);
  border-radius: 9px;
  background: var(--bg-secondary);
}

.theme-switcher button {
  min-height: 29px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 600;
}

.theme-switcher button.active {
  background: var(--bg-primary);
  color: var(--primary);
  box-shadow: var(--shadow-sm);
}

.theme-switcher button:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}

.admin-console-entry {
  min-height: 38px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 0 11px;
  border: 1px solid var(--border-light);
  border-radius: 10px;
  color: var(--text-secondary);
  background: var(--bg-primary);
  font-size: 12px;
  font-weight: 600;
  text-decoration: none;
  transition: background-color var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast);
}

.admin-console-entry:hover {
  border-color: #bfdbfe;
  color: var(--primary-dark);
  background: var(--primary-soft);
}

.admin-console-entry:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}

.topnav-link {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-secondary);
  text-decoration: none;
  padding: 8px 14px;
  border-radius: 10px;
  transition: background-color var(--transition-fast), color var(--transition-fast);
}

.topnav-link:hover {
  color: var(--text-primary);
  background: var(--bg-secondary);
}

.topnav-link.active {
  color: var(--primary);
  background: var(--primary-soft);
  font-weight: 600;
}

/* 图标按钮 */
.btn-icon {
  width: 38px;
  height: 38px;
  border: none;
  background: transparent;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  transition: background-color var(--transition-fast), color var(--transition-fast);
}

.btn-icon:hover {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

/* 主内容区 */
.main {
  flex: 1;
  width: 100%;
  max-width: 1100px;
  margin: 0 auto;
  padding: 24px;
  animation: fadeIn 0.4s ease;
}

/* Toast 通知 */
.toast {
  position: fixed;
  top: 72px;
  right: 24px;
  padding: 12px 20px;
  border-radius: var(--radius-md);
  background: var(--bg-primary);
  box-shadow: var(--shadow-xl);
  border: 1px solid var(--border-light);
  font-weight: 500;
  z-index: 1000;
  animation: slideInRight 0.3s ease;
  display: flex;
  align-items: center;
  gap: 8px;
}

.toast::before {
  content: "";
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
}

.toast.info {
  color: var(--primary);
  border-left: 4px solid var(--primary);
}

.toast.success {
  color: var(--success);
  border-left: 4px solid var(--success);
}

.toast.error {
  color: var(--error);
  border-left: 4px solid var(--error);
}

/* 移动端优化 */
@media (max-width: 640px) {
  .topnav {
    padding: 0 16px;
    height: 56px;
  }

  .main {
    padding: 16px;
  }

  .toast {
    right: 16px;
    left: 16px;
    top: 64px;
  }
}

/* 深色模式支持 */
@media (prefers-color-scheme: dark) {
  :global(:root) {
    --primary: #60a5fa;
    --primary-dark: #93c5fd;
    --primary-soft: rgba(96, 165, 250, 0.12);
    --ink: #f3f4f6;
    --ink-hover: #ffffff;
    --bg-primary: #0f1218;
    --bg-secondary: #1a1f29;
    --bg-glass: #0f1218;
    --text-primary: #f3f4f6;
    --text-secondary: #9ca3af;
    --text-tertiary: #6b7280;
    --border-light: #242a35;
    --border-medium: #323a48;
  }

  :global(body) {
    background: #0f1218;
  }

  .brand-mark {
    background: #f3f4f6;
  }

  .brand-mark svg {
    stroke: #0f1218;
  }

  .toast {
    background: var(--bg-secondary);
    border-color: var(--border-light);
  }
}

/* 高对比度模式支持 */
@media (prefers-contrast: high) {
  .topnav-link.active {
    border: 1px solid var(--primary);
  }
}

/* 减少动画模式支持 */
@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
</style>
