<template>
  <div v-if="isUpstreamConsole" class="upstream-console-layout"><NuxtPage /></div>
  <div v-else class="layout">
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
const isUpstreamConsole = computed(
  () =>
    route.path === "/admin" ||
    route.path.startsWith("/admin/") ||
    route.path === "/upstreams" ||
    route.path.startsWith("/upstreams/") ||
    route.path === "/telegram" ||
    route.path.startsWith("/telegram/") ||
    route.path === "/tg-accounts" ||
    route.path.startsWith("/tg-accounts/") ||
    route.path === "/monitor" ||
    route.path.startsWith("/monitor/"),
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
watch(() => route.path, () => {
  openSettings.value = false;
  if (!isUpstreamConsole.value) void adminStatus.refresh();
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
