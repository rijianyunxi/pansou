<template>
  <UpstreamEditor
    v-if="source"
    :source="source"
    :readonly="true"
    :running="running"
    @close="$emit('close')"
    @edit="$emit('edit')"
    @debug="$emit('debug')"
    @delete="$emit('delete')"
  >
    <template #readonly-extra>
      <section v-if="record" class="drawer-section drawer-actions-section">
        <div class="section-label">版本信息</div>
        <dl class="connection-list drawer-connection-list">
          <div>
            <dt>当前版本</dt>
            <dd><code>{{ record.definition.manifest.version }}</code></dd>
          </div>
          <div>
            <dt>已发布版本</dt>
            <dd><code>{{ record.publishedVersion || '未发布' }}</code></dd>
          </div>
          <div>
            <dt>验证状态</dt>
            <dd>{{ validationText }}</dd>
          </div>
          <div>
            <dt>运行状态</dt>
            <dd>{{ catalogSource ? '配置驱动 · 已生效' : `${recordStatus || '草稿'} · ${publishedVersion ? `线上 ${publishedVersion}` : '尚未发布'}` }}</dd>
          </div>
        </dl>
        <p class="field-hint">详情页不会修改配置；以下操作只作用于插件版本状态。</p>
        <div class="drawer-action-grid">
          <button class="button secondary" type="button" :disabled="running || !keyword.trim()" @click="$emit('validate')">验证当前版本</button>
          <button class="button primary" type="button" :disabled="!canPublish" @click="$emit('publish')">发布 {{ record.definition.manifest.version }}</button>
          <button v-if="record.publishedVersion && record.status !== 'disabled'" class="button secondary" type="button" @click="$emit('disable')">停用线上版本</button>
        </div>
      </section>

      <section v-if="record" class="drawer-section">
        <div class="section-label">密钥信息 <span class="tiny-muted">仅服务端注入请求</span></div>
        <p class="field-hint">密钥值不会返回浏览器；请求模板中使用 <code v-pre>{{secret.名称}}</code> 引用。</p>
        <ul v-if="pluginSecrets.length" class="secret-list">
          <li v-for="name in pluginSecrets" :key="name">
            <code>{{ name }}</code>
            <span class="tiny-muted">已配置</span>
          </li>
        </ul>
        <p v-else class="tiny-muted">尚未保存密钥。</p>
      </section>
    </template>
  </UpstreamEditor>
</template>

<script setup lang="ts">
import UpstreamEditor from "./UpstreamEditor.vue";
import type { UpstreamDefinition } from "../../config/upstreams";
import type { PluginRecord } from "../../server/core/plugins/repository";

defineProps<{
  source: UpstreamDefinition;
  catalogSource: boolean;
  record?: PluginRecord;
  recordStatus?: string;
  publishedVersion?: string;
  validationText: string;
  canPublish: boolean;
  running: boolean;
  keyword: string;
  pluginSecrets: string[];
  secretName: string;
  secretValue: string;
}>();

defineEmits<{
  close: [];
  edit: [];
  debug: [];
  delete: [];
  validate: [];
  publish: [];
  disable: [];
  "delete-secret": [name: string];
  "save-secret": [];
  "update:secretName": [value: string];
  "update:secretValue": [value: string];
}>();
</script>
