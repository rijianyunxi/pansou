<template>
  <section class="admin-access-gate" :aria-busy="checking">
    <div v-if="checking" class="admin-access-card admin-access-loading" aria-live="polite">
      <span class="admin-access-icon"><span class="admin-access-spinner"></span></span>
      <p>正在验证账号权限…</p>
    </div>
    <section v-else class="admin-access-card" aria-labelledby="admin-access-title">
      <NuxtLink to="/" class="admin-access-brand">
        <span class="admin-access-brand-icon"><ConsoleIcon name="box" :size="21" /></span>
        <strong>PanHub</strong><small>CONSOLE</small>
      </NuxtLink>
      <span class="admin-access-icon"><ConsoleIcon :name="authenticated ? 'shield' : 'lock'" :size="25" /></span>
      <div class="admin-access-copy">
        <span>RESTRICTED WORKSPACE</span>
        <h1 id="admin-access-title">{{ title }}</h1>
        <p v-if="error || auth.error.value" class="admin-access-error" role="alert">
          <ConsoleIcon name="info" :size="15" />{{ error || auth.error.value }}
        </p>
        <p v-else-if="authenticated">当前账号没有管理员权限，请使用管理员账号登录后再进入后台。</p>
        <p v-else>请先登录管理员账号。管理员用户名和密码可在进入后台后于“系统设置”中修改。</p>
      </div>
      <form class="admin-access-form" @submit.prevent="submitLogin">
        <label>
          用户名
          <input v-model.trim="username" type="text" autocomplete="username" minlength="4" maxlength="32"
            placeholder="请输入管理员用户名" :disabled="loginBusy" required />
        </label>
        <label>
          密码
          <input v-model="password" type="password" autocomplete="current-password" minlength="6" maxlength="128"
            placeholder="请输入管理员密码" :disabled="loginBusy" required />
        </label>
        <div class="admin-access-actions">
          <button class="admin-access-login-button" type="submit"
            :disabled="loginBusy || !username || password.length < 6">
            <span v-if="loginBusy" class="admin-access-button-spinner" aria-hidden="true"></span>
            {{ loginBusy ? "登录中…" : "登录" }}
          </button>
          <NuxtLink to="/" class="admin-access-home-button">
            <ConsoleIcon name="external" :size="16" />返回首页
          </NuxtLink>
        </div>
      </form>
      <div class="admin-access-security">
        普通账号会话 · 角色权限校验 · 同源校验 · 登录限流
      </div>
    </section>
  </section>
</template>

<script setup lang="ts">
import ConsoleIcon from "../sources/ConsoleIcon.vue";
import { ref } from "vue";

const props = withDefaults(defineProps<{
  checking?: boolean;
  authenticated?: boolean;
  error?: string;
  title?: string;
}>(), {
  checking: false,
  authenticated: false,
  error: "",
  title: "进入管理后台",
});
const { checking, authenticated, error, title } = toRefs(props);
const emit = defineEmits<{ authenticated: [] }>();
const auth = useAuth();
const username = ref("");
const password = ref("");
const loginBusy = ref(false);

async function submitLogin() {
  if (loginBusy.value) return;
  loginBusy.value = true;
  auth.error.value = "";
  const user = await auth.login(username.value, password.value);
  loginBusy.value = false;
  if (user?.role === "admin") {
    password.value = "";
    emit("authenticated");
  }
}
</script>

