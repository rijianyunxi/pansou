<template>
  <div class="account-control">
    <button v-if="showLoginTrigger" class="account-trigger nav-action-button" type="button" aria-label="登录" title="登录" :disabled="!auth.sessionReady.value" @click="openLogin">
      <svg class="account-login-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></svg>
    </button>
    <button v-else-if="currentUser" class="account-trigger nav-action-button account-trigger--signed" type="button" :aria-expanded="openState" aria-label="已登录，打开账号菜单" aria-haspopup="true" @click="toggleAccountMenu">
      <svg class="account-login-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></svg>
      <span class="account-status-dot" aria-hidden="true"></span>
    </button>

    <Teleport to="body">
      <div v-if="openState && currentUser" class="account-menu-layer" :class="`account-theme-${settings.settings.value.theme}`" @click.self="close">
        <section class="account-menu" aria-label="账号操作">
          <div class="account-menu-summary">
            <strong>{{ displayName }}</strong>
            <span>@{{ currentUser.username }}</span>
          </div>
          <NuxtLink v-if="currentUser.role === 'admin'" class="account-admin" to="/admin" :prefetch="false" @click="close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m12 3 8 4v5c0 5-8 9-8 9s-8-4-8-9V7z" /><path d="m8 12 3 3 5-6" /></svg>
            管理后台
          </NuxtLink>
          <button class="account-danger" type="button" :disabled="busy" @click="signOut">退出登录</button>
        </section>
      </div>
      <div v-else-if="openState" class="account-mask" :class="`account-theme-${settings.settings.value.theme}`" @click.self="close">
        <section class="account-modal" role="dialog" aria-modal="true" aria-labelledby="account-title">
          <header class="account-header">
            <div>
              <p class="account-kicker">PANHUB ACCOUNT</p>
              <h2 id="account-title">登录管理后台</h2>
            </div>
            <button type="button" class="account-close" aria-label="关闭" @click="close">×</button>
          </header>

          <p v-if="auth.sessionError.value" class="account-error" role="alert">{{ auth.sessionError.value }}</p>
          <p v-if="auth.error.value" class="account-error" role="alert">{{ auth.error.value }}</p>

          <form class="account-form" @submit.prevent="submitAuth">
            <label>用户名<input v-model.trim="username" required minlength="4" maxlength="32" autocomplete="username" placeholder="4-32 位字母、数字或下划线" /></label>
            <label>密码<input v-model="password" required minlength="6" maxlength="128" type="password" autocomplete="current-password" placeholder="至少 6 个字符" /></label>
            <button class="account-submit" type="submit" :disabled="busy || !username || password.length < 6">
              {{ busy ? '处理中…' : '登录' }}
            </button>
          </form>
          <p class="account-note">此入口仅供管理员登录后台；普通用户请使用微信小程序登录。</p>
        </section>
      </div>
    </Teleport>

    <!-- 网站前台的账号入口走微信扫码；后台入口仍由 variant="admin" 使用账号密码。 -->
    <ClientOnly>
      <WechatQrLoginPanel v-if="qrOpen" @close="qrOpen = false" @authenticated="onQrAuthenticated" />
    </ClientOnly>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { AuthUser } from "../composables/useAuth";

/**
 * `admin` keeps the username/password form the console gate needs; `wechat` is
 * the website entry, which signs in by scanning a mini-program code.
 */
const props = withDefaults(defineProps<{ variant?: "admin" | "wechat" }>(), { variant: "admin" });

const emit = defineEmits<{ authenticated: [user: AuthUser] }>();
const auth = useAuth();
const settings = useSettings();
const openState = ref(false);
const qrOpen = ref(false);
const busy = ref(false);
const username = ref("");
const password = ref("");
const currentUser = computed(() => auth.user.value);
const displayName = computed(() => currentUser.value?.nickname || currentUser.value?.username || "用户");
// The console gate must always offer its own sign-in control; the website entry
// additionally honours the console switch.
const showLoginTrigger = computed(
  () => !currentUser.value && (props.variant === "admin" || auth.showAuthButtons.value),
);

function openLogin() {
  if (props.variant === "wechat") {
    qrOpen.value = true;
    return;
  }
  clearForm();
  openState.value = true;
}
async function onQrAuthenticated(user: AuthUser) {
  qrOpen.value = false;
  emit("authenticated", user);
}
function toggleAccountMenu() {
  if (busy.value) return;
  openState.value = !openState.value;
}
function close() { openState.value = false; qrOpen.value = false; }
function clearError() { auth.error.value = ""; }
function clearForm() {
  clearError();
  username.value = "";
  password.value = "";
}
async function submitAuth() {
  if (busy.value) return;
  busy.value = true;
  const result = await auth.login(username.value, password.value);
  if (result) {
    await settings.syncWithSession();
    emit("authenticated", result);
    clearForm();
    close();
  }
  busy.value = false;
}
async function signOut() {
  if (busy.value) return;
  busy.value = true;
  await auth.logout();
  await settings.syncWithSession();
  busy.value = false;
  close();
}
function onKeydown(event: KeyboardEvent) { if (event.key === "Escape") close(); }
onUnmounted(() => window.removeEventListener("keydown", onKeydown));
onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  void auth.initializeSession();
});
</script>

