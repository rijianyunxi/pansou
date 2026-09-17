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
  if (!ready.value || props.searchDisabled || props.loading || !props.modelValue.trim()) return;
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
.search {
  width: 100%;
}

.search-container {
  width: 100%;
}

/* 搜索卡片：白色大圆角 + 细边框 + 轻阴影 */
.search-box {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px 20px 14px;
  background: var(--bg-primary);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-md);
  transition: border-color var(--transition-normal), box-shadow var(--transition-normal);
}

.search-box.focused {
  border-color: var(--border-medium);
  box-shadow: var(--shadow-lg);
}

.search-box.loading {
  border-color: rgba(37, 99, 235, 0.4);
}

/* 输入行 */
.search-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* 搜索图标 */
.search-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
  transition: color var(--transition-fast);
  flex-shrink: 0;
}

.search-box.focused .search-icon {
  color: var(--text-secondary);
}

.search-icon svg {
  stroke: currentColor;
}

/* 搜索输入框 */
.search-input {
  flex: 1;
  border: none;
  background: transparent;
  outline: none;
  font-size: 17px;
  font-weight: 400;
  color: var(--text-primary);
  min-width: 0; /* 允许收缩 */

  /* iOS Safari兼容性 */
  -webkit-appearance: none;
  -webkit-border-radius: 0;
  border-radius: 0;
  -webkit-text-size-adjust: 100%;
  -webkit-tap-highlight-color: transparent;
}

.search-input::placeholder {
  color: var(--text-tertiary);
  font-weight: 400;
}

/* 清空按钮 */
.clear-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  background: transparent;
  border-radius: 50%;
  color: var(--text-tertiary);
  flex-shrink: 0;
  transition: background-color var(--transition-fast), color var(--transition-fast);
}

.clear-btn:hover {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.clear-btn svg {
  stroke: currentColor;
}

/* 操作行 */
.search-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.actions-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-height: 40px;
}

/* 通用按钮样式 */
.action-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 14px;
  border: 1px solid transparent;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color var(--transition-fast), color var(--transition-fast),
    border-color var(--transition-fast), box-shadow var(--transition-fast);
  white-space: nowrap;

  /* iOS Safari兼容性 */
  -webkit-appearance: none;
  -webkit-tap-highlight-color: transparent;
  -webkit-user-select: none;
  user-select: none;
}

.action-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  pointer-events: none;
}

/* 主按钮：黑色药丸 */
.action-btn.primary {
  background: var(--ink);
  color: #ffffff;
  padding: 10px 20px;
  font-size: 14px;
}

.action-btn.primary:disabled {
  background: var(--bg-secondary);
  color: var(--text-tertiary);
  border-color: var(--border-light);
  opacity: 1;
}

.action-btn.primary:hover:not(:disabled) {
  background: var(--ink-hover);
}

.action-btn.primary svg {
  stroke: currentColor;
}

/* 重置按钮 - 中性浅灰药丸 */
.action-btn.reset {
  background: var(--bg-secondary);
  border-color: var(--border-light);
  color: var(--text-secondary);
}

.action-btn.reset:hover {
  background: var(--border-light);
  color: var(--text-primary);
}

/* 暂停按钮 - 浅琥珀药丸 */
.action-btn.pause {
  background: rgba(245, 158, 11, 0.1);
  border-color: rgba(245, 158, 11, 0.3);
  color: #b45309;
}

.action-btn.pause:hover {
  background: rgba(245, 158, 11, 0.18);
}

/* 继续按钮 - 浅绿药丸 */
.action-btn.resume {
  background: rgba(16, 185, 129, 0.1);
  border-color: rgba(16, 185, 129, 0.3);
  color: #047857;
}

.action-btn.resume:hover {
  background: rgba(16, 185, 129, 0.18);
}

/* 暂停状态指示器 */
.paused-indicator {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  color: #b45309;
  flex-shrink: 0;
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 0.6; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.1); }
}

/* 按钮图标 */
.action-btn svg {
  display: block;
  stroke: currentColor;
  flex-shrink: 0;
}

.btn-text {
  display: inline-block;
}

/* 加载动画 */
.loading-spinner {
  width: 18px;
  height: 18px;
  border: 2px solid var(--border-light);
  border-top-color: var(--text-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  flex-shrink: 0;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* 移动端优化 */
@media (max-width: 640px) {
  .search-box {
    padding: 14px 14px 12px;
    gap: 10px;
  }

  .search-icon {
    display: none; /* 在移动端隐藏图标，节省空间 */
  }

  .search-input {
    font-size: 15px;
  }

  .action-btn {
    padding: 8px 12px;
    font-size: 13px;
  }

  .action-btn.primary {
    padding: 10px 18px;
  }

  .action-btn.reset .btn-text,
  .action-btn.pause .btn-text,
  .action-btn.resume .btn-text {
    display: none; /* 小屏状态按钮只显示图标 */
  }

  .action-btn.reset,
  .action-btn.pause,
  .action-btn.resume {
    width: 44px;
    height: 44px;
    padding: 0;
    justify-content: center;
    gap: 0;
  }
}

/* 超小屏幕优化 */
@media (max-width: 360px) {
  .search-box {
    padding: 12px 10px 10px;
  }
}

/* 深色模式支持 */
@media (prefers-color-scheme: dark) {
  .action-btn.primary {
    color: #0f1218;
  }

  .action-btn.pause {
    color: #fbbf24;
  }

  .action-btn.resume {
    color: #34d399;
  }

  .paused-indicator {
    color: #fbbf24;
  }
}

/* 高对比度模式支持 */
@media (prefers-contrast: high) {
  .search-box {
    border-width: 2px;
  }

  .action-btn.primary {
    border: 2px solid currentColor;
  }
}

/* 减少动画模式支持 */
@media (prefers-reduced-motion: reduce) {
  .search-box,
  .action-btn {
    transition: none;
  }

  .loading-spinner {
    animation: none;
    opacity: 0.7;
  }
}

/* iOS Safari特定优化 */
@supports (-webkit-touch-callout: none) {
  .search-box {
    /* iOS Safari兼容性：防止缩放 */
    -webkit-text-size-adjust: 100%;
    -webkit-tap-highlight-color: transparent;
  }

  .search-input {
    /* iOS Safari兼容性：确保输入框正常工作 */
    -webkit-appearance: none;
    -webkit-border-radius: 0;
    border-radius: 0;
  }

  .action-btn {
    /* iOS Safari兼容性：确保触摸区域足够大 */
    min-height: 44px;
    min-width: 44px;
    -webkit-appearance: none;
  }
}
</style>
