<template>
  <section class="search">
    <div class="search-container">
      <div class="search-box" :class="{ focused: isFocused, loading: loading }">
        <!-- 输入行 -->
        <div class="search-row">
          <div class="search-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8"></circle>
              <path d="m21 21-4.35-4.35"></path>
            </svg>
          </div>

          <input
            ref="inputEl"
            :disabled="!ready"
            :value="modelValue"
            :placeholder="placeholder"
            name="kw"
            maxlength="100"
            aria-label="搜索关键词"
            :aria-describedby="disabledDescriptionId"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            spellcheck="false"
            class="search-input"
            @input="
              $emit('update:modelValue', ($event.target as HTMLInputElement).value)
            "
            @focus="isFocused = true"
            @blur="isFocused = false"
            @keyup.enter="handleSearch" />

          <!-- 清空按钮 - 输入中显示 -->
          <button
            v-if="modelValue && !loading"
            class="clear-btn"
            type="button"
            @click="
              $emit('update:modelValue', '');
              $emit('reset');
            "
            aria-label="清空关键词"
            title="清空">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <!-- 操作行：左侧状态药丸 + 右侧主按钮 -->
        <div class="search-actions">
          <div class="actions-left">
            <!-- 重置按钮 - 搜索后显示 -->
            <button
              v-if="searched"
              class="action-btn reset"
              type="button"
              @click="
                $emit('update:modelValue', '');
                $emit('reset');
              "
              aria-label="重置搜索"
              title="重置搜索">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
                <path d="M3 3v5h5"></path>
              </svg>
              <span class="btn-text">重置</span>
            </button>

            <!-- 暂停按钮 -->
            <button
              v-if="loading && !paused"
              class="action-btn pause"
              type="button"
              @click="$emit('pause')"
              aria-label="暂停搜索"
              title="暂停搜索">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="6" y="4" width="4" height="16" rx="1"></rect>
                <rect x="14" y="4" width="4" height="16" rx="1"></rect>
              </svg>
              <span class="btn-text">暂停</span>
            </button>

            <!-- 继续按钮 -->
            <button
              v-if="paused"
              class="action-btn resume"
              type="button"
              @click="$emit('continue')"
              aria-label="继续搜索"
              title="继续搜索">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M5 3l14 9-14 9V3z"></path>
              </svg>
              <span class="btn-text">继续</span>
            </button>

            <!-- 加载动画 -->
            <div v-if="loading && !paused" class="loading-spinner"></div>

            <!-- 暂停状态提示 -->
            <div v-if="paused" class="paused-indicator" title="搜索已暂停">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="12" r="10" opacity="0.2"></circle>
                <rect x="8" y="8" width="8" height="8" rx="1"></rect>
              </svg>
            </div>
          </div>

          <!-- 搜索按钮 -->
          <button
            v-if="!loading && !paused"
            class="action-btn primary"
            type="button"
            :disabled="!ready || searchDisabled || !modelValue.trim()"
            :aria-describedby="disabledDescriptionId"
            aria-label="开始搜索"
            @click="handleSearch">
            <span class="btn-text">搜索</span>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <path d="M5 12h14M12 5l7 7-7 7"></path>
            </svg>
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { nextTick, onMounted, ref } from "vue";

const props = defineProps<{
  modelValue: string;
  loading: boolean;
  paused: boolean;
  placeholder: string;
  searched: boolean;
  searchDisabled?: boolean;
  disabledDescriptionId?: string;
}>();
const emit = defineEmits(["update:modelValue", "search", "reset", "pause", "continue"]);

const ready = ref(false);
const isFocused = ref(false);
const inputEl = ref<HTMLInputElement | null>(null);

// 处理搜索按钮点击
function handleSearch() {
  if (!ready.value || props.searchDisabled || props.loading || props.paused || !props.modelValue.trim()) return;
  // iOS Safari兼容性：确保输入框失去焦点
  if (
    typeof window !== "undefined" &&
    document.activeElement instanceof HTMLInputElement
  ) {
    document.activeElement.blur();
  }

  emit("search");
}

onMounted(async () => {
  ready.value = true;
  await nextTick();
  // 仅在桌面端自动聚焦，避免移动端抢焦点和键盘闪烁
  if (window.matchMedia("(pointer: fine)").matches && document.activeElement === document.body) {
    inputEl.value?.focus();
  }
});
</script>

<style scoped>

.search, .search-container { width: 100%; }
.search-box { display: flex; align-items: center; gap: 8px; padding: 6px; border: 1px solid var(--border-medium); border-radius: 12px; background: var(--bg-primary); transition: border-color .2s, box-shadow .2s; }
.search-box.focused { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.search-row { display: flex; align-items: center; gap: 13px; flex: 1; min-width: 0; padding-left: 14px; }
.search-icon { display: flex; color: var(--text-secondary); flex-shrink: 0; }
.search-input { width: 100%; min-width: 0; height: 46px; border: 0; outline: 0; background: transparent; font: inherit; font-size: 16px; color: var(--text-primary); }
.search-input::placeholder { color: var(--text-tertiary); font-size: 14px; }
.clear-btn { display: grid; place-items: center; flex-shrink: 0; width: 30px; height: 30px; border: 0; border-radius: 50%; background: transparent; color: var(--text-tertiary); cursor: pointer; }
.clear-btn:hover { background: var(--bg-secondary); }
.search-actions, .actions-left { display: flex; align-items: center; gap: 8px; }
.search-actions { flex-direction: row-reverse; }
.actions-left:empty { display: none; }
.action-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 46px; padding: 0 16px; border: 1px solid var(--border-light); border-radius: 8px; background: var(--bg-primary); color: var(--text-secondary); font-size: 13px; font-weight: 600; white-space: nowrap; cursor: pointer; }
.action-btn.primary { min-width: 120px; border-color: transparent; background: #ff5b18; color: #fff; font-size: 16px; }
.action-btn.primary svg { transform: rotate(-45deg); }
.action-btn:hover:not(:disabled) { border-color: var(--primary); color: var(--primary); background: var(--primary-soft); }
.action-btn.primary:hover:not(:disabled) { color: #fff; background: #e84c0c; }
.action-btn:disabled { opacity: .48; cursor: not-allowed; }
.action-btn:focus-visible, .clear-btn:focus-visible { outline: 2px solid var(--primary); outline-offset: 3px; }
.action-btn.pause { color: #aa6817; background: #fff8e9; }
.action-btn.resume { color: #28815d; background: #f0faf4; }
.loading-spinner { width: 18px; height: 18px; border: 2px solid var(--border-light); border-top-color: var(--primary); border-radius: 50%; animation: spin .8s linear infinite; }
.paused-indicator { color: #aa6817; display: flex; }
@keyframes spin { to { transform: rotate(360deg); } }
@media(max-width:640px) { .search-row { padding-left: 6px; gap: 8px; } .search-input { font-size: 16px; } .search-input::placeholder { font-size: 12px; } .action-btn.primary { min-width: 72px; padding: 0 12px; font-size: 14px; } .action-btn:not(.primary) { width: 36px; padding: 0; } .action-btn:not(.primary) .btn-text { display: none; } .search-icon { display: none; } .search-actions, .actions-left { gap: 4px; } .loading-spinner, .paused-indicator { display: none; } }
@media(prefers-reduced-motion:reduce) { .loading-spinner { animation: none; } .search-box { transition: none; } }

</style>
