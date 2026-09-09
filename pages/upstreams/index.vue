<template>
  <div class="upstream-app">
    <aside class="console-sidebar">
      <NuxtLink to="/" class="console-brand"
        ><span class="brand-symbol"><ConsoleIcon name="box" :size="22" /></span
        >PanHub <span class="brand-tag">CONSOLE</span></NuxtLink
      >
      <div class="workspace-selector">
        <span class="workspace-avatar">P</span>
        <div>
          <strong>本地工作空间</strong><small>Development workspace</small>
        </div>
        <ConsoleIcon name="down" :size="14" />
      </div>
      <span class="nav-caption">工作空间</span>
      <nav aria-label="工作台导航">
        <button
          :class="{ active: view === 'sources' }"
          @click="setView('sources')"
        >
          <ConsoleIcon name="box" />上游接口<span class="nav-count">{{
            sources.length
          }}</span>
        </button>
        <button
          :class="{ active: view === 'adapters' }"
          @click="setView('adapters')"
        >
          <ConsoleIcon name="map" />适配器映射
        </button>
        <button :class="{ active: view === 'debug' }" @click="setView('debug')">
          <ConsoleIcon name="code" />在线调试<span class="nav-dot"></span>
        </button>
      </nav>
      <div class="sidebar-bottom">
        <div class="scope-card">
          <ConsoleIcon name="shield" /><strong>安全的调试环境</strong>
          <p>仅探测内置白名单地址。<br />配置草稿不会影响线上搜索。</p>
        </div>
        <NuxtLink to="/" class="back-search"
          ><ConsoleIcon name="back" />返回搜索首页<ConsoleIcon
            name="external"
            :size="14"
        /></NuxtLink>
        <div class="sidebar-footer">
          <span class="status-dot available"></span>本地开发模式<span
            >v0.1</span
          >
        </div>
      </div>
    </aside>

    <div class="console-body">
      <header class="console-topbar">
        <div class="breadcrumbs">
          <ConsoleIcon name="grid" :size="16" /><span>工作空间</span
          ><ConsoleIcon name="chevron" :size="13" /><strong>{{
            viewTitle
          }}</strong>
        </div>
        <div class="topbar-right">
          <span class="local-chip"><span></span>LOCAL</span
          ><span class="topbar-divider"></span
          ><span class="user-avatar">P</span>
        </div>
      </header>
      <main class="console-main">
        <section class="page-heading">
          <div>
            <div class="eyebrow">SOURCES & ADAPTERS</div>
            <h1>
              {{ viewTitle
              }}<span class="heading-badge">{{
                view === "sources"
                  ? sources.length
                  : view === "adapters"
                    ? "JSON → Unified"
                    : "Live"
              }}</span>
            </h1>
            <p>
              {{
                view === "sources"
                  ? "集中管理搜索来源，观测接口状态，让不同响应归于同一标准。"
                  : view === "adapters"
                    ? "用字段映射连接不同数据结构，预览与搜索服务一致的 SearchResult 输出。"
                    : "发起一次真实请求，查看上游响应、业务状态与适配结果。"
              }}
            </p>
          </div>
          <div class="heading-actions">
            <button
              v-if="batchRunning"
              class="button secondary"
              @click="stopBatch = true"
            >
              <ConsoleIcon name="stop" />停止后续测试</button
            ><button
              v-else
              class="button secondary"
              :disabled="!!runningId"
              @click="testAll"
            >
              <ConsoleIcon name="activity" />测试全部</button
            ><button class="button primary" @click="openEditor()">
              <ConsoleIcon name="plus" />新增上游
            </button>
          </div>
        </section>

        <div v-if="storageError" class="notice error-notice" role="alert">
          <ConsoleIcon name="info" />{{ storageError }}
        </div>
        <div v-if="batchRunning" class="batch-progress" role="status">
          <span class="spinner"></span>正在顺序测试 {{ batchIndex }} /
          {{ batchTotal
          }}<span>单次 12 秒上限 · 不重试 · 不自动跟随重定向</span>
          <div class="batch-track">
            <div
              :style="{ width: `${(batchIndex / batchTotal) * 100}%` }"
            ></div>
          </div>
        </div>

        <section class="metric-grid" aria-label="接口状态概览">
          <article class="metric-card">
            <div class="metric-label">已配置上游<ConsoleIcon name="box" /></div>
            <div class="metric-value">
              {{ sources.length }}<span>个</span
              ><small class="metric-pill">{{ drafts.length }} 个草稿</small>
            </div>
            <p>
              {{ BUILTIN_UPSTREAMS.length }} 个独立地址 ·
              {{ pluginCount }} 个内置插件
            </p>
          </article>
          <article class="metric-card">
            <div class="metric-label">适配可用<ConsoleIcon name="check" /></div>
            <div class="metric-value green">
              {{ countState("available") }}<span>/ {{ testedCount }}</span>
            </div>
            <p>
              <span class="status-dot available"></span
              >依据当前浏览器最近一次测试
            </p>
          </article>
          <article class="metric-card">
            <div class="metric-label">
              需要关注<ConsoleIcon name="activity" />
            </div>
            <div class="metric-value">
              {{ countState("error") + countState("warning") }}<span>个</span>
            </div>
            <p>
              {{ countState("error") }} 个异常 ·
              {{ countState("warning") }} 个待确认
            </p>
          </article>
          <article class="metric-card">
            <div class="metric-label">
              最近测试平均耗时<ConsoleIcon name="clock" />
            </div>
            <div class="metric-value mono">{{ averageMs }}<span>ms</span></div>
            <p>含失败与多步请求 · 非持续监控</p>
          </article>
        </section>

        <div
          class="console-workbench"
          :class="{ 'focus-workbench': view !== 'sources' }"
        >
          <section class="sources-panel">
            <div class="panel-heading">
              <div>
                <h2>
                  接口目录 <span>{{ sources.length }}</span>
                </h2>
                <p>选择来源，查看连接与适配详情</p>
              </div>
              <button
                class="icon-button"
                title="清除本地测试记录"
                aria-label="清除本地测试记录"
                :disabled="!!runningId || batchRunning"
                @click="clearReports"
              >
                <ConsoleIcon name="refresh" :size="17" />
              </button>
            </div>
            <div class="source-toolbar">
              <div class="filter-tabs" aria-label="按状态筛选">
                <button
                  v-for="filter in filters"
                  :key="filter.value"
                  :class="{ selected: stateFilter === filter.value }"
                  @click="stateFilter = filter.value"
                >
                  {{ filter.label
                  }}<span v-if="filter.value === 'all'">{{
                    sources.length
                  }}</span>
                </button>
              </div>
              <label class="source-search"
                ><ConsoleIcon name="search" :size="16" /><input
                  v-model="search"
                  type="search"
                  aria-label="搜索上游名称或地址"
                  placeholder="搜索上游..."
              /></label>
            </div>
            <div class="table-scroll">
              <table class="source-table">
                <thead>
                  <tr>
                    <th>上游 / 接口地址</th>
                    <th>状态</th>
                    <th class="latency-column">耗时</th>
                    <th class="action-column">操作</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="source in filteredSources"
                    :key="source.id"
                    :class="{
                      'selected-row': source.id === selectedId,
                      'disabled-row': enabled[source.id] === false,
                    }"
                    tabindex="0"
                    :aria-label="`查看 ${source.name}`"
                    :aria-selected="source.id === selectedId"
                    @click="selectSource(source.id)"
                    @keydown.enter.self="selectSource(source.id)"
                  >
                    <td>
                      <div class="source-identity">
                        <span
                          class="source-avatar"
                          :style="{ '--source-color': source.color }"
                          >{{ source.initials }}</span
                        >
                        <div class="source-text">
                          <div class="source-name">
                            {{ source.name
                            }}<span v-if="!source.builtin" class="draft-tag"
                              >草稿</span
                            ><span
                              v-else
                              class="method-tag"
                              :class="source.method.toLowerCase()"
                              >{{ source.method }}</span
                            >
                          </div>
                          <div class="source-address" :title="source.url">
                            {{ displayUrl(source.url) }}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span class="state-badge" :class="status(source.id)"
                        ><span
                          v-if="runningId === source.id"
                          class="spinner"
                        ></span
                        ><span
                          v-else
                          class="status-dot"
                          :class="status(source.id)"
                        ></span
                        >{{ statusLabel(source.id) }}</span
                      >
                    </td>
                    <td class="latency-column">
                      <span
                        class="latency"
                        :class="{
                          slow: (reports[source.id]?.elapsedMs || 0) > 5000,
                        }"
                        >{{
                          reports[source.id]
                            ? `${reports[source.id].elapsedMs.toLocaleString()} ms`
                            : "—"
                        }}</span
                      >
                    </td>
                    <td class="action-column">
                      <button
                        class="row-test icon-button"
                        :disabled="
                          !!runningId ||
                          batchRunning ||
                          !source.builtin ||
                          enabled[source.id] === false
                        "
                        :aria-label="`测试 ${source.name}`"
                        :title="
                          source.builtin ? '测试此上游' : '草稿尚未接入网络执行'
                        "
                        @click.stop="testSource(source)"
                      >
                        <ConsoleIcon name="play" :size="15" /></button
                      ><ConsoleIcon name="chevron" :size="14" />
                    </td>
                  </tr>
                </tbody>
              </table>
              <div v-if="!filteredSources.length" class="empty-sources">
                <ConsoleIcon name="search" :size="28" />
                <h3>没有匹配的上游</h3>
                <p>换一个关键词，或调整状态筛选。</p>
                <button
                  class="button secondary small"
                  @click="
                    search = '';
                    stateFilter = 'all';
                  "
                >
                  重置筛选
                </button>
              </div>
            </div>
            <footer class="table-footer">
              <span
                ><span class="status-dot neutral"></span
                >{{ filteredSources.length }} /
                {{ sources.length }} 个来源</span
              ><span>配置与测试记录仅存于当前浏览器</span>
            </footer>
          </section>

          <section v-if="selected" class="detail-panel" aria-label="上游详情">
            <div class="detail-heading">
              <span
                class="source-avatar large"
                :style="{ '--source-color': selected.color }"
                >{{ selected.initials }}</span
              >
              <div>
                <h2>
                  {{ selected.name
                  }}<span class="state-badge" :class="status(selected.id)">{{
                    statusLabel(selected.id)
                  }}</span>
                </h2>
                <p>{{ selected.description }}</p>
              </div>
              <button
                class="icon-button"
                aria-label="编辑当前上游"
                @click="openEditor(selected)"
              >
                <ConsoleIcon name="edit" />
              </button>
            </div>
            <div class="detail-tabs" role="tablist" aria-label="上游工作区">
              <button
                id="tab-overview"
                role="tab"
                :aria-selected="detailTab === 'overview'"
                :tabindex="detailTab === 'overview' ? 0 : -1"
                aria-controls="detail-content"
                @click="detailTab = 'overview'"
                @keydown="tabKeyboard($event, 'overview')"
              >
                概览</button
              ><button
                id="tab-debug"
                role="tab"
                :aria-selected="detailTab === 'debug'"
                :tabindex="detailTab === 'debug' ? 0 : -1"
                aria-controls="detail-content"
                @click="detailTab = 'debug'"
                @keydown="tabKeyboard($event, 'debug')"
              >
                在线调试</button
              ><button
                id="tab-adapter"
                role="tab"
                :aria-selected="detailTab === 'adapter'"
                :tabindex="detailTab === 'adapter' ? 0 : -1"
                aria-controls="detail-content"
                @click="detailTab = 'adapter'"
                @keydown="tabKeyboard($event, 'adapter')"
              >
                适配器映射
              </button>
            </div>
            <div
              id="detail-content"
              role="tabpanel"
              :aria-labelledby="`tab-${detailTab}`"
            >
              <div v-if="detailTab === 'overview'" class="detail-content">
                <div class="section-label">
                  连接配置
                  <button class="text-button" @click="detailTab = 'debug'">
                    调试接口<ConsoleIcon name="arrow" :size="14" />
                  </button>
                </div>
                <dl class="connection-list">
                  <div>
                    <dt>请求方式</dt>
                    <dd>
                      <span
                        class="method-tag"
                        :class="selected.method.toLowerCase()"
                        >{{ selected.method }}</span
                      >
                    </dd>
                  </div>
                  <div class="endpoint-row">
                    <dt>接口地址</dt>
                    <dd>{{ selected.url }}</dd>
                  </div>
                  <div>
                    <dt>适配器</dt>
                    <dd class="mono">{{ selected.adapter }}</dd>
                  </div>
                  <div>
                    <dt>响应类型</dt>
                    <dd>
                      {{ selected.format.toUpperCase()
                      }}<span class="tiny-muted"> → SearchResult[]</span>
                    </dd>
                  </div>
                  <div>
                    <dt>执行范围</dt>
                    <dd>
                      {{
                        selected.builtin
                          ? "内置地址 · 本地开发"
                          : "配置草稿 · 尚未发布"
                      }}
                    </dd>
                  </div>
                  <div>
                    <dt>参与批量测试</dt>
                    <dd>
                      <button
                        class="toggle"
                        role="switch"
                        :aria-checked="
                          selected.builtin && enabled[selected.id] !== false
                        "
                        aria-label="参与批量测试"
                        :disabled="
                          !selected.builtin || !!runningId || batchRunning
                        "
                        :class="{
                          on:
                            enabled[selected.id] !== false && selected.builtin,
                        }"
                        @click="toggleEnabled(selected.id)"
                      >
                        <span></span>
                      </button>
                    </dd>
                  </div>
                </dl>
                <div
                  class="health-box"
                  :class="selectedReport?.state || 'untested'"
                >
                  <div class="health-box-heading">
                    <ConsoleIcon
                      :name="
                        selectedReport?.state === 'available'
                          ? 'check'
                          : 'activity'
                      "
                    /><strong>{{
                      selectedReport ? "最近一次测试" : "尚未检测此接口"
                    }}</strong
                    ><time v-if="selectedReport">{{
                      formatTime(selectedReport.checkedAt)
                    }}</time>
                  </div>
                  <p>
                    {{
                      selectedReport?.message ||
                      "发起一次轻量请求，查看真实 HTTP 状态、业务校验与响应耗时。"
                    }}
                  </p>
                  <div v-if="selectedReport" class="health-meta">
                    <span
                      >HTTP
                      <b>{{ selectedReport.httpStatus ?? "未取得" }}</b></span
                    ><span
                      >耗时 <b>{{ selectedReport.elapsedMs }} ms</b></span
                    ><span
                      >结果 <b>{{ selectedReport.results.length }}</b></span
                    >
                  </div>
                  <button
                    class="button secondary full"
                    :disabled="!!runningId || batchRunning || !selected.builtin"
                    @click="testSource(selected)"
                  >
                    <ConsoleIcon name="activity" />{{
                      runningId === selected.id
                        ? "正在请求上游…"
                        : "测试健康状态"
                    }}
                  </button>
                </div>
                <div class="pipeline-section">
                  <div class="section-label">
                    适配流程 <span class="tiny-muted">统一输出协议</span>
                  </div>
                  <div class="adapter-pipeline">
                    <span
                      ><ConsoleIcon name="globe" />{{
                        selected.format.toUpperCase()
                      }}</span
                    ><ConsoleIcon name="arrow" :size="14" /><span
                      ><ConsoleIcon name="map" />Adapter</span
                    ><ConsoleIcon name="arrow" :size="14" /><span
                      class="pipeline-result"
                      ><ConsoleIcon name="code" />Result</span
                    >
                  </div>
                  <p>
                    不同来源通过适配器转换为
                    <code>SearchResult[]</code
                    >，为后续统一搜索保留一致的数据契约。
                  </p>
                </div>
                <div class="detail-footnote">
                  <ConsoleIcon name="info" :size="15" /><span
                    >工作台配置不会修改搜索页的来源开关。自定义上游目前仅支持本地草稿与映射预览。</span
                  >
                </div>
              </div>

              <div
                v-else-if="detailTab === 'debug'"
                class="detail-content debug-content"
              >
                <div class="section-label">
                  请求实验台 <span class="tiny-muted">LIVE REQUEST</span>
                </div>
                <label class="field-label" for="debug-keyword"
                  >测试关键词</label
                >
                <div class="debug-controls">
                  <input
                    id="debug-keyword"
                    v-model="keyword"
                    :disabled="!!runningId || batchRunning"
                    maxlength="100"
                    placeholder="输入测试关键词"
                    @keydown.enter="
                      !runningId &&
                      !batchRunning &&
                      selected.builtin &&
                      testSource(selected)
                    "
                  /><button
                    class="button primary"
                    :disabled="
                      !!runningId ||
                      batchRunning ||
                      !selected.builtin ||
                      !keyword.trim()
                    "
                    @click="testSource(selected)"
                  >
                    <span
                      v-if="runningId === selected.id"
                      class="spinner"
                    ></span
                    ><ConsoleIcon v-else name="play" :size="15" />发送
                  </button>
                </div>
                <p class="field-hint">
                  {{
                    selected.builtin
                      ? "单次探测 · 跳过缓存 · 不自动重试 · 最长 12 秒"
                      : "自定义接口尚未接入执行器，可在适配器中使用 JSON 样本调试。"
                  }}
                </p>
                <div class="request-line">
                  <span
                    class="method-tag"
                    :class="selected.method.toLowerCase()"
                    >{{ selected.method }}</span
                  ><code>{{ requestPreview.url }}</code>
                </div>
                <div class="response-tabs">
                  <button
                    :class="{ active: responseTab === 'unified' }"
                    @click="responseTab = 'unified'"
                  >
                    统一结果
                    <span>{{
                      selectedReport?.results.length || 0
                    }}</span></button
                  ><button
                    :class="{ active: responseTab === 'raw' }"
                    @click="responseTab = 'raw'"
                  >
                    原始响应</button
                  ><button
                    :class="{ active: responseTab === 'request' }"
                    @click="responseTab = 'request'"
                  >
                    请求参数</button
                  ><button
                    class="icon-button"
                    aria-label="复制当前调试内容"
                    @click="copy(debugText)"
                  >
                    <ConsoleIcon name="copy" :size="14" />
                  </button>
                </div>
                <div class="code-window">
                  <div class="code-window-header">
                    <span><i></i><i></i><i></i></span
                    ><span>{{
                      responseTab === "request"
                        ? "request.json"
                        : responseTab === "raw"
                          ? "response.raw"
                          : "SearchResult.json"
                    }}</span
                    ><small>{{
                      selectedReport?.httpStatus
                        ? `HTTP ${selectedReport.httpStatus}`
                        : "READY"
                    }}</small>
                  </div>
                  <pre
                    v-if="selectedReport || responseTab === 'request'"
                    tabindex="0"
                    >{{ debugText }}</pre
                  >
                  <div v-else class="code-empty">
                    <ConsoleIcon name="code" :size="30" /><strong
                      >等待第一个响应</strong
                    >
                    <p>点击「发送」，在这里检查上游数据。</p>
                    <code>// no request sent yet</code>
                  </div>
                </div>
                <p
                  v-if="selectedReport?.rawTruncated && responseTab === 'raw'"
                  class="field-hint"
                >
                  原始响应预览已截断至 100,000 字符；统一结果使用完整响应解析。
                </p>
                <div
                  v-if="selectedReport"
                  class="request-outcome"
                  :class="selectedReport.state"
                >
                  <ConsoleIcon name="info" :size="16" /><span>{{
                    selectedReport.message
                  }}</span>
                </div>
                <div class="trace-section">
                  <div class="section-label">
                    请求轨迹<span class="tiny-muted"
                      >{{ selectedReport?.traces.length || 0 }} REQUESTS</span
                    >
                  </div>
                  <div
                    v-for="(trace, index) in selectedReport?.traces || []"
                    :key="index"
                    class="trace-row"
                  >
                    <span class="trace-index">{{
                      String(index + 1).padStart(2, "0")
                    }}</span>
                    <div>
                      <strong
                        >{{ trace.method }}
                        <span>{{ displayUrl(trace.url) }}</span></strong
                      >
                      <p>
                        {{
                          trace.error ||
                          `${trace.contentType || "unknown"} · ${(trace.bytes / 1024).toFixed(1)} KB`
                        }}
                      </p>
                    </div>
                    <span
                      class="trace-status"
                      :class="{ failed: !trace.status || trace.status >= 300 }"
                      >{{ trace.status || "ERR"
                      }}<small>{{ trace.elapsedMs }} ms</small></span
                    >
                  </div>
                  <p v-if="!selectedReport" class="field-hint">
                    请求完成后显示每一步的 HTTP 状态与耗时。
                  </p>
                </div>
              </div>

              <div v-else class="detail-content adapter-content">
                <div class="section-label">
                  字段映射 <span class="mapping-version">SearchResult v1</span>
                </div>
                <template v-if="selected.format === 'json'">
                  <p class="field-hint">
                    路径相对于每条结果；支持
                    <code>data.list</code> 点路径，不执行脚本。
                  </p>
                  <div class="mapping-fields">
                    <label
                      >结果数组路径<input
                        v-model="mappingDraft.items"
                        placeholder="data.list（空白表示根数组）"
                    /></label>
                    <div
                      v-for="field in mappingFields"
                      :key="field.key"
                      class="mapping-row"
                    >
                      <code>{{ field.target }}</code
                      ><ConsoleIcon name="back" :size="13" /><input
                        v-model="mappingDraft[field.key]"
                        :aria-label="field.target + ' 来源路径'"
                        :placeholder="field.placeholder"
                      />
                    </div>
                    <label
                      >嵌套链接数组
                      <span class="tiny-muted">可选，相对于每条结果</span
                      ><input
                        v-model="mappingDraft.linkArray"
                        placeholder="例如：links（不填表示单链接）"
                    /></label>
                  </div>
                  <div class="sample-heading">
                    <label class="field-label" for="json-sample"
                      >JSON 样本
                      <span>{{
                        sampleIsLive ? "最近响应" : "示例数据 · 非线上响应"
                      }}</span></label
                    ><button
                      class="text-button"
                      :disabled="!selectedReport || selectedReport.rawTruncated"
                      @click="loadLastResponse"
                    >
                      载入最近响应
                    </button>
                  </div>
                  <textarea
                    id="json-sample"
                    v-model="sampleJson"
                    class="sample-editor"
                    spellcheck="false"
                    rows="7"
                    @input="sampleIsLive = false"
                  ></textarea>
                  <div class="mapping-actions">
                    <button class="button secondary" @click="previewMapping">
                      <ConsoleIcon name="play" :size="14" />预览映射</button
                    ><button class="button primary" @click="saveMapping">
                      <ConsoleIcon name="check" :size="14" />保存草稿
                    </button>
                  </div>
                  <p v-if="mappingError" class="form-error" role="alert">
                    {{ mappingError }}
                  </p>
                  <div v-if="mappingPreview !== null" class="mapping-preview">
                    <div class="section-label">
                      统一输出<span>{{ mappingPreview.length }} 条结果</span>
                    </div>
                    <pre tabindex="0">{{
                      JSON.stringify(mappingPreview, null, 2)
                    }}</pre>
                  </div>
                  <p class="field-hint mapping-disclaimer">
                    映射草稿仅用于此处预览；在线探测仍使用内置映射，尚未发布到搜索服务。
                  </p>
                </template>
                <template v-else
                  ><div class="native-adapter">
                    <div class="native-icon">
                      <ConsoleIcon name="code" :size="27" />
                    </div>
                    <h3>
                      {{
                        selected.adapter === "next-data"
                          ? "Next.js 数据适配器"
                          : selected.adapter === "nyaa-html"
                            ? "Nyaa HTML 适配器"
                            : "HTML 专用适配器"
                      }}
                    </h3>
                    <p>
                      HTML 页面不能直接使用 JSON 字段路径。{{
                        selected.adapter === "html-probe"
                          ? "当前工作台只检查搜索页响应，详情抽取尚未接入。"
                          : "已内置结构解析逻辑，可在在线调试中查看统一输出。"
                      }}
                    </p>
                    <button
                      class="button secondary"
                      @click="detailTab = 'debug'"
                    >
                      前往在线调试<ConsoleIcon name="arrow" :size="15" />
                    </button>
                  </div>
                  <div class="schema-card">
                    <div class="section-label">目标输出契约</div>
                    <pre>{{ schemaExample }}</pre>
                  </div></template
                >
              </div>
            </div>
            <div v-if="!selected.builtin" class="delete-draft">
              <button class="text-button danger" @click="deleteDraft">
                <ConsoleIcon name="trash" :size="14" />{{
                  deleteArmed ? "再次点击，确认删除草稿" : "删除此草稿"
                }}
              </button>
            </div>
          </section>
        </div>
        <footer class="console-footer">
          <span
            ><ConsoleIcon name="shield" :size="14" />内置白名单 · TLS 校验开启 ·
            自定义地址不执行</span
          ><span>PanHub / Upstream Console</span>
        </footer>
      </main>
    </div>
    <UpstreamEditor
      v-if="editorOpen"
      :source="editingSource"
      @close="editorOpen = false"
      @save="saveSource"
    />
    <div v-if="notice" class="console-toast" role="status">
      <ConsoleIcon name="info" :size="17" />{{ notice }}
    </div>
  </div>
