<template>
  <div
    v-if="open"
    class="drawer-mask"
    @click.self="closeDrawer">
    <div ref="drawerEl" class="drawer" role="dialog" aria-modal="true" aria-label="自定义频道">
      <header class="drawer__header">
        <div>
          <strong>自定义频道</strong>
          <p class="header-subtitle">管理已添加的公开频道 · 在首页选择搜索范围</p>
        </div>
        <button
          class="btn btn--close"
          type="button"
          aria-label="关闭设置"
          @click="closeDrawer">
          关闭
        </button>
      </header>

      <div class="drawer-body">
        <section class="drawer__section">
          <div class="section__title">
            <strong>已添加的公开频道</strong>
            <span class="tiny-hint">{{ inner.userTgChannels.length }}/{{ channelLimit }}</span>
          </div>
          <p class="hint">
            添加公开频道用户名或链接。本站搜索不会使用这些频道；选择首页「自定义频道」后，只搜索这里的频道。
            <template v-if="auth.user">当前已同步到账号，可在其他设备继续使用。</template>
            <template v-else-if="isServerManaged">当前已保存到本次匿名会话，仅本浏览器可用，不会同步到账号。</template>
            <template v-else>自定义频道需要在微信小程序中登录后使用，或由管理员开启「允许匿名用户使用自定义频道」。</template>
          </p>

          <p v-if="storageError" class="feedback feedback--error" role="alert">{{ storageError }}</p>
          <form class="channel-add" @submit.prevent="addChannel">
            <input
              ref="channelInput"
              v-model="newChannel"
              :disabled="checking"
              @input="channelError = ''; channelStatus = ''"
              :aria-invalid="!!channelError"
              :aria-busy="checking"
              aria-describedby="channel-help"
              class="input"
              type="text"
              placeholder="@频道名 或 t.me/s/频道名"
              aria-label="频道用户名"
              autocomplete="off"
              spellcheck="false" />
            <button class="btn btn--primary" type="submit" :disabled="!newChannel.trim() || checking">
              {{ checking ? "验证中…" : "添加频道" }}
            </button>
          </form>
          <p id="channel-help" class="tiny-hint">支持 @name、t.me/s/name 和公开消息链接。输入 t.me/name 会自动转换为 t.me/s/name 进行公开页验证；私密邀请链接、失效或不可访问的频道不会保存。</p>
          <p v-if="channelError" class="feedback feedback--error" role="alert">{{ channelError }}</p>
          <p v-else-if="channelStatus" class="feedback" role="status">{{ channelStatus }}</p>
          <p v-else-if="newChannel.trim()" class="hint">尚未添加，请点击「添加」或按 Enter。</p>

          <ul v-if="inner.userTgChannels.length" class="channel-list">
            <li v-for="name in inner.userTgChannels" :key="name" class="channel-item">
              <span class="channel-avatar">{{ name.charAt(0).toUpperCase() }}</span>
              <span class="channel-name">@{{ name }}<small>已加入搜索列表</small></span>
              <button
                class="channel-remove"
                type="button"
                :aria-label="`移除频道 ${name}`"
                title="移除"
                @click="removeChannel(name)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </li>
          </ul>
          <p v-else class="hint empty-hint">还没有添加公开频道。添加后，在首页选择「自定义频道」即可搜索。</p>
        </section>
      </div>

          <footer class="drawer__footer">
        <button class="btn btn--subtle" type="button" @click="$emit('reset-default')">清空频道列表</button>
      </footer>
    </div>
  </div>
</template>

<script setup lang="ts">
import { parseTelegramChannelInput } from "../utils/telegramChannelInput";
import type { UserSettings } from "~/composables/useSettings";

const props = defineProps<{
  modelValue: UserSettings;
  open: boolean;
  storageError?: string;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: UserSettings): void;
  (e: "update:open", value: boolean): void;
  (e: "reset-default"): void;
}>();

