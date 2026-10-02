<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { Folder, ChevronRight } from '@lucide/vue';
import { Button } from './ui/button';
import { apiErrorMessage, apiFetch } from '../../src/appRuntime';
import { providerRoot, folderKey, selectableDirectory, type CloudFolder, type ProviderKey } from '../../lib/linkPolicy';
const props = defineProps<{ provider: ProviderKey }>();
const emit = defineEmits<{ select: [dir: string, name: string] }>();
const trail = ref([{ dir: providerRoot(props.provider), name: '全部文件' }]);
const current = computed(() => trail.value[trail.value.length - 1]!);
const folders = ref<CloudFolder[]>([]);
const busy = ref(false), error = ref('');
const controller = new AbortController();
async function load(next: typeof trail.value) {
  if (busy.value) return;
  busy.value = true; error.value = ''; folders.value = [];
  try {
    const result = await apiFetch<{ data: { files: CloudFolder[] } }>('/api/admin/cloud-drive/list', {
      method: 'POST', body: { provider: props.provider, dir: next[next.length - 1]!.dir }, signal: controller.signal, silentError: true,
    });
    trail.value = next;
    folders.value = result.data.files.filter(file => file.isDir && selectableDirectory(folderKey(props.provider, file)));
  } catch (e) { if (!controller.signal.aborted) error.value = apiErrorMessage(e, '读取目录失败，请检查登录凭据后重试。'); }
  finally { busy.value = false; }
}
onMounted(() => load(trail.value));
onBeforeUnmount(() => controller.abort());
</script>
<template>
  <div class="directory-browser">
    <nav class="directory-trail" aria-label="网盘目录层级">
      <Button v-for="(item, index) in trail" :key="item.dir" type="button" variant="ghost" :disabled="busy || index === trail.length - 1" @click="load(trail.slice(0, index + 1))">{{ item.name }}</Button>
    </nav>
    <p v-if="busy" role="status">正在读取目录…</p>
    <div v-else-if="error" role="alert"><p>{{ error }}</p><Button type="button" variant="outline" @click="load(trail)">重新读取</Button></div>
    <div v-else class="directory-list">
      <p v-if="!folders.length">这里没有子目录。可以选择当前目录，或先在网盘中新建项目专用文件夹后刷新。</p>
      <Button v-for="folder in folders" :key="folderKey(provider, folder)" type="button" variant="ghost" class="directory-row" @click="load([...trail, { dir: folderKey(provider, folder), name: folder.name }])">
        <Folder :size="18" aria-hidden="true" /><span>{{ folder.name }}</span><ChevronRight :size="16" aria-hidden="true" />
      </Button>
    </div>
    <div class="directory-actions">
      <Button type="button" variant="outline" :disabled="busy" @click="load(trail)">刷新目录</Button>
      <Button type="button" :disabled="busy || !!error || !selectableDirectory(current.dir)" @click="emit('select', current.dir, trail.slice(1).map(item => item.name).join(' / '))">使用当前目录</Button>
    </div>
    <p class="directory-hint">不允许选择根目录。只清理本流程在所选目录下创建的子目录。</p>
  </div>
</template>
<style scoped>
@layer components {
.directory-browser { display: flex; flex-direction: column; gap: 16px; min-height: 0; color: var(--foreground); }
.directory-browser p { margin: 0; font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; }
.directory-trail, .directory-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.directory-trail button, .directory-actions button, .directory-row { min-height: 44px; }
.directory-actions { justify-content: flex-end; }
/* The list is the dialog's one scroll region: it shrinks before anything
   else, so trail, actions and hint stay visible on short viewports. */
.directory-list { flex: 0 1 auto; min-height: 96px; max-height: 46vh; overflow-y: auto; overscroll-behavior: contain; }
.directory-row { width: 100%; justify-content: flex-start; height: auto; text-align: left; }
.directory-row span { flex: 1; white-space: normal; overflow-wrap: anywhere; }
.directory-hint { color: var(--muted-foreground); }
}
</style>
