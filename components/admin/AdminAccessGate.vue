<template>
  <section class="admin-access-gate" :aria-busy="checking">
    <div v-if="checking" class="admin-access-card admin-access-loading" aria-live="polite">
      <span class="admin-access-icon"><span class="admin-access-spinner"></span></span>
      <p>正在验证管理员会话…</p>
    </div>
    <form v-else class="admin-access-card" @submit.prevent="submit">
      <NuxtLink to="/" class="admin-access-brand">
        <span class="admin-access-brand-icon"><ConsoleIcon name="box" :size="21" /></span>
        <strong>PanHub</strong><small>CONSOLE</small>
      </NuxtLink>
      <span class="admin-access-icon"><ConsoleIcon name="lock" :size="25" /></span>
      <div class="admin-access-copy">
        <span>RESTRICTED WORKSPACE</span>
        <h1>{{ title }}</h1>
        <p v-if="configured">{{ description }}</p>
        <p v-else>
          当前服务尚未配置管理员凭据。请先在部署环境设置
          <code>ADMIN_PASSWORD</code>，然后重新加载页面。
        </p>
      </div>
      <template v-if="configured">
        <label for="shared-admin-password">管理员密码</label>
        <span class="admin-access-input">
          <ConsoleIcon name="key" :size="17" />
          <input
            id="shared-admin-password"
            ref="passwordInput"
            v-model="password"
            type="password"
            autocomplete="current-password"
            placeholder="输入管理员密码"
            :disabled="busy || !ready"
            @input="$emit('clear-error')"
          />
        </span>
        <p v-if="error" class="admin-access-error" role="alert">
          <ConsoleIcon name="info" :size="15" />{{ error }}
        </p>
        <button
          class="admin-access-submit"
          type="submit"
          :disabled="!ready || busy || !password.trim()"
        >
          <span v-if="busy" class="admin-access-spinner light"></span>
          <ConsoleIcon v-else name="unlock" :size="17" />
          {{ busy ? "正在验证…" : "进入管理控制台" }}
        </button>
      </template>
      <div class="admin-access-security">
        <ConsoleIcon name="shield" :size="15" />
        HttpOnly Cookie · SameSite=Strict · 同源校验 · 登录限流
      </div>
      <NuxtLink to="/" class="admin-access-back">
        <ConsoleIcon name="back" :size="15" />返回搜索首页
      </NuxtLink>
    </form>
  </section>
</template>

<script setup lang="ts">
import ConsoleIcon from "../upstreams/ConsoleIcon.vue";

const props = withDefaults(
  defineProps<{
    checking?: boolean;
    configured?: boolean;
    busy?: boolean;
    ready?: boolean;
    error?: string;
    title?: string;
    description?: string;
  }>(),
  {
    checking: false,
    configured: true,
    busy: false,
    ready: false,
    error: "",
    title: "管理员身份验证",
    description: "管理配置和诊断数据属于敏感运维信息。验证成功后会建立 8 小时的独立管理会话。",
  },
);

const emit = defineEmits<{
  submit: [password: string];
  "clear-error": [];
}>();
const password = ref("");
const passwordInput = ref<HTMLInputElement | null>(null);

function submit() {
  const value = password.value;
  if (!props.ready || props.busy || !value.trim()) return;
  emit("submit", value);
  password.value = "";
}

watch(
  () => [props.checking, props.configured, props.ready],
  async ([checking, configured, ready]) => {
    if (!checking && configured && ready) {
      await nextTick(() => passwordInput.value?.focus());
    }
  },
  { immediate: true },
);
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
.admin-access-card > label {
  display: block;
  margin-bottom: 8px;
  color: #374151;
  font-size: 11px;
  font-weight: 650;
}
.admin-access-input {
  height: 46px;
  box-sizing: border-box;
  padding: 0 13px;
  display: flex;
  align-items: center;
  gap: 10px;
  color: #6b7280;
  border: 1px solid #d1d5db;
  border-radius: 9px;
  background: #fff;
  transition: border-color 150ms, box-shadow 150ms;
}
.admin-access-input:focus-within {
  border-color: #60a5fa;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
}
.admin-access-input input {
  min-width: 0;
  height: 100%;
  flex: 1;
  border: 0;
  outline: 0;
  color: #111827;
  background: transparent;
  font: inherit;
}
.admin-access-submit {
  width: 100%;
  min-height: 46px;
  margin-top: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  border: 1px solid #2563eb;
  border-radius: 8px;
  color: #fff;
  background: #2563eb;
  font: 600 11px inherit;
  cursor: pointer;
}
.admin-access-submit:hover:not(:disabled) { background: #1d4ed8; }
.admin-access-submit:disabled { cursor: not-allowed; opacity: 0.48; }
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
.admin-access-back {
  min-height: 40px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: #6b7280;
  font-size: 11px;
  text-decoration: none;
}
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
.admin-access-spinner.light {
  border-color: rgba(255,255,255,.4);
  border-top-color: #fff;
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
