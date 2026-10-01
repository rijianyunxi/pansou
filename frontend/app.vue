<template>
  <div v-if="isAdminConsole" class="source-console-layout"><RouterView /></div>
  <div v-else class="layout">
    <!-- 顶部导航：左侧 Logo，右侧公共操作与账号入口 -->
    <header class="topnav" :inert="openSettings">
      <RouterLink v-if="canOpenAdminFromBrand" to="/admin" class="brand" aria-label="进入管理后台" title="进入管理后台">
        <span class="brand-mark">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round">
            <circle cx="11" cy="11" r="7"></circle>
            <path d="m20.5 20.5-4-4"></path>
          </svg>
        </span>
        <span class="brand-text">{{ siteName }}</span>
      </RouterLink>
      <span v-else class="brand">
        <span class="brand-mark">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round">
            <circle cx="11" cy="11" r="7"></circle>
            <path d="m20.5 20.5-4-4"></path>
          </svg>
        </span>
        <span class="brand-text">{{ siteName }}</span>
      </span>
      <nav class="topnav-actions" aria-label="主导航">
        <UserAccountPanel variant="wechat" />
      </nav>
    </header>

    <!-- 主内容区 -->
    <main class="main" :inert="openSettings">
      <RouterView />
    </main>

    <footer class="site-footer">
      <RouterLink to="/copyright">版权与免责声明</RouterLink>
      <span>网络公开信息不等于无版权</span>
    </footer>

    <!-- 设置抽屉 -->
      <SettingsDrawer
        v-model="settings"
        v-model:open="openSettings"
        :storage-error="storageError"
        @reset-default="resetToDefault" />

  </div>

  <!-- 全局接口通知：公共页面和管理后台共用。 -->
  <div v-if="toast.show" class="toast" :class="toast.type" role="alert" aria-live="assertive">
    {{ toast.message }}
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from "vue";
import { useRoute, RouterLink, RouterView } from "vue-router";
import { appConfig, setDocumentHead } from "./src/appRuntime";
import { useAuth } from "./composables/useAuth";
import { useSettings } from "./composables/useSettings";

import SettingsDrawer from "./components/SettingsDrawer.vue";
import UserAccountPanel from "./components/UserAccountPanel.vue";

const route = useRoute();
const isAdminConsole = computed(
  () => route.path === "/admin" || route.path.startsWith("/admin/"),
);
function publicText(key: keyof typeof appConfig): string {
  return appConfig[key];
}

const siteName = publicText("siteName");
const siteTitle = publicText("siteTitle");
const siteDescription = publicText("siteDescription");
const siteKeywords = publicText("siteKeywords");
const siteImageAlt = publicText("siteImageAlt");

setDocumentHead(() => ({
  title: siteTitle || siteName,
  meta: [
    {
      name: "robots",
      content: isAdminConsole.value ? "noindex,nofollow" : "index,follow",
    },
    { name: "description", content: siteDescription },
    { name: "keywords", content: siteKeywords },
    { name: "application-name", content: siteName },
    { property: "og:type", content: "website" },
    { property: "og:locale", content: "zh_CN" },
    { property: "og:site_name", content: siteName },
    { property: "og:title", content: siteTitle },
    { property: "og:description", content: siteDescription },
    { property: "og:image:type", content: "image/svg+xml" },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { property: "og:image:alt", content: siteImageAlt },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: siteTitle },
    { name: "twitter:description", content: siteDescription },
    { name: "twitter:image:alt", content: siteImageAlt },
  ],
}));

const { settings, settingsReady, storageError, loadSettings, resetToDefault } = useSettings();
const auth = useAuth();
const canOpenAdminFromBrand = computed(() => route.path === "/" && auth.user.value?.role === "admin");
const openSettings = ref(false);

watch(() => route.path, () => {
  openSettings.value = false;
});

// Toast 状态
const toast = ref({
  show: false,
  message: "",
  type: "info" as "info" | "success" | "error",
});

// 显示 Toast
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function showToast(message: string, type: "info" | "success" | "error" = "info") {
  if (!message.trim()) return;
  if (toastTimer) clearTimeout(toastTimer);
  toast.value = { show: true, message, type };
  toastTimer = setTimeout(() => {
    toast.value.show = false;
    toastTimer = undefined;
  }, type === "error" ? 6000 : 3500);
}