<style scoped>
.account-control { display: inline-flex; min-width: 0; flex: 0 1 auto; }
.account-trigger { width: 44px; min-width: 44px; flex: 0 0 44px; max-width: 100%; padding: 0; font: inherit; font-size: 12px; font-weight: 650; cursor: pointer; }
.account-login-icon { flex-shrink: 0; }
.account-trigger:disabled { opacity: .65; cursor: wait; }
.account-trigger.account-trigger--signed { position: relative; width: 44px; height: 44px; min-height: 44px; padding: 0; justify-content: center; flex: 0 0 44px; border-radius: 50%; }
.account-trigger--signed .account-login-icon { width: 20px; height: 20px; }
.account-status-dot { position: absolute; right: 5px; bottom: 5px; width: 7px; height: 7px; border: 2px solid var(--bg-primary); border-radius: 50%; background: #22c55e; }
.account-trigger:focus-visible, .account-admin:focus-visible, .account-danger:focus-visible { outline: 2px solid var(--primary); outline-offset: 3px; }
.account-avatar { display: grid; place-items: center; width: 21px; height: 21px; flex: 0 0 21px; border-radius: 50%; background: transparent; color: inherit; font-size: 11px; font-weight: 800; }
.account-mask { position: fixed; inset: 0; z-index: 1200; display: grid; place-items: center; padding: 18px; overflow-y: auto; overscroll-behavior: contain; background: rgba(15, 23, 42, .48); backdrop-filter: blur(5px); }
.account-menu-layer { position: fixed; inset: 0; z-index: 1200; }
.account-menu { position: absolute; top: 62px; right: 18px; width: min(220px, calc(100vw - 36px)); padding: 13px; border: 1px solid var(--border-light); border-radius: 12px; background: var(--bg-primary); box-shadow: var(--shadow-xl); }
.account-menu-summary { display: flex; flex-direction: column; gap: 3px; padding: 3px 4px 12px; }
.account-menu-summary strong { color: var(--text-primary); font-size: 13px; }
.account-menu-summary span { color: var(--text-secondary); font-size: 11px; }
.account-menu .account-danger { width: 100%; min-height: 44px; }
.account-admin { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px; margin-bottom: 8px; padding: 8px 13px; border: 1px solid var(--border-light); border-radius: 9px; background: var(--bg-secondary); color: var(--text-primary); text-decoration: none; font-size: 12px; font-weight: 700; }
.account-admin:hover { background: var(--primary-soft); color: var(--primary); }
.account-menu-summary { overflow-wrap: anywhere; }
.account-modal { width: min(460px, 100%); max-height: min(720px, calc(100vh - 36px)); overflow-y: auto; padding: 24px; border: 1px solid var(--border-light); border-radius: 18px; background: var(--bg-primary); box-shadow: var(--shadow-xl); color: var(--text-primary); }
.account-header { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
.account-kicker { margin: 0 0 5px; color: var(--primary); font-size: 10px; font-weight: 800; letter-spacing: .14em; }
.account-header h2 { margin: 0; font-size: 22px; }
.account-close { width: 34px; height: 34px; border: 0; border-radius: 8px; background: transparent; color: var(--text-secondary); font-size: 24px; cursor: pointer; }
.account-close:hover { background: var(--bg-secondary); color: var(--text-primary); }
.account-form { display: flex; flex-direction: column; gap: 12px; }
.account-form label { display: flex; flex-direction: column; gap: 5px; color: var(--text-secondary); font-size: 12px; font-weight: 650; }
.account-form input { min-height: 42px; padding: 9px 11px; border: 1px solid var(--border-light); border-radius: 9px; background: var(--bg-primary); color: var(--text-primary); font: inherit; outline: none; }
.account-form input:focus { border-color: var(--primary); }
.account-submit, .account-danger { min-height: 40px; padding: 8px 13px; border-radius: 9px; font: inherit; font-size: 12px; font-weight: 700; cursor: pointer; }
.account-submit { border: 1px solid var(--ink); background: var(--ink); color: #fff; }
.account-submit:disabled, .account-secondary:disabled, .account-danger:disabled { opacity: .5; cursor: not-allowed; }
.account-secondary { border: 1px solid var(--border-light); background: var(--bg-primary); color: var(--text-primary); }
.account-secondary:hover:not(:disabled) { border-color: var(--primary); color: var(--primary); }
.account-danger { border: 1px solid rgba(239,68,68,.25); background: rgba(239,68,68,.06); color: var(--error, #dc2626); }
.account-error, .account-warning, .account-note { margin: 10px 0 0; font-size: 12px; line-height: 1.6; }
.account-error { color: var(--error, #dc2626); }
.account-note { color: var(--text-secondary); }
@media (max-width: 520px) { .account-modal { padding: 19px; } .account-menu { top: 58px; right: 12px; } }
</style>
