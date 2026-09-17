<template>
  <Teleport to="body">
    <div class="qr-layer" :class="`account-theme-${settings.settings.value.theme}`" @click.self="emit('close')">
      <section class="qr-card" role="dialog" aria-modal="true" aria-labelledby="qr-login-title">
        <header class="qr-header">
          <div>
            <p class="qr-kicker">PANHUB ACCOUNT</p>
            <h2 id="qr-login-title">微信扫码登录</h2>
          </div>
          <button type="button" class="qr-close" aria-label="关闭" @click="emit('close')">×</button>
        </header>

        <p class="qr-hint">使用微信扫描下方小程序码，并在小程序中点击「确认登录」。</p>

        <div class="qr-frame">
          <img v-if="qrImage && !expired" class="qr-image" :src="qrImage" alt="微信小程序登录码" width="240" height="240" />
          <span v-else-if="loading" class="qr-spinner" aria-hidden="true"></span>
          <div v-else class="qr-stale">
            <p>{{ error ? "二维码获取失败" : "二维码已失效" }}</p>
            <button type="button" class="qr-refresh" :disabled="loading" @click="start">重新获取二维码</button>
          </div>
        </div>

        <p v-if="error" class="qr-error" role="alert">{{ error }}</p>
        <p v-else-if="expiresText" class="qr-countdown">{{ expiresText }}</p>
        <p class="qr-note">首次扫码会自动创建账号，账号数据与小程序端共用。</p>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { AuthUser } from "../composables/useAuth";

/**
 * Website sign-in panel.
 *
 * The browser only ever talks to this app: it asks for a ticket, renders the
 * mini-program code that carries it, and polls until the mini program confirms
 * it. Nothing here resolves an account — the confirmation endpoint does that,
 * and this panel just re-reads the session once the server says it is ready.
 */

const emit = defineEmits<{ close: []; authenticated: [user: AuthUser] }>();
const auth = useAuth();
const settings = useSettings();

/** Slower than the code's three-minute life, fast enough to feel immediate. */
const POLL_INTERVAL_MS = 1800;

const qrImage = ref("");
const ticket = ref("");
const expiresAt = ref(0);
const loading = ref(false);
const error = ref("");
const expired = ref(false);
const clock = ref(Date.now());

let pollTimer: ReturnType<typeof setInterval> | undefined;
let clockTimer: ReturnType<typeof setInterval> | undefined;
let closed = false;

const expiresText = computed(() => {
  if (!expiresAt.value || expired.value) return "";
  const left = Math.ceil((expiresAt.value - clock.value) / 1000);
  return left > 0 ? `二维码 ${left} 秒后失效` : "";
});

function loginErrorMessage(value: any): string {
  const status = value?.statusCode || value?.response?.status;
  if (status === 503) return "服务端尚未配置微信小程序登录参数，请联系管理员。";
  if (status === 403) return value?.data?.statusMessage || "登录入口已关闭。";
  if (status === 429) return "操作过于频繁，请稍后再试。";
  return value?.data?.statusMessage || value?.message || "二维码获取失败，请稍后重试。";
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

async function start() {
  if (loading.value) return;
  loading.value = true;
  error.value = "";
  expired.value = false;
  qrImage.value = "";
  stopPolling();
  try {
    const data = await $fetch<{ ticket: string; qrImage: string; expiresAt: number }>(
      "/api/account/wechat/qr/start",
      { method: "POST", credentials: "include", retry: 0 },
    );
    if (closed) return;
    ticket.value = data.ticket;
    qrImage.value = data.qrImage;
    expiresAt.value = data.expiresAt;
    clock.value = Date.now();
    pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
  } catch (e: any) {
    expired.value = true;
    error.value = loginErrorMessage(e);
  } finally {
    loading.value = false;
  }
}

async function poll() {
  if (closed || !ticket.value) return;
  try {
    const data = await $fetch<{ status: string }>("/api/account/wechat/qr/poll", {
      query: { ticket: ticket.value }, credentials: "include", cache: "no-store", retry: 0,
    });
    if (data.status === "confirmed") {
      await complete();
      return;
    }
    if (data.status === "expired") {
      stopPolling();
      expired.value = true;
    }
  } catch (e: any) {
    // A dropped poll is not a failed sign-in — only a hard refusal is final.
    const status = e?.statusCode || e?.response?.status;
    if (status === 403 || status === 429) {
      stopPolling();
      expired.value = true;
      error.value = loginErrorMessage(e);
    }
  }
}

/**
 * Read the session back rather than trusting the poll payload: the cookie set
 * by the confirmation is the authority, and another tab that consumed the same
 * code shares this cookie jar.
 */
async function complete() {
  stopPolling();
  await auth.initializeSession(true);
  const account = auth.user.value;
  if (!account) {
    expired.value = true;
    error.value = auth.sessionError.value || "登录状态确认失败，请重试。";
    return;
  }
  await settings.syncWithSession();
  emit("authenticated", account);
  emit("close");
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") emit("close");
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  clockTimer = setInterval(() => { clock.value = Date.now(); }, 1000);
  void start();
});