function handleGlobalApiError(event: Event) {
  const detail = (event as CustomEvent<{ message?: string }>).detail;
  showToast(detail?.message || "接口请求失败，请稍后重试。", "error");
}

const canUseCustomChannels = computed(() => !!auth.user.value || auth.anonymousCustomChannels.value);
function openChannelSettings() {
  if (!canUseCustomChannels.value) {
    showToast("自定义频道需要在微信小程序中登录后使用，或由管理员开启「允许匿名用户使用自定义频道」。", "info");
    return;
  }
  openSettings.value = true;
}
provide("openChannelSettings", openChannelSettings);

onMounted(() => {
  window.addEventListener("pansou:api-error", handleGlobalApiError);
  loadSettings();
});

onBeforeUnmount(() => {
  window.removeEventListener("pansou:api-error", handleGlobalApiError);
  if (toastTimer) clearTimeout(toastTimer);
});

// 暴露给子组件使用
provide('showToast', showToast);
</script>

<style>
/* 全局样式：干净扁平的浅色设计系统 */
html {
  -webkit-text-size-adjust: 100%;
  touch-action: manipulation;
}

body {
  margin: 0;
  overflow-x: hidden;
}

button, a, input, select, textarea {
  touch-action: manipulation;
}

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
  /* 使用系统字体，避免请求 Google Fonts 的 CSS 和字体文件。 */
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
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

  /*
   * iOS Safari 会在聚焦字号小于 16px 的输入控件时自动放大页面，
   * 放大后的视觉视口可能产生横向滚动条。不要通过禁用用户缩放来规避，
   * 直接保证所有可编辑控件达到 iOS 的免缩放字号阈值。
   */
  input:not([type="checkbox"]):not([type="radio"]),
  select,
  textarea {
    max-width: 100%;
    font-size: 16px !important;
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
.nav-action-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  height: 44px;
  border: var(--nav-action-border, 1px solid var(--border-light));
  border-radius: 999px;
  background: var(--nav-action-bg, var(--bg-primary));
  color: var(--nav-action-color, var(--text-secondary));
  box-shadow: var(--nav-action-shadow, none);
  transition: background-color var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
}
/* Touch taps must not leave desktop hover colors stuck on the control. */
@media (hover: hover) and (pointer: fine) {
  .nav-action-button:hover:not(:disabled) {
    background: var(--nav-action-hover-bg, var(--bg-secondary));
    color: var(--nav-action-color, var(--text-primary));
    border-color: var(--border-medium);
  }
}
.nav-action-button:active:not(:disabled) { opacity: .78; }
.nav-action-button:focus-visible { outline: 2px solid var(--primary); outline-offset: 3px; }

</style>

<style scoped>
/* 主布局：顶部导航 + 内容区 */
.layout {
  min-height: 100vh;
  min-width: 0;
  overflow-x: clip;
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
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.topnav-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
  flex: 1 1 auto;
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
  min-width: 0;
  max-width: 1100px;
  margin: 0 auto;
  padding: 24px;
  animation: fadeIn 0.4s ease;
}

.site-footer {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 8px 14px;
  padding: 0 24px 28px;
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 1.6;
  text-align: center;
}

.site-footer a {
  color: var(--text-secondary);
  text-underline-offset: 3px;
}

.site-footer a:hover {
  color: var(--primary);
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
    gap: 8px;
    padding: 0 12px;
    height: 56px;
  }

  .topnav-actions {
    gap: 10px;
  }

  /* 外圈缩小到 36px，外围透明热区仍提供 44px 触控范围。 */
  .layout .topnav-actions :deep(.nav-action-button) {
    position: relative;
    width: 36px;
    min-width: 36px;
    height: 36px;
    min-height: 36px;
    flex: 0 0 36px;
  }

  .layout .topnav-actions :deep(.nav-action-button::before) {
    content: "";
    position: absolute;
    inset: -4px;
    border-radius: inherit;
  }

  .topnav-actions :deep(.nav-action-button svg) {
    width: 18px;
    height: 18px;
  }

  .brand {
    flex: 0 1 auto;
    min-width: 0;
    gap: 7px;
  }

  .brand-text {
    max-width: 82px;
    font-size: 15px;
  }

  .main {
    padding: 16px;
  }

  .site-footer {
    padding: 0 16px 22px;
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