</template>

<script setup lang="ts">
import ConsoleIcon from "../../components/upstreams/ConsoleIcon.vue";
import UpstreamEditor from "../../components/upstreams/UpstreamEditor.vue";
import {
  BUILTIN_UPSTREAMS,
  buildUpstreamRequest,
  type UpstreamDefinition,
  type UpstreamProbe,
  type AdapterMapping,
} from "../../config/upstreams";
import { normalizeUpstreamJson } from "../../utils/upstreamAdapter";
import type { SearchResult } from "../../server/core/types/models";
useHead({
  title: "上游管理",
  meta: [
    { name: "robots", content: "noindex, nofollow" },
    {
      name: "viewport",
      content: "width=device-width, initial-scale=1, viewport-fit=cover",
    },
  ],
});
const STORAGE_KEY = "panhub.upstream-console.v1";
const drafts = ref<UpstreamDefinition[]>([]);
const overrides = ref<
  Record<
    string,
    { name?: string; description?: string; mapping?: AdapterMapping }
  >
>({});
const enabled = ref<Record<string, boolean>>({});
const reports = ref<Record<string, UpstreamProbe>>({});
const sources = computed(() => [
  ...BUILTIN_UPSTREAMS.map((s) => ({ ...s, ...overrides.value[s.id] })),
  ...drafts.value,
]);
const selectedId = ref("hunhepan");
const selected = computed(
  () =>
    sources.value.find((s) => s.id === selectedId.value) || sources.value[0],
);
const selectedReport = computed(() => reports.value[selected.value.id]);
const view = ref<"sources" | "adapters" | "debug">("sources");
const viewTitle = computed(
  () =>
    ({ sources: "上游接口", adapters: "适配器映射", debug: "在线调试" })[
      view.value
    ],
);
const detailTab = ref<"overview" | "debug" | "adapter">("overview");
const responseTab = ref<"unified" | "raw" | "request">("unified");
const search = ref("");
const stateFilter = ref("all");
const filters = [
  { label: "全部", value: "all" },
  { label: "可用", value: "available" },
  { label: "异常", value: "error" },
  { label: "未检测", value: "untested" },
];
const runningId = ref("");
const batchRunning = ref(false);
const stopBatch = ref(false);
const batchIndex = ref(0);
const batchTotal = ref(0);
const keyword = ref("三体");
const editorOpen = ref(false);
const editingSource = ref<UpstreamDefinition | null>(null);
const storageError = ref("");
const notice = ref("");
let noticeTimer: ReturnType<typeof setTimeout>;
const deleteArmed = ref(false);
const mappingDraft = ref<AdapterMapping>({
  items: "",
  title: "",
  url: "",
  type: "",
  password: "",
});
const sampleJson = ref("");
const sampleIsLive = ref(false);
const mappingPreview = ref<SearchResult[] | null>(null);
const mappingError = ref("");
const mappingFields: {
  key: "title" | "url" | "type" | "password";
  target: string;
  placeholder: string;
}[] = [
  { key: "title", target: "title", placeholder: "disk_name" },
  { key: "url", target: "links[].url", placeholder: "link" },
  { key: "type", target: "links[].type", placeholder: "disk_type（可选）" },
  {
    key: "password",
    target: "links[].password",
    placeholder: "disk_pass（可选）",
  },
];
const schemaExample = JSON.stringify(
  [
    {
      unique_id: "source-0",
      title: "资源标题",
      channel: "source",
      message_id: "",
      datetime: "",
      content: "",
      links: [
        { type: "quark", url: "https://pan.quark.cn/s/example", password: "" },
      ],
    },
  ],
  null,
  2,
);
const pluginCount = new Set(BUILTIN_UPSTREAMS.map((s) => s.plugin)).size;
const countState = (state: string) =>
  sources.value.filter((s) => reports.value[s.id]?.state === state).length;