<style scoped>
.admin-access-gate {
  min-height: 100vh;
  width: 100%;
  display: grid;
  place-items: center;
  padding: 32px 20px;
  color: #111827;
  background: #f6f7f9;
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", "PingFang SC", sans-serif;
}
.admin-access-card {
  box-sizing: border-box;
  width: min(440px, 100%);
  padding: 32px;
  border: 1px solid #e5e7eb;
  border-radius: 16px;
  background: #fff;
  box-shadow: 0 8px 28px rgba(17, 24, 39, 0.08);
}
.admin-access-loading {
  min-height: 150px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  color: #6b7280;
  font-size: 13px;
}
.admin-access-brand {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 34px;
  color: inherit;
  text-decoration: none;
}
.admin-access-brand-icon {
  width: 33px;
  height: 35px;
  display: grid;
  place-items: center;
  border-radius: 9px;
  color: #fff;
  background: #111827;
}
.admin-access-brand strong { font-size: 20px; }
.admin-access-brand small {
  margin-top: 7px;
  color: #8a9690;
  font-size: 8px;
  letter-spacing: 1px;
}
.admin-access-icon {
  width: 52px;
  height: 52px;
  display: grid;
  place-items: center;
  border: 1px solid #dbeafe;
  border-radius: 14px;
  color: #2563eb;
  background: #eff6ff;
}
.admin-access-copy { margin: 18px 0 24px; }
.admin-access-copy > span {
  color: #9ca3af;
  font: 600 9px ui-monospace, SFMono-Regular, Consolas, monospace;
  letter-spacing: 1.8px;
}
.admin-access-copy h1 {
  margin: 5px 0 8px;
  font-size: 25px;
  line-height: 1.35;
}
.admin-access-copy p {
  margin: 0;
  color: #6b7280;
  font-size: 12px;
  line-height: 1.8;
}
.admin-access-copy code {
  padding: 2px 5px;
  border-radius: 4px;
  color: #1d4ed8;
  background: #eff6ff;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}
.admin-access-error {
  margin: 10px 0 0;
  display: flex;
  align-items: flex-start;
  gap: 7px;
  color: #dc2626;
  font-size: 11px;
}
.admin-access-security {
  margin-top: 20px;
  padding: 14px 0;
  display: flex;
  align-items: flex-start;
  gap: 7px;
  border-top: 1px solid #e5e7eb;
  color: #6b7280;
  font-size: 9px;
}
.admin-access-form { display: grid; gap: 13px; margin-top: 8px; }
.admin-access-form label { display: grid; gap: 6px; color: #4b5563; font-size: 12px; font-weight: 650; }
.admin-access-form input {
  box-sizing: border-box;
  width: 100%;
  min-height: 44px;
  padding: 10px 12px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  color: #111827;
  background: #fff;
  font: inherit;
  outline: none;
  transition: border-color .15s ease, box-shadow .15s ease;
}
.admin-access-form input::placeholder { color: #9ca3af; }
.admin-access-form input:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37, 99, 235, .12); }
.admin-access-form input:disabled { cursor: wait; opacity: .7; }
.admin-access-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 4px; }
.admin-access-login-button, .admin-access-home-button {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  border-radius: 8px;
  font: 600 12px inherit;
  text-decoration: none;
  cursor: pointer;
}
.admin-access-login-button { border: 1px solid #2563eb; color: #fff; background: #2563eb; }
.admin-access-login-button:hover:not(:disabled) { background: #1d4ed8; }
.admin-access-login-button:disabled { opacity: .55; cursor: not-allowed; }
.admin-access-home-button { border: 1px solid #d1d5db; color: #374151; background: #fff; }
.admin-access-home-button:hover { border-color: #2563eb; color: #1d4ed8; background: #eff6ff; }
.admin-access-button-spinner { width: 13px; height: 13px; box-sizing: border-box; border: 2px solid rgba(255,255,255,.45); border-top-color: #fff; border-radius: 50%; animation: admin-spin .8s linear infinite; }
.admin-access-card :focus-visible {
  outline: 3px solid #93c5fd;
  outline-offset: 3px;
}
.admin-access-spinner {
  width: 16px;
  height: 16px;
  box-sizing: border-box;
  border: 2px solid #93c5fd;
  border-top-color: #2563eb;
  border-radius: 50%;
  animation: admin-spin 0.8s linear infinite;
}
@keyframes admin-spin { to { transform: rotate(360deg); } }
@media (max-width: 520px) {
  .admin-access-gate { padding: 18px 14px; }
  .admin-access-card { padding: 24px 20px; }
}
@media (prefers-reduced-motion: reduce) {
  .admin-access-spinner { animation-duration: 1.6s; }
}
</style>
