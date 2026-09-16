<template>
  <div class="account-control">
    <button v-if="!currentUser && auth.showAuthButtons" class="account-trigger" type="button" :disabled="!auth.sessionReady" @click="openLogin">
      <span class="account-avatar">◌</span>
      {{ auth.sessionReady ? (auth.registrationEnabled ? '登录 / 注册' : '登录') : '会话初始化中…' }}
    </button>
    <button v-else-if="currentUser" class="account-trigger account-trigger--signed" type="button" :aria-expanded="openState" @click="toggleAccountMenu">
      <span class="account-avatar">{{ displayName.charAt(0).toUpperCase() }}</span>
      <span>{{ displayName }}</span>
      <span class="account-chevron">⌄</span>
    </button>

    <Teleport to="body">
      <div v-if="openState && currentUser" class="account-menu-layer" @click.self="close">
        <section class="account-menu" role="menu" aria-label="账号操作">
          <div class="account-menu-summary">
            <strong>{{ displayName }}</strong>
            <span>@{{ currentUser.username }}</span>
          </div>
          <button class="account-danger" type="button" :disabled="busy" @click="signOut">退出登录</button>
        </section>
      </div>
      <div v-else-if="openState" class="account-mask" @click.self="close">
        <section class="account-modal" role="dialog" aria-modal="true" aria-labelledby="account-title">
          <header class="account-header">
            <div>
              <p class="account-kicker">PANHUB ACCOUNT</p>
              <h2 id="account-title">{{ mode === 'login' ? '登录 PanHub' : '创建账号' }}</h2>
            </div>
            <button type="button" class="account-close" aria-label="关闭" @click="close">×</button>
          </header>

          <p v-if="auth.sessionError" class="account-error" role="alert">{{ auth.sessionError }}</p>
          <p v-if="auth.error" class="account-error" role="alert">{{ auth.error }}</p>

          <div class="account-tabs" role="tablist" aria-label="账号操作">
            <button type="button" :class="{ active: mode === 'login' }" @click="mode = 'login'; clearError()">登录</button>
            <button v-if="auth.registrationEnabled" type="button" :class="{ active: mode === 'register' }" @click="mode = 'register'; clearError()">注册</button>
          </div>
          <form class="account-form" @submit.prevent="submitAuth">
            <label>用户名<input v-model.trim="username" required minlength="4" maxlength="32" autocomplete="username" placeholder="4-32 位字母、数字或下划线" /></label>
            <label v-if="mode === 'register'">昵称（可选）<input v-model.trim="nickname" maxlength="32" autocomplete="nickname" placeholder="最多 32 个字符" /></label>
            <label>密码<input v-model="password" required minlength="6" maxlength="128" type="password" autocomplete="current-password" placeholder="至少 6 个字符" /></label>
            <button class="account-submit" type="submit" :disabled="busy || !username || password.length < 6">
              {{ busy ? '处理中…' : mode === 'login' ? '登录' : '注册并登录' }}
            </button>
          </form>
          <p class="account-note">账号登录和搜索密码是两套独立验证：登录账号后，仍需按站点配置通过搜索密码验证。</p>
        </section>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";

const auth = useAuth();
const settings = useSettings();
const openState = ref(false);
const mode = ref<"login" | "register">("login");
const busy = ref(false);
const username = ref("");
const nickname = ref("");
const password = ref("");
const currentUser = computed(() => auth.user.value);
const displayName = computed(() => currentUser.value?.nickname || currentUser.value?.username || "用户");

watch(() => auth.showAuthButtons.value, (visible) => {
  if (!visible && !currentUser.value) openState.value = false;
});
watch(() => auth.registrationEnabled.value, (enabled) => {
  if (!enabled) mode.value = "login";
});

function openLogin() {
  mode.value = "login";
  clearForm();
  openState.value = true;
}
function toggleAccountMenu() {
  if (busy.value) return;
  openState.value = !openState.value;
}
function close() { openState.value = false; }
function clearError() { auth.error.value = ""; }
function clearForm() {
  clearError();
  username.value = "";
  password.value = "";
  nickname.value = "";
}
async function submitAuth() {
  if (busy.value) return;
  busy.value = true;
  const result = mode.value === "login"
    ? await auth.login(username.value, password.value)
    : await auth.register(username.value, password.value, nickname.value);
  if (result) {
    await settings.syncWithSession();
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
</script>

<style scoped>
.account-control { display: inline-flex; min-width: 0; }
.account-trigger { display: inline-flex; align-items: center; gap: 7px; min-height: 36px; padding: 6px 11px; border: 1px solid var(--border-light); border-radius: 999px; background: var(--bg-primary); color: var(--text-secondary); font: inherit; font-size: 12px; font-weight: 650; cursor: pointer; transition: border-color .15s, color .15s, background-color .15s; }
.account-trigger:hover:not(:disabled) { border-color: var(--primary); color: var(--text-primary); background: var(--primary-soft); }
.account-trigger:disabled { opacity: .65; cursor: wait; }
.account-trigger--signed { color: var(--text-primary); }
.account-avatar { display: grid; place-items: center; width: 21px; height: 21px; border-radius: 50%; background: var(--primary-soft); color: var(--primary); font-size: 11px; font-weight: 800; }
.account-chevron { font-size: 15px; line-height: 1; }
.account-mask { position: fixed; inset: 0; z-index: 1200; display: grid; place-items: center; padding: 18px; background: rgba(15, 23, 42, .48); backdrop-filter: blur(5px); }
.account-menu-layer { position: fixed; inset: 0; z-index: 1200; }
.account-menu { position: absolute; top: 62px; right: 18px; width: min(220px, calc(100vw - 36px)); padding: 13px; border: 1px solid var(--border-light); border-radius: 12px; background: var(--bg-primary); box-shadow: var(--shadow-xl); }
.account-menu-summary { display: flex; flex-direction: column; gap: 3px; padding: 3px 4px 12px; }
.account-menu-summary strong { color: var(--text-primary); font-size: 13px; }
.account-menu-summary span { color: var(--text-secondary); font-size: 11px; }
.account-menu .account-danger { width: 100%; }
.account-modal { width: min(460px, 100%); max-height: min(720px, calc(100vh - 36px)); overflow-y: auto; padding: 24px; border: 1px solid var(--border-light); border-radius: 18px; background: var(--bg-primary); box-shadow: var(--shadow-xl); color: var(--text-primary); }
.account-header { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
.account-kicker { margin: 0 0 5px; color: var(--primary); font-size: 10px; font-weight: 800; letter-spacing: .14em; }
.account-header h2 { margin: 0; font-size: 22px; }
.account-close { width: 34px; height: 34px; border: 0; border-radius: 8px; background: transparent; color: var(--text-secondary); font-size: 24px; cursor: pointer; }
.account-close:hover { background: var(--bg-secondary); color: var(--text-primary); }
.account-tabs { display: flex; gap: 6px; margin-bottom: 16px; padding: 4px; border-radius: 10px; background: var(--bg-secondary); }
.account-tabs button { flex: 1; padding: 8px; border: 0; border-radius: 7px; background: transparent; color: var(--text-secondary); font: inherit; cursor: pointer; }
.account-tabs button.active { background: var(--bg-primary); color: var(--text-primary); box-shadow: var(--shadow-sm); font-weight: 700; }
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