const testedCount = computed(
  () => sources.value.filter((s) => !!reports.value[s.id]).length,
);
const averageMs = computed(() => {
  const values = sources.value
    .map((s) => reports.value[s.id]?.elapsedMs)
    .filter((x): x is number => typeof x === "number");
  return values.length
    ? Math.round(
        values.reduce((a, b) => a + b, 0) / values.length,
      ).toLocaleString()
    : "—";
});
const filteredSources = computed(() =>
  sources.value.filter(
    (s) =>
      (stateFilter.value === "all" ||
        (reports.value[s.id]?.state || "untested") === stateFilter.value) &&
      `${s.name} ${s.url} ${s.adapter}`
        .toLowerCase()
        .includes(search.value.toLowerCase()),
  ),
);
const requestPreview = computed(() =>
  selected.value.builtin
    ? buildUpstreamRequest(selected.value.id, keyword.value)
    : {
        url: selected.value.url,
        method: selected.value.method,
        body: { keyword: keyword.value },
        note: "配置预览，不会执行",
      },
);
const debugText = computed(() =>
  responseTab.value === "request"
    ? JSON.stringify(requestPreview.value, null, 2)
    : responseTab.value === "raw"
      ? selectedReport.value?.raw || "// 未取得响应体"
      : JSON.stringify(selectedReport.value?.results || [], null, 2),
);
function displayUrl(url: string) {
  return url.replace(/^https?:\/\//, "");
}
function status(id: string) {
  return runningId.value === id
    ? "testing"
    : reports.value[id]?.state || "untested";
}
function statusLabel(id: string) {
  return {
    available: "可用",
    warning: "待确认",
    error: "异常",
    untested: "未检测",
    testing: "检测中",
  }[status(id)];
}
function formatTime(time: string) {
  return new Date(time).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function notify(message: string) {
  notice.value = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.value = ""), 4000);
}
function persist() {
  try {
    const compactReports = Object.fromEntries(
      Object.entries(reports.value).map(([id, r]) => [
        id,
        {
          ...r,
          raw: r.raw.slice(0, 30000),
          rawTruncated: r.rawTruncated || r.raw.length > 30000,
          results: r.results.slice(0, 100),
        },
      ]),
    );
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        drafts: drafts.value,
        overrides: overrides.value,
        enabled: enabled.value,
        reports: compactReports,
      }),
    );
    storageError.value = "";
  } catch {
    storageError.value =
      "浏览器存储不可用或空间不足：当前修改仅保留在本次会话，请勿关闭页面。";
  }
}
function validMapping(value: any): value is AdapterMapping {
  return (
    value &&
    ["items", "title", "url", "type", "password"].every(
      (k) => typeof value[k] === "string" && value[k].length <= 300,
    ) &&
    (!value.linkArray || typeof value.linkArray === "string")
  );
}
onMounted(() => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!saved) return;
    if (Array.isArray(saved.drafts))
      drafts.value = saved.drafts
        .slice(0, 50)
        .filter(
          (s: any) =>
            s &&
            typeof s.id === "string" &&
            s.id.startsWith("custom-") &&
            typeof s.name === "string" &&
            typeof s.url === "string" &&
            ["GET", "POST"].includes(s.method) &&
            ["json", "html"].includes(s.format) &&
            validMapping(s.mapping),
        )
        .map((s: UpstreamDefinition) => ({ ...s, builtin: false }));
    for (const s of BUILTIN_UPSTREAMS) {
      const o = saved.overrides?.[s.id];
      if (o && validMapping(o.mapping))
        overrides.value[s.id] = {
          name: typeof o.name === "string" ? o.name : s.name,
          description:
            typeof o.description === "string" ? o.description : s.description,
          mapping: o.mapping,
        };
    }
    for (const s of sources.value) {
      if (typeof saved.enabled?.[s.id] === "boolean")
        enabled.value[s.id] = saved.enabled[s.id];
      const r = saved.reports?.[s.id];
      if (
        r &&
        r.sourceId === s.id &&
        ["available", "warning", "error"].includes(r.state) &&
        typeof r.raw === "string" &&
        typeof r.elapsedMs === "number" &&
        Array.isArray(r.results) &&
        Array.isArray(r.traces) &&
        typeof r.message === "string"
      )
        reports.value[s.id] = r;
    }
    resetMapping();
  } catch {
    storageError.value =
      "本地配置读取失败，已使用内置接口目录。原存储未被自动覆盖。";
  }
});
function scrollToDetail() {
  if (window.matchMedia("(max-width: 1000px)").matches)
    nextTick(() =>
      document
        .querySelector(".detail-panel")
        ?.scrollIntoView({ behavior: "auto", block: "start" }),
    );
}
function selectSource(id: string) {
  selectedId.value = id;
  deleteArmed.value = false;
  scrollToDetail();
}
function setView(value: typeof view.value) {
  view.value = value;
  detailTab.value =
    value === "sources"
      ? "overview"
      : value === "adapters"
        ? "adapter"
        : "debug";
  if (value !== "sources") scrollToDetail();
}
function tabKeyboard(event: KeyboardEvent, current: typeof detailTab.value) {
  const tabs = ["overview", "debug", "adapter"] as const;
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const index =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? 2
        : (tabs.indexOf(current) + (event.key === "ArrowRight" ? 1 : -1) + 3) %
          3;
  detailTab.value = tabs[index];
  nextTick(() => document.getElementById(`tab-${tabs[index]}`)?.focus());
}
function openEditor(source: UpstreamDefinition | null = null) {
  if (!source && drafts.value.length >= 50) {
    notify("最多保存 50 个自定义草稿。");
    return;
  }
  editingSource.value = source;
  editorOpen.value = true;
}
function saveSource(source: UpstreamDefinition) {
  if (source.builtin)
    overrides.value[source.id] = {
      name: source.name,
      description: source.description,
      mapping: source.mapping,
    };
  else {
    const i = drafts.value.findIndex((s) => s.id === source.id);
    if (i < 0) drafts.value.push(source);
    else drafts.value[i] = source;
  }
  selectedId.value = source.id;
  stateFilter.value = "all";
  search.value = "";
  persist();
  resetMapping();
  notify("配置已保存到当前浏览器，未修改搜索服务。");
}
function toggleEnabled(id: string) {
  enabled.value[id] = enabled.value[id] === false;
  persist();
}
function clearReports() {
  if (!testedCount.value) {
    notify("暂无测试记录。");
    return;
  }
  reports.value = {};
  persist();
  notify("已清除本地测试记录，不会自动重新请求上游。");
}
let disposed = false;
let activeController: AbortController | undefined;
async function testSource(source: UpstreamDefinition, fromBatch = false) {
  if (runningId.value || (!fromBatch && batchRunning.value)) return;
  if (!source.builtin) {
    notify("自定义来源尚未发布，请先使用适配器预览。");
    return;
  }
  if (!keyword.value.trim()) {
    notify("请输入测试关键词。");
    return;
  }
  runningId.value = source.id;
  activeController = new AbortController();
  const timer = setTimeout(() => activeController?.abort(), 16000);
  try {
    const result = await $fetch<UpstreamProbe>("/api/upstreams/probe", {
      method: "POST",
      body: { sourceId: source.id, keyword: keyword.value.trim() },
      signal: activeController.signal,
      retry: 0,
    });
    if (disposed) return;
    reports.value[source.id] = result;
    persist();
    if (!fromBatch) notify(`${source.name}：${result.message}`);
  } catch (error: any) {
    if (!disposed) {
      const code = error?.statusCode || error?.response?.status;
      notify(
        code === 401
          ? "调试需要搜索密码，请返回搜索页完成解锁后重试。"
          : code === 403
            ? "网络调试仅在本地开发模式开放。"
            : `工作台请求未完成：${error?.data?.statusMessage || error.message}。未将其记为上游异常。`,
      );
    }
  } finally {
    clearTimeout(timer);
    runningId.value = "";
    activeController = undefined;
  }
}
async function testAll() {
  if (batchRunning.value || runningId.value) return;
  if (!keyword.value.trim()) {
    notify("请输入测试关键词。");
    return;
  }
  const items = sources.value.filter(
    (s) => s.builtin && enabled.value[s.id] !== false,
  );
  if (!items.length) {
    notify("没有参与批量测试的内置来源。");
    return;
  }
  batchRunning.value = true;
  stopBatch.value = false;
  batchTotal.value = items.length;
  try {
    for (let i = 0; i < items.length; i++) {
      if (stopBatch.value || disposed) break;
      batchIndex.value = i + 1;
      await testSource(items[i], true);
    }
  } finally {
    batchRunning.value = false;
    if (!disposed)
      notify(
        stopBatch.value
          ? "已停止后续测试，当前请求结果已保留。"
          : "批量检测完成，结果已保存。",
      );
  }
}
function resetMapping() {
  mappingDraft.value = { ...selected.value.mapping };
  const example =
    selected.value.adapter === "disk-json"
      ? {
          code: 200,
          data: {
            list: [
              {
                disk_name: "示例资源",
                link: "https://pan.quark.cn/s/example",
                disk_type: "QUARK",
                disk_pass: "1234",
              },
            ],
          },
        }
      : selected.value.id === "jikepan"
        ? {
            list: [
              {
                name: "示例资源",
                links: [
                  {
                    link: "https://pan.quark.cn/s/example",
                    service: "quark",
                    pwd: "1234",
                  },
                ],
              },
            ],
          }
        : selected.value.id === "qupansou"
          ? {
              data: [
                { title: "示例资源", url: "https://pan.quark.cn/s/example" },
              ],
            }
          : {
              data: {
                list: [
                  {
                    title: "示例资源",
                    url: "https://pan.quark.cn/s/example",
                    type: "quark",
                    password: "1234",
                  },
                ],
              },
            };
  sampleJson.value = JSON.stringify(example, null, 2);
  sampleIsLive.value = false;
  mappingPreview.value = null;
  mappingError.value = "";
}
watch(selectedId, resetMapping, { immediate: true });
function loadLastResponse() {
  if (selectedReport.value) {
    sampleJson.value = selectedReport.value.raw;
    sampleIsLive.value = true;
    mappingPreview.value = null;
    mappingError.value = "";
  }
}
function previewMapping() {
  try {
    if (sampleJson.value.length > 200000)
      throw new Error("样本最多 200,000 字符。");
    if (!mappingDraft.value.title.trim() || !mappingDraft.value.url.trim())
      throw new Error("标题和链接字段路径不能为空。");
    mappingPreview.value = normalizeUpstreamJson(
      JSON.parse(sampleJson.value),
      mappingDraft.value,
      selected.value.id,
    );
    mappingError.value = "";
  } catch (error: any) {
    mappingPreview.value = null;
    mappingError.value = error.message;
  }
}
function saveMapping() {
  if (!validMapping(mappingDraft.value)) {
    mappingError.value = "字段路径格式无效或超过长度限制。";
    return;
  }
  previewMapping();
  if (mappingError.value) return;
  const source = { ...selected.value, mapping: { ...mappingDraft.value } };
  if (source.builtin)
    overrides.value[source.id] = {
      name: source.name,
      description: source.description,
      mapping: source.mapping,
    };
  else
    drafts.value = drafts.value.map((s) => (s.id === source.id ? source : s));
  persist();
  notify("映射草稿已保存；在线探测与搜索服务仍使用内置适配器。");
}
function deleteDraft() {
  if (!deleteArmed.value) {
    deleteArmed.value = true;
    return;
  }
  const id = selected.value.id;
  if (selected.value.builtin) return;
  drafts.value = drafts.value.filter((s) => s.id !== id);
  delete reports.value[id];
  selectedId.value = "hunhepan";
  deleteArmed.value = false;
  persist();
  notify("草稿已删除。");
}
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    notify("已复制到剪贴板。");
  } catch {
    notify("无法访问剪贴板，请手动选择并复制。");
  }
}
onBeforeUnmount(() => {
  disposed = true;
  stopBatch.value = true;
  activeController?.abort();
  clearTimeout(noticeTimer);
});
</script>

<style src="../../assets/upstream-console.css"></style>