const inner = computed(() => props.modelValue);
const auth = useAuth();
const { channelLimit, isServerManaged, saveChannels } = useSettings();
const newChannel = ref("");
const channelError = ref("");
const channelStatus = ref("");
const checking = ref(false);
const channelInput = ref<HTMLInputElement | null>(null);
const drawerEl = ref<HTMLElement | null>(null);
let previousFocus: HTMLElement | null = null;
let previousOverflow = "";
watch(() => props.open, async (open) => {
  if (open) {
    previousFocus = document.activeElement as HTMLElement;
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    await nextTick();
    channelInput.value?.focus();
  } else {
    document.body.style.overflow = previousOverflow;
    await nextTick();
    previousFocus?.focus();
  }
});
onMounted(() => document.addEventListener("keydown", handleKeydown));
onBeforeUnmount(() => {
  document.removeEventListener("keydown", handleKeydown);
  if (props.open) document.body.style.overflow = previousOverflow;
});
function closeDrawer() { emit("update:open", false); }
function handleKeydown(event: KeyboardEvent) {
  if (!props.open) return;
  if (event.key === "Escape") { event.preventDefault(); closeDrawer(); }
  if (event.key !== "Tab") return;
  const elements = drawerEl.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href]');
  if (!elements?.length) return;
  const first = elements[0];
  const last = elements[elements.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}

async function addChannel() {
  const name = parseTelegramChannelInput(newChannel.value);
  channelStatus.value = "";
  channelError.value = "";
  if (!name) {
    channelError.value = "请输入公开频道用户名或链接，例如 @channel_name 或 t.me/s/channel_name；不支持私密邀请链接。";
    return;
  }
  if (inner.value.userTgChannels.includes(name)) {
    channelStatus.value = `@${name} 已在列表中，无需重复添加。`;
    newChannel.value = "";
    return;
  }
  if (inner.value.userTgChannels.length >= channelLimit.value) {
    channelError.value = `当前账号最多可添加 ${channelLimit.value} 个公开频道。`;
    return;
  }

  checking.value = true;
  try {
    const validation = await $fetch<{ ok: boolean; message?: string }>("/api/account/channels/validate", {
      method: "POST",
      body: { channel: name },
      credentials: "include",
      retry: 0,
    });
    if (!validation.ok) {
      channelError.value = validation.message || "该频道不可用或不是公开频道，未添加。";
      return;
    }
    const nextChannels = [...inner.value.userTgChannels, name];
    emit("update:modelValue", { ...inner.value, userTgChannels: nextChannels });
    const saved = await saveChannels(nextChannels);
    if (!saved) {
      channelError.value = "频道已在当前页面加入，但服务端保存失败；请稍后重试。";
      return;
    }
    newChannel.value = "";
    channelStatus.value = auth.user.value
      ? `已验证 @${name}，已保存到账号。`
      : `已验证 @${name}，已保存到本次匿名会话。`;
    await nextTick();
    channelInput.value?.focus();
  } catch (reason: any) {
    channelError.value = reason?.data?.statusMessage || reason?.message || "频道验证失败，未添加。请稍后重试。";
  } finally {
    checking.value = false;
  }
}

async function removeChannel(name: string) {
  const nextChannels = inner.value.userTgChannels.filter((c) => c !== name);
  emit("update:modelValue", { ...inner.value, userTgChannels: nextChannels });
  const saved = await saveChannels(nextChannels);
  channelStatus.value = saved ? `已移除 @${name}。` : "频道已从当前页面移除，但服务端保存失败，请稍后重试。";
  await nextTick();
  channelInput.value?.focus();
}
</script>

