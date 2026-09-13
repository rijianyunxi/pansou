<template>
  <div v-if="source" class="drawer-backdrop" @click.self="$emit('close')">
    <aside class="side-drawer detail-drawer" role="dialog" aria-modal="true" aria-labelledby="upstream-detail-title">
      <header class="drawer-header">
        <div class="drawer-title-group">
          <span class="source-avatar large" :style="{ '--source-color': source.color }">{{ source.initials }}</span>
          <div>
            <span class="eyebrow">UPSTREAM DETAIL</span>
            <h2 id="upstream-detail-title">{{ source.name }}</h2>
            <p>{{ source.description }}</p>
          </div>
        </div>
        <button class="icon-button" type="button" aria-label="关闭上游详情" @click="$emit('close')">
          <ConsoleIcon name="close" />
        </button>
      </header>

      <div class="drawer-body">
        <section class="drawer-section">
          <div class="drawer-section-heading">
            <div>
              <span class="section-label">连接配置</span>
              <p>请求入口、请求参数和响应类型。</p>
            </div>
          </div>
          <dl class="connection-list drawer-connection-list">
            <div>
              <dt>请求方式</dt>
              <dd><span class="method-tag" :class="source.method.toLowerCase()">{{ source.method }}</span></dd>
            </div>
            <div class="endpoint-row">
              <dt>接口地址</dt>
              <dd :title="source.url">{{ source.url }}</dd>
            </div>
            <div>
              <dt>响应类型</dt>
              <dd>{{ source.format.toUpperCase() }} <span class="tiny-muted">→ SearchResult[]</span></dd>
            </div>
            <div>
              <dt>运行方式</dt>
              <dd>{{ catalogSource ? '配置驱动 · 已生效' : `${recordStatus || '草稿'} · ${publishedVersion ? `线上 ${publishedVersion}` : '尚未发布'}` }}</dd>
            </div>
            <div v-if="source.sourceKind === 'telegram' && source.channel">
              <dt>频道</dt>
              <dd>@{{ source.channel }}</dd>
            </div>
            <div v-if="source.fallbackUrls?.length">
              <dt>备用 URL</dt>
              <dd><span v-for="url in source.fallbackUrls" :key="url" class="detail-tag">{{ url }}</span></dd>
            </div>
            <div v-if="source.driveType || source.tags?.length || source.resourceTypes?.length">
              <dt>标签分类</dt>
              <dd class="detail-tags"><span v-if="source.driveType" class="detail-tag">{{ source.driveType }}</span><span v-for="tag in source.tags || []" :key="`tag-${tag}`" class="detail-tag">{{ tag }}</span><span v-for="type in source.resourceTypes || []" :key="`type-${type}`" class="detail-tag">{{ type }}</span></dd>
            </div>
            <template v-if="record">
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
            </template>
          </dl>
        </section>

        <section v-if="record" class="drawer-section drawer-actions-section">
          <div class="section-label">版本操作</div>
          <p class="field-hint">旧版插件保留版本操作；普通上游保存后下一次请求立即生效。</p>
          <div class="drawer-action-grid">
            <button class="button secondary" type="button" :disabled="running || !keyword.trim()" @click="$emit('validate')">验证当前草稿</button>
            <button class="button primary" type="button" :disabled="!canPublish" @click="$emit('publish')">发布 {{ record.definition.manifest.version }}</button>
            <button v-if="record.publishedVersion && record.status !== 'disabled'" class="button secondary" type="button" @click="$emit('disable')">停用线上版本</button>
          </div>
        </section>

        <section v-if="record" class="drawer-section">
          <div class="section-label">密钥管理 <span class="tiny-muted">仅服务端注入请求</span></div>
          <p class="field-hint">密钥值不会返回浏览器；请求模板中使用 <code v-pre>{{secret.名称}}</code> 引用。</p>
          <ul v-if="pluginSecrets.length" class="secret-list">
            <li v-for="name in pluginSecrets" :key="name">
              <code>{{ name }}</code>
              <button class="button secondary tiny" type="button" @click="$emit('delete-secret', name)">删除</button>
            </li>
          </ul>
          <p v-else class="tiny-muted">尚未保存密钥。</p>
          <div class="secret-form">
            <input :value="secretName" class="secret-input" placeholder="名称，如 apiKey" autocomplete="off" spellcheck="false" @input="$emit('update:secretName', ($event.target as HTMLInputElement).value)" />
            <input :value="secretValue" class="secret-input" type="password" placeholder="密钥值" autocomplete="new-password" @input="$emit('update:secretValue', ($event.target as HTMLInputElement).value)" />
            <button class="button secondary" type="button" :disabled="!secretName.trim() || !secretValue" @click="$emit('save-secret')">保存</button>
          </div>
        </section>
      </div>

      <footer class="drawer-footer">
        <button class="button secondary" type="button" @click="$emit('edit')"><ConsoleIcon name="edit" :size="15" />修改配置</button>
        <button class="button secondary" type="button" :disabled="running" @click="$emit('debug')"><ConsoleIcon name="play" :size="15" />打开调试</button>
        <button class="button danger-button" type="button" @click="$emit('delete')"><ConsoleIcon name="trash" :size="15" />删除上游</button>
      </footer>
    </aside>
  </div>
</template>

<script setup lang="ts">
import ConsoleIcon from "./ConsoleIcon.vue";
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
