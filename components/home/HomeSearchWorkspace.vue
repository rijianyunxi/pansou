<template>
  <section class="search-workspace" aria-label="资源搜索">
    <div class="search-toolbar">
      <SearchScopeControl
        :model-value="onlyUserChannels"
        :count="channelCount"
        :disabled="searchScopeDisabled"
        :custom-disabled="customChannelsDisabled"
        @update:model-value="emit('update:onlyUserChannels', $event)"
        @custom-disabled="emit('custom-disabled')" />
      <button
        v-if="onlyUserChannels"
        type="button"
        class="manage-channels"
        :class="{ 'manage-channels--disabled': customChannelsDisabled }"
        :aria-disabled="customChannelsDisabled ? 'true' : undefined"
        :disabled="searchScopeDisabled"
        @click="emit('open-channels')">
        <span aria-hidden="true">+</span> {{ channelCount ? '管理频道' : '添加频道' }}
      </button>
    </div>

    <SearchBox
      :model-value="keyword"
      :loading="loading"
      :paused="paused"
      :searched="searched"
      :search-disabled="searchDisabled"
      :disabled-description-id="disabledDescriptionId"
      :placeholder="placeholder"
      @update:model-value="emit('update:keyword', $event)"
      @search="emit('search')"
      @reset="emit('reset')"
      @pause="emit('pause')"
      @continue="emit('continue')" />

    <div class="channel-configuration-status" role="status" aria-live="polite">
      <div v-if="needsChannelConfiguration && !loading" class="channel-configuration-notice">
        <div id="channel-configuration-hint">
          <strong>「自定义频道」还没有可搜索的频道</strong>
          <p>先添加公开频道，再选择「自定义频道」开始搜索。</p>
        </div>
        <button type="button" class="configure-channels" :disabled="paused" @click="emit('open-channels')">添加频道</button>
      </div>
    </div>

    <div class="scope-summary" aria-live="polite">
      <p v-if="onlyUserChannels && channels.length">只搜索你添加的 {{ channels.length }} 个公开频道，不会请求其他配置来源。</p>
      <div v-if="onlyUserChannels && channels.length" class="channel-preview" aria-label="已添加的自定义频道">
        <span v-for="channel in channels.slice(0, 3)" :key="channel" class="channel-chip">@{{ channel }}</span>
        <button v-if="channels.length > 3" type="button" :disabled="paused" @click="emit('open-channels')">+{{ channels.length - 3 }} 个</button>
      </div>
      <p v-if="paused">继续时使用本次搜索的原始参数；搜索范围和频道修改将在下一次搜索生效。</p>
    </div>
  </section>
  <p v-if="storageError" class="search-notice" role="alert">{{ storageError }}</p>
  <p v-if="sessionError && !sessionReady" class="search-notice" role="alert">{{ sessionError }}</p>
</template>

<script setup lang="ts">
interface Props {
  onlyUserChannels: boolean;
  channelCount: number;
  channels: string[];
  searchScopeDisabled: boolean;
  customChannelsDisabled: boolean;
  keyword: string;
  loading: boolean;
  paused: boolean;
  searched: boolean;
  searchDisabled: boolean;
  disabledDescriptionId?: string;
  placeholder: string;
  needsChannelConfiguration: boolean;
  storageError: string;
  sessionError: string;
  sessionReady: boolean;
}

withDefaults(defineProps<Props>(), { disabledDescriptionId: undefined });
const emit = defineEmits<{
  (event: "update:onlyUserChannels", value: boolean): void;
  (event: "update:keyword", value: string): void;
  (event: "custom-disabled"): void;
  (event: "open-channels"): void;
  (event: "search"): void;
  (event: "reset"): void;
  (event: "pause"): void;
  (event: "continue"): void;
}>();
</script>

<style scoped>
.search-workspace { display: flex; flex-direction: column; gap: 18px; padding: 20px; border: 1px solid var(--border-light); border-radius: 24px; background: var(--bg-primary); box-shadow: var(--shadow-sm); }
.search-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.manage-channels { display: inline-flex; align-items: center; gap: 6px; min-height: 44px; border: 0; border-radius: 8px; padding: 0 10px; background: transparent; color: var(--primary); font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap; }
.manage-channels span { font-size: 20px; font-weight: 400; }
.manage-channels:hover { background: var(--primary-soft); }
.manage-channels--disabled { opacity: .55; color: var(--text-secondary); cursor: not-allowed; }
.manage-channels--disabled:hover { background: transparent !important; }
.manage-channels:focus-visible, .channel-preview button:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.channel-configuration-status:empty, .scope-summary:empty { display: none; }
.channel-configuration-notice { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px 16px; padding: 14px 16px; border: 1px solid var(--border-light); border-radius: 12px; background: var(--bg-secondary); }
.channel-configuration-notice strong { color: var(--text-primary); font-size: 14px; font-weight: 600; }
.channel-configuration-notice p { margin: 4px 0 0; color: var(--text-secondary); font-size: 13px; line-height: 1.6; }
.configure-channels { min-height: 44px; padding: 0 14px; border: 1px solid var(--border-light); border-radius: 8px; background: var(--bg-primary); color: var(--primary); font-size: 13px; font-weight: 600; white-space: nowrap; cursor: pointer; }
.configure-channels:disabled, .channel-preview button:disabled { opacity: .55; cursor: not-allowed; }
.configure-channels:hover:not(:disabled) { background: var(--primary-soft); }
.configure-channels:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.scope-summary { color: var(--text-secondary); font-size: 12px; line-height: 1.8; }
.scope-summary p { margin: 0; }
.channel-preview { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.channel-chip { max-width: 100%; overflow-wrap: anywhere; padding: 3px 9px; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 6px; color: var(--text-secondary); }
.channel-preview button { border: 0; color: var(--primary); background: transparent; cursor: pointer; }
.search-notice { margin: 0; padding: 12px 16px; font-size: 13px; line-height: 1.7; color: var(--text-secondary); background: var(--bg-secondary); border-radius: 10px; }
.search-workspace :deep(.search-box) { box-shadow: none; background: var(--bg-secondary); border-radius: 14px; }
.search-workspace :deep(.search-box.focused) { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
@media (max-width: 480px) {
  .search-workspace { padding: 14px; gap: 14px; border-radius: 18px; }
  .search-toolbar { flex-wrap: wrap; gap: 6px; }
  .search-toolbar :deep(.scope-control) { flex: 1; }
  .manage-channels { margin-left: auto; }
}
</style>