<style scoped>
.feedback { margin: 0; padding: 10px 12px; border-radius: 8px; background: var(--primary-soft); color: var(--text-primary); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.feedback--error { color: var(--text-primary); border-left: 3px solid #dc2626; background: var(--bg-secondary); }
.channel-name { overflow-wrap: anywhere; }
.channel-name small { display: block; color: var(--text-secondary); font-size: 11px; font-weight: 400; margin-top: 3px; }
button:focus-visible, a:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.drawer-mask {
  position: fixed;
  inset: 0;
  z-index: 900;
  background: rgba(17, 24, 39, 0.4);
  backdrop-filter: blur(3px);
  display: flex;
  justify-content: flex-end;
  animation: mask-in 0.2s ease;
}

@keyframes mask-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

.drawer {
  width: min(420px, 100vw);
  height: 100%;
  background: var(--bg-primary);
  display: flex;
  flex-direction: column;
  padding: 20px;
  animation: drawer-in 0.25s ease;
  overflow: hidden;
}

@keyframes drawer-in {
  from { transform: translateX(24px); opacity: 0.6; }
  to { transform: translateX(0); opacity: 1; }
}

.drawer__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border-light);
}

.drawer__header strong {
  font-size: 17px;
  font-weight: 700;
  color: var(--text-primary);
}

.header-subtitle {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--text-secondary);
}

.btn {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 9px 14px;
  border-radius: 10px;
  border: 1px solid var(--border-light);
  background: var(--bg-primary);
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  transition: background-color var(--transition-fast), color var(--transition-fast),
    border-color var(--transition-fast);
}

.btn:hover:not(:disabled) {
  color: var(--text-primary);
  background: var(--bg-secondary);
}

.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.btn--close {
  padding: 7px 12px;
}

.btn--primary {
  background: var(--ink);
  border-color: var(--ink);
  color: #fff;
  font-weight: 600;
}

.btn--primary:hover:not(:disabled) {
  background: var(--ink-hover);
  border-color: var(--ink-hover);
  color: #fff;
}

.btn--subtle {
  border-color: transparent;
  color: var(--text-secondary);
}

.drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: 18px 2px;
}

.drawer__section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.section__title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.section__title strong {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.import-hint {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--primary-soft);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
}

.inline-action {
  margin-left: 4px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--primary);
  font: inherit;
  font-weight: 650;
  cursor: pointer;
}

.inline-action:disabled { opacity: 0.55; cursor: wait; }

.tiny-hint {
  font-size: 12px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-secondary);
}

.empty-hint {
  padding: 12px 0;
}

.channel-add {
  display: flex;
  gap: 8px;
}

.input {
  min-height: 44px;
  box-sizing: border-box;
  flex: 1;
  min-width: 0;
  padding: 10px 12px;
  font-size: 13px;
  border: 1px solid var(--border-light);
  border-radius: 10px;
  background: var(--bg-primary);
  color: var(--text-primary);
  outline: none;
  transition: border-color var(--transition-fast);
}

.input:focus {
  border-color: var(--primary);
}

.input::placeholder {
  color: var(--text-secondary);
}

.channel-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.channel-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--border-light);
  border-radius: 10px;
  background: var(--bg-primary);
}

.channel-avatar {
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: 8px;
  background: var(--primary-soft);
  color: var(--primary);
  font-size: 12px;
  font-weight: 600;
}

.channel-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.channel-remove {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  transition: background-color var(--transition-fast), color var(--transition-fast);
}

.channel-remove:hover {
  background: rgba(239, 68, 68, 0.08);
  color: var(--error);
}

.drawer__footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding-top: 14px;
  border-top: 1px solid var(--border-light);
}

@media (max-width: 640px) {
  .drawer {
    width: 100vw;
    padding: 14px;
  }
}

@media (prefers-color-scheme: dark) {
  .drawer-mask {
    background: rgba(0, 0, 0, 0.55);
  }

  .btn--primary {
    color: #0f1218;
  }

  .btn--primary:hover:not(:disabled) {
    color: #0f1218;
  }
}
@media (prefers-reduced-motion: reduce) { .drawer, .drawer-mask { animation: none; } }
</style>