onBeforeUnmount(() => {
  closed = true;
  stopPolling();
  if (clockTimer) clearInterval(clockTimer);
  window.removeEventListener("keydown", onKeydown);
});
</script>

<style scoped>
.qr-layer { position: fixed; inset: 0; z-index: 1200; display: grid; place-items: center; padding: 18px; overflow-y: auto; overscroll-behavior: contain; background: rgba(15, 23, 42, .48); backdrop-filter: blur(5px); }
.qr-card { width: min(400px, 100%); padding: 24px; border: 1px solid var(--border-light); border-radius: 18px; background: var(--bg-primary); box-shadow: var(--shadow-xl); color: var(--text-primary); text-align: center; }
.qr-header { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 14px; text-align: left; }
.qr-kicker { margin: 0 0 5px; color: var(--primary); font-size: 10px; font-weight: 800; letter-spacing: .14em; }
.qr-header h2 { margin: 0; font-size: 21px; }
.qr-close { width: 34px; height: 34px; border: 0; border-radius: 8px; background: transparent; color: var(--text-secondary); font-size: 24px; line-height: 1; cursor: pointer; }
.qr-close:hover { background: var(--bg-secondary); color: var(--text-primary); }
.qr-hint { margin: 0 0 16px; color: var(--text-secondary); font-size: 12px; line-height: 1.7; text-align: left; }
.qr-frame { position: relative; display: grid; place-items: center; width: 240px; height: 240px; margin: 0 auto; padding: 10px; border: 1px solid var(--border-light); border-radius: 14px; background: #fff; }
.qr-image { display: block; width: 100%; height: 100%; object-fit: contain; }
.qr-stale { display: grid; place-items: center; gap: 10px; color: var(--text-secondary); font-size: 12px; }
.qr-stale p { margin: 0; }
.qr-refresh { min-height: 38px; padding: 8px 14px; border: 1px solid var(--ink); border-radius: 9px; background: var(--ink); color: #fff; font: inherit; font-size: 12px; font-weight: 700; cursor: pointer; }
.qr-refresh:disabled { opacity: .55; cursor: wait; }
.qr-spinner { width: 26px; height: 26px; box-sizing: border-box; border: 2px solid var(--border-light); border-top-color: var(--primary); border-radius: 50%; animation: qr-spin .8s linear infinite; }
.qr-error, .qr-countdown, .qr-note { margin: 12px 0 0; font-size: 12px; line-height: 1.6; }
.qr-error { color: var(--error, #dc2626); }
.qr-countdown { color: var(--text-secondary); }
.qr-note { color: var(--text-tertiary); }
.qr-close:focus-visible, .qr-refresh:focus-visible { outline: 2px solid var(--primary); outline-offset: 3px; }
@keyframes qr-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .qr-spinner { animation-duration: 1.6s; }
}
@media (max-width: 520px) {
  .qr-card { padding: 19px; }
}
</style>
