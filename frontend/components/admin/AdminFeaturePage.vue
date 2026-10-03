<template>
  <div
    class="admin-page admin-feature-app"
    :data-ready="ready ? 'true' : 'false'"
    :aria-busy="loading"
  >
    <section class="feature-content">
      <p v-if="loading" class="admin-loading" role="status">
        <span class="spinner" />正在加载数据…
      </p>
      <p
        v-if="notice"
        class="feature-notice"
        :class="{ error: noticeIsError }"
        role="status"
      >
        {{ notice }}
      </p>

      <template v-if="feature === 'users'">
        <Card class="query-panel" aria-label="用户查询与操作">
          <form class="query-toolbar" @submit.prevent="runQuery">
            <label class="query-input">
              <ConsoleIcon name="search" :size="16" />
              <Input
                v-model.trim="userQuery"
                type="search"
                placeholder="按用户名查询"
              />
            </label>
            <AdminSelect
              v-model="userStatus"
              class="query-select"
              aria-label="用户状态"
            >
              <option value="">全部状态</option>
              <option value="active">正常</option>
              <option value="disabled">已禁用</option>
            </AdminSelect>
            <div class="query-actions">
              <Button variant="default" class="button primary" type="submit" :disabled="loading || busy"
                ><ConsoleIcon name="search" :size="14" />查询</Button
              >
              <Button
                variant="outline"
                class="button secondary"
                type="button"
                :disabled="loading || busy"
                @click="resetQuery"
                >重置</Button
              >
              <Button
                variant="destructive"
                class="button danger-button"
                type="button"
                :disabled="selectedCount === 0 || busy"
                @click="disableSelectedUsers"
              >
                <ConsoleIcon name="lock" :size="14" />批量禁用<span
                  v-if="selectedCount"
                  class="action-count"
                  >{{ selectedCount }}</span
                >
              </Button>
              <Button
                variant="default"
                class="button primary"
                type="button"
                @click="openCreateUser"
                ><ConsoleIcon name="plus" :size="14" />创建管理员</Button
              >
            </div>
          </form>
          <div class="query-meta">
            已选 {{ selectedCount }} 项 · 共 {{ displayTotal }} 个用户
          </div>
        </Card>

        <Card
          class="sources-panel directory-panel table-panel"
          aria-label="用户列表"
        >
          <div class="table-scroll">
            <Table
              class="source-table directory-table admin-data-table user-table"
            >
              <TableHeader
                ><TableRow>
                  <TableHead class="checkbox-column"
                    ><AdminCheckbox
                      :checked="allCurrentSelected"
                      :indeterminate="someCurrentSelected"
                      aria-label="选择当前页全部用户"
                      @change="toggleAllCurrent"
                  /></TableHead>
                  <TableHead class="serial-column">序号</TableHead
                  ><TableHead>ID</TableHead><TableHead>用户</TableHead
                  ><TableHead>权限</TableHead><TableHead>状态</TableHead
                  ><TableHead>频道</TableHead><TableHead>IP</TableHead
                  ><TableHead>注册时间</TableHead><TableHead>操作</TableHead>
                </TableRow></TableHeader
              >
              <TableBody>
                <TableRow
                  v-for="(item, index) in users"
                  :key="item.id"
                  :class="{ 'selected-row': isSelected(item.id) }"
                >
                  <TableCell class="checkbox-column"
                    ><AdminCheckbox
                      :checked="isSelected(item.id)"
                      :aria-label="`选择用户 ${item.username}`"
                      @change="toggleSelection(item.id)"
                  /></TableCell>
                  <TableCell class="serial-column">{{
                    rowNumber(index)
                  }}</TableCell
                  ><TableCell>{{ item.id }}</TableCell>
                  <TableCell class="source-summary-cell"
                    ><div class="source-text">
                      <div class="source-name">{{ item.username }}</div>
                      <div class="source-description">
                        {{ item.nickname || "未设置昵称" }}
                      </div>
                    </div></TableCell
                  >
                  <TableCell
                    ><span
                      :class="[
                        'role-badge',
                        item.role === 'admin' ? 'admin' : 'user',
                      ]"
                      >{{ item.role === "admin" ? "管理员" : "普通用户" }}</span
                    ></TableCell
                  >
                  <TableCell
                    ><span :class="['status-badge', item.status]">{{
                      item.status === "active" ? "正常" : "已禁用"
                    }}</span></TableCell
                  >
                  <TableCell
                    ><Button
                      variant="outline"
                      class="channel-count-button"
                      type="button"
                      @click="openUserChannels(item)"
                      >{{
                        item.channelCount ?? item.channels?.length ?? 0
                      }}</Button
                    ></TableCell
                  ><TableCell>{{ item.lastLoginIp || "—" }}</TableCell
                  ><TableCell>{{
                    formatTime(item.createdAt ?? item.created_at)
                  }}</TableCell>
                  <TableCell class="action-column"
                    ><AdminRowActions
                      ><Button
                        variant="ghost"
                        size="sm"
                        class="row-action-button"
                        :class="{ 'danger-action': item.status === 'active' }"
                        type="button"
                        :title="item.status === 'active' ? '禁用' : '启用'"
                        :aria-label="`${item.status === 'active' ? '禁用' : '启用'}用户 ${item.username}`"
                        @click="toggleUser(item)"
                        >{{
                          item.status === "active" ? "禁用" : "启用"
                        }}</Button
                      ><Button
                        variant="destructive"
                        size="sm"
                        class="row-action-button danger-action"
                        type="button"
                        title="退出会话"
                        :aria-label="`退出用户 ${item.username} 的会话`"
                        @click="revokeUser(item)"
                        >退出会话</Button
                      ><Button
                        variant="destructive"
                        size="sm"
                        class="row-action-button danger-action"
                        type="button"
                        title="删除"
                        :aria-label="`删除用户 ${item.username}`"
                        @click="deleteUser(item)"
                        >删除</Button
                      ></AdminRowActions
                    ></TableCell
                  >
                </TableRow>
                <TableRow v-if="!loading && !users.length"
                  ><TableCell colspan="10" class="empty-cell"
                    >没有符合条件的用户。</TableCell
                  ></TableRow
                >
              </TableBody>
            </Table>
          </div>
          <AdminPagination
            :page="page"
            :total-pages="pageCount"
            :total="displayTotal"
            :page-size="pageSize"
            :disabled="loading || busy"
            @change="goToPage"
            @update:page-size="changePageSize"
          />
        </Card>

        <template>
          <AdminDialog
            title="创建管理员"
            description="创建可登录后台的管理员账号。普通用户由小程序首次登录自动创建。"
            :busy="busy"
            @close="closeCreateUser"
            v-if="createUserOpen"
          >
            <section class="admin-modal">
              <form
                class="create-user-modal-form admin-dialog-form"
                @submit.prevent="createUser"
              >
                <div class="admin-form-fields">
                  <label class="modal-field"
                    >用户名<Input
                      ref="usernameInput"
                      v-model.trim="newUser.username"
                      required
                      minlength="4"
                      maxlength="32"
                      autocomplete="username"
                      placeholder="至少 4 位字符"
                  /></label>
                  <label class="modal-field"
                    >登录密码<Input
                      v-model="newUser.password"
                      required
                      minlength="6"
                      maxlength="128"
                      type="password"
                      autocomplete="new-password"
                      placeholder="至少 6 位字符"
                  /></label>
                  <label class="modal-field"
                    >昵称<span class="optional-label">可选</span
                    ><Input
                      v-model.trim="newUser.nickname"
                      maxlength="32"
                      autocomplete="nickname"
                      placeholder="请输入昵称"
                  /></label>
                  <p v-if="modalError" class="modal-error" role="alert">
                    <ConsoleIcon name="info" :size="15" />{{ modalError }}
                  </p>
                </div>
                <div class="admin-modal-actions">
                  <Button
                    variant="outline"
                    class="modal-button secondary"
                    type="button"
                    :disabled="busy"
                    @click="closeCreateUser"
                    >取消</Button
                  ><Button
                    variant="default"
                    class="modal-button primary"
                    type="submit"
                    :disabled="busy"
                    >{{ busy ? "创建中…" : "创建管理员" }}</Button
                  >
                </div>
              </form>
            </section>
          </AdminDialog>
        </template>

        <template>
          <AdminDialog
            :title="`${selectedUserChannels?.username || '用户'}的频道`"
            description="查看该账号已保存的自定义频道。"
            @close="closeUserChannels"
            v-if="userChannelsOpen"
          >
            <section class="admin-modal channels-modal">
              <p v-if="userChannelsLoading" class="modal-loading">
                正在读取频道…
              </p>
              <p role="alert" v-else-if="userChannelsError" class="modal-error">
                <ConsoleIcon name="info" :size="14" />{{ userChannelsError }}
              </p>
              <div
                v-else-if="selectedUserChannels?.channels.length"
                class="channel-chip-list"
              >
                <Badge
                  variant="outline"
                  v-for="channel in selectedUserChannels.channels"
                  :key="channel"
                  class="channel-chip"
                  >@{{ channel }}</Badge
                >
              </div>
              <p v-else class="modal-empty">该用户还没有添加自定义频道。</p>
            </section>
          </AdminDialog>
        </template>
      </template>

      <template v-else-if="feature === 'logs'">
        <section class="analytics-strip" aria-label="搜索行为概览">
          <div class="analytics-card">
            <span>搜索次数</span
            ><strong>{{ analytics.overview.searches }}</strong>
          </div>
          <div class="analytics-card">
            <span>有结果</span
            ><strong>{{ analytics.overview.withResults }}</strong>
          </div>
          <div class="analytics-card">
            <span>无结果</span
            ><strong>{{ analytics.overview.noResults }}</strong>
          </div>
          <div class="analytics-card">
            <span>返回资源</span
            ><strong>{{ analytics.overview.resultCount }}</strong>
          </div>
        </section>
        <Card class="query-panel" aria-label="搜索日志查询与操作">
          <form class="query-toolbar" @submit.prevent="runQuery">
            <label class="query-input"
              ><ConsoleIcon name="search" :size="16" /><Input
                v-model.trim="logQuery"
                type="search"
                placeholder="关键词 / 用户 / IP"
            /></label>
            <div class="query-actions">
              <Button variant="default" class="button primary" type="submit" :disabled="loading || busy"
                ><ConsoleIcon name="search" :size="14" />查询</Button
              ><Button
                variant="outline"
                class="button secondary"
                type="button"
                :disabled="loading || busy"
                @click="resetQuery"
                >重置</Button
              ><Button
                variant="destructive"
                class="button danger-button"
                type="button"
                :disabled="selectedCount === 0 || busy"
                @click="deleteSelectedLogs"
                ><ConsoleIcon name="trash" :size="14" />删除选中<span
                  v-if="selectedCount"
                  class="action-count"
                  >{{ selectedCount }}</span
                ></Button
              >
            </div>
          </form>
          <div class="query-meta">
            已选 {{ selectedCount }} 项 · 共 {{ displayTotal }} 条日志
          </div>
        </Card>
        <Card
          class="sources-panel directory-panel table-panel"
          aria-label="搜索日志列表"
        >
          <div class="table-scroll">
            <Table
              class="source-table directory-table admin-data-table log-table"
            >
              <TableHeader
                ><TableRow
                  ><TableHead class="checkbox-column"
                    ><AdminCheckbox
                      :checked="allCurrentSelected"
                      :indeterminate="someCurrentSelected"
                      aria-label="选择当前页全部日志"
                      @change="toggleAllCurrent" /></TableHead
                  ><TableHead class="serial-column">序号</TableHead
                  ><TableHead>时间</TableHead><TableHead>关键词</TableHead
                  ><TableHead>用户</TableHead><TableHead>结果</TableHead
                  ><TableHead>搜索范围</TableHead
                  ><TableHead>操作</TableHead></TableRow
                ></TableHeader
              >
              <TableBody>
                <TableRow
                  v-for="(item, index) in logs"
                  :key="item.id"
                  :class="{ 'selected-row': isSelected(item.id) }"
                  ><TableCell class="checkbox-column"
                    ><AdminCheckbox
                      :checked="isSelected(item.id)"
                      :aria-label="`选择日志 ${item.id}`"
                      @change="toggleSelection(item.id)" /></TableCell
                  ><TableCell class="serial-column">{{
                    rowNumber(index)
                  }}</TableCell
                  ><TableCell>{{
                    formatTime(item.createdAt ?? item.created_at)
                  }}</TableCell
                  ><TableCell class="break-cell">{{
                    item.keyword || item.kw || "—"
                  }}</TableCell
                  ><TableCell>{{
                    item.username || item.userId || "未登录"
                  }}</TableCell
                  ><TableCell>{{ logResultCountLabel(item) }}</TableCell
                  ><TableCell
                    ><Button
                      variant="ghost"
                      v-if="isCustomScope(item)"
                      class="scope-link"
                      type="button"
                      @click="openLogChannels(item)"
                      >自定义频道</Button
                    ><span v-else>{{ searchScopeLabel(item) }}</span></TableCell
                  ><TableCell class="action-column"
                    ><AdminRowActions
                      ><Button
                        variant="ghost"
                        size="sm"
                        class="row-action-button"
                        type="button"
                        aria-label="查看日志详情"
                        title="详情"
                        @click="openLogDetail(item)"
                        >详情</Button
                      ><Button
                        variant="destructive"
                        size="sm"
                        class="row-action-button danger-action"
                        type="button"
                        aria-label="删除日志"
                        title="删除日志"
                        @click="deleteLog(item)"
                        >删除</Button
                      ></AdminRowActions
                    ></TableCell
                  ></TableRow
                >
                <TableRow v-if="!loading && !logs.length"
                  ><TableCell colspan="8" class="empty-cell"
                    >暂无日志数据，或服务端日志接口尚未启用。</TableCell
                  ></TableRow
                >
              </TableBody>
            </Table>
          </div>
          <AdminPagination
            :page="page"
            :total-pages="pageCount"
            :total="displayTotal"
            :page-size="pageSize"
            :disabled="loading || busy"
            @change="goToPage"
            @update:page-size="changePageSize"
          />
        </Card>
        <template>
          <AdminDialog
            title="本次搜索的频道"
            :description="
              selectedLogChannels?.keyword
                ? '关键词：' + selectedLogChannels.keyword
                : undefined
            "
            @close="closeLogChannels"
            v-if="logChannelsOpen"
          >
            <section class="admin-modal channels-modal">
              <div
                v-if="selectedLogChannels?.channels.length"
                class="channel-chip-list"
              >
                <Badge
                  variant="outline"
                  v-for="channel in selectedLogChannels.channels"
                  :key="channel"
                  class="channel-chip"
                  >@{{ channel }}</Badge
                >
              </div>
              <p v-else class="modal-empty">这条日志没有记录具体频道。</p>
            </section>
          </AdminDialog>
        </template>

        <template>
          <AdminDialog
            title="搜索结果详情"
            :description="
              selectedLogDetail
                ? '关键词：' +
                  (selectedLogDetail.keyword || selectedLogDetail.kw || '—') +
                  ' · 共 ' +
                  (selectedLogDetail.resultCount || 0) +
                  ' 条'
                : undefined
            "
            @close="closeLogDetail"
            v-if="logDetailOpen"
          >
            <section class="admin-modal log-detail-modal">
              <div
                v-if="selectedLogSourceCounts.length"
                class="log-source-count-list"
              >
                <div
                  v-for="item in selectedLogSourceCounts"
                  :key="item.sourceId"
                  class="log-source-count-row"
                >
                  <span class="log-source-name">{{ item.sourceId }}</span>
                  <strong>{{ item.count }} 条</strong>
                </div>
              </div>
              <p v-else class="modal-empty">
                这条日志没有记录各来源的结果数量。
              </p>
            </section>
          </AdminDialog>
        </template>
      </template>

      <template v-else>
        <Tabs v-model="activeSettingsTab" class="admin-tabs admin-settings-tabs"
          ><TabsList class="settings-tabs" aria-label="系统设置分类">
            <TabsTrigger
              :value="tab.key"
              v-for="tab in settingsTabs"
              :key="tab.key"
              :id="`settings-tab-${tab.key}`"
              class="settings-tab"
              :class="{ active: activeSettingsTab === tab.key }"
            >
              <strong>{{ tab.label }}</strong>
              <small>{{ tab.description }}</small>
            </TabsTrigger>
          </TabsList></Tabs
        >
        <Card
          v-if="activeSettingsTab === 'search'"
          id="settings-panel-search"
          class="feature-card policy-card settings-tab-panel"
          role="tabpanel"
          aria-labelledby="settings-tab-search"
        >
          <div class="policy-card-header">
            <div class="policy-card-copy">
              <h2 id="system-settings-title">搜索与账号配置</h2>
            </div>
            <div class="policy-card-actions">
              <span class="policy-count">20 个配置项</span>
              <Button
                variant="outline"
                class="refresh-button"
                type="button"
                :disabled="loading"
                @click="loadData()"
              >
                <ConsoleIcon name="refresh" :size="14" />{{
                  loading ? "读取中…" : "刷新数据"
                }}
              </Button>
              <Button
                variant="default"
                class="primary-button"
                type="submit"
                form="system-settings-form"
                :disabled="busy"
                ><ConsoleIcon name="check" :size="14" />{{
                  busy ? "保存中…" : "保存搜索配置"
                }}</Button
              >
            </div>
          </div>
          <form
            id="system-settings-form"
            class="policy-form"
            @submit.prevent="savePolicy"
          >
            <fieldset class="policy-group">
              <legend>账号与首页</legend>
              <div class="policy-form-grid">
                <label class="policy-field policy-toggle"
                  ><Switch v-model="policyForm.showHotSearch" /><span
                    ><strong>展示热门搜索</strong
                    ><small>关闭后首页不加载或展示热门搜索区域。</small></span
                  ></label
                >
                <label class="policy-field policy-toggle"
                  ><Switch v-model="policyForm.anonymousCustomChannels" /><span
                    ><strong>允许匿名用户使用自定义频道</strong
                    ><small>关闭后自定义频道仅微信登录用户可用。</small></span
                  ></label
                >
                <label class="policy-field policy-toggle"
                  ><Switch v-model="policyForm.showAuthButtons" /><span
                    ><strong>是否展示登录按钮</strong
                    ><small
                      >关闭后首页顶栏不再显示登录入口，扫码登录接口同时停用。</small
                    ></span
                  ></label
                >
                <label class="policy-field"
                  ><span
                    ><strong>首页搜索框提示语</strong
                    ><code>homeSearchPlaceholder</code></span
                  ><Input
                    v-model.trim="policyForm.homeSearchPlaceholder"
                    type="text"
                    maxlength="120"
                    required
                    placeholder="搜索电影、剧集、资料等资源…"
                  /><small
                    >只作为输入框提示文字，用户仍可自行输入关键词搜索。</small
                  ></label
                >
              </div>
            </fieldset>
            <fieldset class="policy-group">
              <legend>会话与频道</legend>
              <div class="policy-form-grid">
                <label class="policy-field"
                  ><span
                    ><strong>会话有效天数</strong><code>sessionDays</code></span
                  ><Input
                    v-model.number="policyForm.sessionDays"
                    type="number"
                    min="1"
                    max="365"
                    required
                  /><small>范围：1–365 天</small></label
                >
                <label class="policy-field"
                  ><span
                    ><strong>自定义频道数量上限</strong
                    ><code>customChannelLimit</code></span
                  ><Input
                    v-model.number="policyForm.customChannelLimit"
                    type="number"
                    min="0"
                    max="100"
                    required
                  /><small>范围：0–100 个</small></label
                >
              </div>
            </fieldset>
            <fieldset class="policy-group">
              <legend>搜索运行</legend>
              <div class="policy-form-grid">
                <label class="policy-field"
                  ><span
                    ><strong>默认并发请求数</strong
                    ><code>defaultConcurrency</code></span
                  ><Input
                    v-model.number="policyForm.defaultConcurrency"
                    type="number"
                    min="1"
                    max="16"
                    required
                  /><small>范围：1–16</small></label
                >
                <label class="policy-field"
                  ><span
                    ><strong>请求 / transform 超时</strong
                    ><code>requestTimeoutMs</code></span
                  ><Input
                    v-model.number="policyForm.requestTimeoutMs"
                    type="number"
                    min="1000"
                    max="60000"
                    required
                  /><small>范围：1000–60000 ms</small></label
                >
                <label class="policy-field"
                  ><span
                    ><strong>来源熔断失败次数</strong
                    ><code>circuitBreakerMaxFailures</code></span
                  ><Input
                    v-model.number="policyForm.circuitBreakerMaxFailures"
                    type="number"
                    min="1"
                    max="20"
                    required
                  /><small>范围：1–20 次</small></label
                >
                <label class="policy-field"
                  ><span
                    ><strong>代理节点熔断失败次数</strong
                    ><code>proxyCircuitBreakerMaxFailures</code></span
                  ><Input
                    v-model.number="policyForm.proxyCircuitBreakerMaxFailures"
                    type="number"
                    min="1"
                    max="20"
                    required
                  /><small>范围：1–20 次</small></label
                >
                <label class="policy-field"
                  ><span
                    ><strong>代理节点熔断冷却时间</strong
                    ><code>proxyCircuitBreakerTimeoutSeconds</code></span
                  ><Input
                    v-model.number="
                      policyForm.proxyCircuitBreakerTimeoutSeconds
                    "
                    type="number"
                    min="10"
                    max="3600"
                    required
                  /><small>范围：10–3600 秒</small></label
                >
                <label class="policy-field"
                  ><span
                    ><strong>整次搜索超时</strong
                    ><code>searchTimeoutMs</code></span
                  ><Input
                    v-model.number="policyForm.searchTimeoutMs"
                    type="number"
                    min="1000"
                    max="120000"
                    required
                  /><small>范围：1000–120000 ms</small></label
                >
                <label class="policy-field"
                  ><span
                    ><strong>搜索缓存时长</strong
                    ><code>cacheTtlMinutes</code></span
                  ><Input
                    v-model.number="policyForm.cacheTtlMinutes"
                    type="number"
                    min="1"
                    max="10"
                    required
                  /><small>范围：1–10 分钟</small></label
                >
                <label class="policy-field"
                  ><span
                    ><strong>搜索缓存容量上限</strong
                    ><code>cacheMaxMemoryMb</code></span
                  ><Input
                    v-model.number="policyForm.cacheMaxMemoryMb"
                    type="number"
                    min="16"
                    max="512"
                    required
                  /><small>范围：16–512 MB，调小后按 LRU 立即淘汰</small></label
                >
              </div>
            </fieldset>
            <fieldset class="policy-group">
              <legend>匿名用户搜索限流</legend>
              <div class="policy-form-grid">
                <label class="policy-field"
                  ><span
                    ><strong>限流窗口</strong
                    ><code>anonymousSearchRateLimitWindowSeconds</code></span
                  ><Input
                    v-model.number="
                      policyForm.anonymousSearchRateLimitWindowSeconds
                    "
                    type="number"
                    min="10"
                    max="3600"
                    required
                  /><small>范围：10–3600 秒</small></label
                >
                <label class="policy-field"
                  ><span
                    ><strong>单 Session 上限</strong
                    ><code>anonymousSearchRateLimitPerSession</code></span
                  ><Input
                    v-model.number="
                      policyForm.anonymousSearchRateLimitPerSession
                    "
                    type="number"
                    min="1"
                    max="300"
                    required
                  /><small>范围：1–300 次 / 窗口</small></label
                >
                <label class="policy-field"
                  ><span
                    ><strong>单 IP 上限</strong
                    ><code>anonymousSearchRateLimitPerIp</code></span
                  ><Input
                    v-model.number="policyForm.anonymousSearchRateLimitPerIp"
                    type="number"
                    min="1"
                    max="1000"
                    required
                  /><small>范围：1–1000 次 / 窗口</small></label
                >
                <label class="policy-field"
                  ><span
                    ><strong>单会话并发</strong
                    ><code>anonymousSearchConcurrency</code></span
                  ><Input
                    v-model.number="policyForm.anonymousSearchConcurrency"
                    type="number"
                    min="1"
                    max="16"
                    required
                  /><small>范围：1–16 路 · 同一会话同时在途的搜索数</small></label
                >
              </div>
            </fieldset>
            <fieldset class="policy-group">
              <legend>登录用户搜索限流</legend>
              <div class="policy-form-grid">
                <label class="policy-field"
                  ><span
                    ><strong>限流窗口</strong
                    ><code>loggedSearchRateLimitWindowSeconds</code></span
                  ><Input
                    v-model.number="
                      policyForm.loggedSearchRateLimitWindowSeconds
                    "
                    type="number"
                    min="10"
                    max="3600"
                    required
                  /><small>范围：10–3600 秒</small></label
                >
                <label class="policy-field"
                  ><span
                    ><strong>单 Session 上限</strong
                    ><code>loggedSearchRateLimitPerSession</code></span
                  ><Input
                    v-model.number="policyForm.loggedSearchRateLimitPerSession"
                    type="number"
                    min="1"
                    max="300"
                    required
                  /><small>范围：1–300 次 / 窗口</small></label
                >
                <label class="policy-field"
                  ><span
                    ><strong>单 IP 上限</strong
                    ><code>loggedSearchRateLimitPerIp</code></span
                  ><Input
                    v-model.number="policyForm.loggedSearchRateLimitPerIp"
                    type="number"
                    min="1"
                    max="1000"
                    required
                  /><small>范围：1–1000 次 / 窗口</small></label
                >
                <label class="policy-field"
                  ><span
                    ><strong>单会话并发</strong
                    ><code>loggedSearchConcurrency</code></span
                  ><Input
                    v-model.number="policyForm.loggedSearchConcurrency"
                    type="number"
                    min="1"
                    max="32"
                    required
                  /><small>范围：1–32 路 · 同一会话同时在途的搜索数</small></label
                >
              </div>
            </fieldset>
            <fieldset class="policy-group">
              <legend>全站搜索并发</legend>
              <div class="policy-form-grid">
                <label class="policy-field"
                  ><span
                    ><strong>全站同时在途搜索总数</strong
                    ><code>globalSearchConcurrency</code></span
                  ><Input
                    v-model.number="policyForm.globalSearchConcurrency"
                    type="number"
                    min="8"
                    max="256"
                    required
                  /><small>范围：8–256 路 · 所有匿名 + 登录会话共享的最后防线</small></label
                >
              </div>
            </fieldset>
            <div class="policy-form-actions">
              <Button type="submit" :disabled="busy || loading">{{
                busy ? "保存中…" : "保存配置"
              }}</Button>
            </div>
          </form>
        </Card>
        <Card
          v-else-if="activeSettingsTab === 'wechat'"
          id="settings-panel-wechat"
          class="feature-card admin-account-card settings-tab-panel"
          role="tabpanel"
          aria-labelledby="settings-tab-wechat"
        >
          <div class="policy-card-header">
            <div class="policy-card-copy">
              <h2 id="wechat-mini-title">微信小程序</h2>
              <p>
                网站扫码登录与小程序登录共用这份凭据，保存在数据库里，保存后立即生效，不需要改环境变量或重启服务。
              </p>
            </div>
            <div class="policy-card-actions">
              <span class="policy-count">{{
                wechatSettings.configured ? "已配置" : "未配置"
              }}</span>
            </div>
          </div>
          <form class="admin-account-form" @submit.prevent="saveWechatSettings">
            <label class="policy-field"
              ><span
                ><strong>AppID</strong
                ><small>微信公众平台 → 开发管理 → 开发设置</small></span
              ><Input
                v-model.trim="wechatForm.appId"
                type="text"
                maxlength="64"
                autocomplete="off"
                placeholder="wx 开头的 AppID"
            /></label>
            <label class="policy-field"
              ><span
                ><strong>AppSecret</strong
                ><small>{{ wechatSecretHint }}</small></span
              ><Input
                v-model="wechatForm.secret"
                type="password"
                maxlength="128"
                autocomplete="new-password"
                :placeholder="
                  wechatSettings.secretConfigured
                    ? '留空表示不修改已保存的密钥'
                    : '填写 AppSecret'
                "
            /></label>
            <label class="policy-field"
              ><span
                ><strong>扫码页面</strong
                ><small>小程序码指向的页面，不带前导斜杠</small></span
              ><Input
                v-model.trim="wechatForm.qrPage"
                type="text"
                maxlength="128"
                placeholder="pages/login/index"
            /></label>
            <label class="policy-field"
              ><span
                ><strong>打开版本</strong
                ><small
                  >小程序还没发布时选体验版，否则扫出来的码打不开页面</small
                ></span
              >
              <AdminSelect v-model="wechatForm.envVersion">
                <option value="release">release（正式版）</option>
                <option value="trial">trial（体验版）</option>
                <option value="develop">develop（开发版）</option>
              </AdminSelect>
            </label>
            <div class="admin-account-actions">
              <Button
                variant="default"
                class="primary-button"
                type="submit"
                :disabled="busy"
                ><ConsoleIcon name="check" :size="14" />{{
                  busy ? "保存中…" : "保存微信配置"
                }}</Button
              >
            </div>
          </form>
        </Card>
        <Card
          v-else-if="activeSettingsTab === 'admin'"
          id="settings-panel-admin"
          class="feature-card admin-account-card settings-tab-panel"
          role="tabpanel"
          aria-labelledby="settings-tab-admin"
        >
          <div class="policy-card-header">
            <div class="policy-card-copy">
              <h2 id="admin-account-title">管理员账号</h2>
              <p>修改后台登录用户名或密码。当前会话不会被立即退出。</p>
            </div>
          </div>
          <form class="admin-account-form" @submit.prevent="saveAdminAccount">
            <label class="policy-field"
              ><span
                ><strong>管理员用户名</strong
                ><small>4–32 位字母、数字或下划线</small></span
              ><Input
                v-model="adminAccount.username"
                type="text"
                minlength="4"
                maxlength="32"
                autocomplete="username"
                required
            /></label>
            <label class="policy-field"
              ><span
                ><strong>新密码</strong
                ><small>留空表示保持当前密码不变，至少 6 位</small></span
              ><Input
                v-model="adminAccount.password"
                type="password"
                minlength="6"
                maxlength="128"
                autocomplete="new-password"
                placeholder="不修改密码请留空"
            /></label>
            <label v-if="adminAccount.password" class="policy-field"
              ><span><strong>确认新密码</strong></span
              ><Input
                v-model="adminAccount.confirmPassword"
                type="password"
                minlength="6"
                maxlength="128"
                autocomplete="new-password"
                required
            /></label>
            <div class="admin-account-actions">
              <Button
                variant="default"
                class="primary-button"
                type="submit"
                :disabled="busy || !adminAccount.username"
                ><ConsoleIcon name="check" :size="14" />{{
                  busy ? "保存中…" : "保存管理员账号"
                }}</Button
              >
            </div>
          </form>
        </Card>
      </template>
    </section>
  </div>
</template>

<script setup lang="ts">
import { AdminPageCursors } from "../../lib/adminPageCursors";
import AdminRowActions from "@/components/admin/AdminRowActions.vue";
import { Switch } from "@/components/admin/ui/switch";
import { Card } from "@/components/admin/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/admin/ui/tabs";
import { Button } from "@/components/admin/ui/button";
import { Input } from "@/components/admin/ui/input";
import { Textarea } from "@/components/admin/ui/textarea";
import { Badge } from "@/components/admin/ui/badge";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/admin/ui/table";
import AdminSelect from "@/components/admin/AdminSelect.vue";
import AdminCheckbox from "@/components/admin/AdminCheckbox.vue";
import AdminDialog from "@/components/admin/AdminDialog.vue";
import { useAdminConfirm } from "@/composables/admin/useAdminConfirm";
const { confirm: confirmAction } = useAdminConfirm();
import { useAuth } from "@/composables/useAuth";
const auth = useAuth();
import { useAdminSession } from "@/composables/admin/useAdminSession";
const { locked, authenticated } = useAdminSession();

import { apiFetch } from "../../src/appRuntime";
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { DEFAULT_HOME_SEARCH_PLACEHOLDER } from "~/shared/homeSearch";

import ConsoleIcon from "../sources/ConsoleIcon.vue";

import AdminPagination from "./AdminPagination.vue";
type Feature = "users" | "logs" | "policies";
type AdminUser = {
  id: number;
  username: string;
  nickname?: string | null;
  role?: "admin" | "user";
  status: "active" | "disabled";
  channels?: string[];
  channelCount?: number;
  lastLoginIp?: string | null;
  createdAt?: number;
  created_at?: number;
};
type AdminLog = {
  id: number;
  keyword?: string;
  kw?: string;
  username?: string | null;
  nickname?: string | null;
  userId?: number | null;
  sessionId?: number | string | null;
  ip?: string;
  scope?: string;
  searchScope?: string;
  channels?: string[];
  sourceIds?: string[];
  createdAt?: number | string;
  created_at?: number | string;
  completedAt?: number | string | null;
  status?: string;
  resultCount?: number;
  hasResults?: boolean;
  outcomeRecorded?: boolean;
  sourceResultCounts?: Record<string, number>;
};
type SearchAnalytics = {
  overview: {
    searches: number;
    withResults: number;
    noResults: number;
    resultCount: number;
  };
  sources: Array<{ sourceId: string; resultCount: number }>;
};
type UserPolicy = {
  showHotSearch: boolean;
  anonymousCustomChannels: boolean;
  showAuthButtons: boolean;
  homeSearchPlaceholder: string;
  sessionDays: number;
  customChannelLimit: number;
  defaultConcurrency: number;
  requestTimeoutMs: number;
  circuitBreakerMaxFailures: number;
  proxyCircuitBreakerMaxFailures: number;
  proxyCircuitBreakerTimeoutSeconds: number;
  searchTimeoutMs: number;
  cacheTtlMinutes: number;
  cacheMaxMemoryMb: number;
  anonymousSearchRateLimitWindowSeconds: number;
  anonymousSearchRateLimitPerSession: number;
  anonymousSearchRateLimitPerIp: number;
  loggedSearchRateLimitWindowSeconds: number;
  loggedSearchRateLimitPerSession: number;
  loggedSearchRateLimitPerIp: number;
  anonymousSearchConcurrency: number;
  loggedSearchConcurrency: number;
  globalSearchConcurrency: number;
};

const DEFAULT_POLICY: UserPolicy = {
  showHotSearch: true,
  anonymousCustomChannels: false,
  showAuthButtons: true,
  homeSearchPlaceholder: DEFAULT_HOME_SEARCH_PLACEHOLDER,
  sessionDays: 30,
  customChannelLimit: 10,
  defaultConcurrency: 4,
  requestTimeoutMs: 5000,
  circuitBreakerMaxFailures: 5,
  proxyCircuitBreakerMaxFailures: 3,
  proxyCircuitBreakerTimeoutSeconds: 300,
  searchTimeoutMs: 30000,
  cacheTtlMinutes: 10,
  cacheMaxMemoryMb: 100,
  anonymousSearchRateLimitWindowSeconds: 60,
  anonymousSearchRateLimitPerSession: 20,
  anonymousSearchRateLimitPerIp: 60,
  loggedSearchRateLimitWindowSeconds: 60,
  loggedSearchRateLimitPerSession: 60,
  loggedSearchRateLimitPerIp: 240,
  anonymousSearchConcurrency: 2,
  loggedSearchConcurrency: 4,
  globalSearchConcurrency: 64,
};

const props = defineProps<{ feature: Feature }>();
const feature = computed(() => props.feature);
const settingsTabs = [
  { key: "search", label: "搜索配置", description: "首页与搜索策略" },
  { key: "wechat", label: "微信小程序", description: "登录与小程序码" },
  { key: "admin", label: "管理员账号", description: "登录账号与密码" },
] as const;
type SettingsTab = (typeof settingsTabs)[number]["key"];
const activeSettingsTab = ref<SettingsTab>("search");
const ready = ref(false);
const loading = ref(false);
const busy = ref(false);
const notice = ref("");
const noticeIsError = ref(false);
const users = ref<AdminUser[]>([]);
const logs = ref<AdminLog[]>([]);
const userQuery = ref("");
const userStatus = ref("");
const logQuery = ref("");
const analytics = ref<SearchAnalytics>({
  overview: { searches: 0, withResults: 0, noResults: 0, resultCount: 0 },
  sources: [],
});
const policyForm = ref<UserPolicy>({ ...DEFAULT_POLICY });
const adminAccount = ref({ username: "", password: "", confirmPassword: "" });
type WechatEnvVersion = "release" | "trial" | "develop";
type WechatSettingsView = {
  appId: string;
  qrPage: string;
  envVersion: WechatEnvVersion;
  secretConfigured: boolean;
  secretLength: number;
  configured: boolean;
};
type WechatForm = {
  appId: string;
  secret: string;
  qrPage: string;
  envVersion: WechatEnvVersion;
};
const DEFAULT_WECHAT_SETTINGS: WechatSettingsView = {
  appId: "",
  qrPage: "pages/login/index",
  envVersion: "release",
  secretConfigured: false,
  secretLength: 0,
  configured: false,
};
// `secret` is write-only: it is never sent back, so the form always starts blank
// and an empty field means "keep the stored secret".
const wechatSettings = ref<WechatSettingsView>({ ...DEFAULT_WECHAT_SETTINGS });
const wechatForm = ref<WechatForm>({
  appId: "",
  secret: "",
  qrPage: "pages/login/index",
  envVersion: "release",
});
const wechatSecretHint = computed(() =>
  wechatSettings.value.secretConfigured
    ? `已保存 ${wechatSettings.value.secretLength} 位密钥，留空表示不修改`
    : "与 AppID 配套，仅保存在服务端，保存后不会回显",
);
const newUser = ref({ username: "", password: "", nickname: "" });
const createUserOpen = ref(false);
const modalError = ref("");
const usernameInput = ref<HTMLInputElement | null>(null);
const selectedKeys = ref<string[]>([]);
const page = ref(1);
const pageSize = ref(20);
const total = ref(0);
const userChannelsOpen = ref(false);
const userChannelsLoading = ref(false);
const userChannelsError = ref("");
const selectedUserChannels = ref<{
  username: string;
  channels: string[];
} | null>(null);
const logChannelsOpen = ref(false);
const selectedLogChannels = ref<{ keyword: string; channels: string[] } | null>(
  null,
);
const logDetailOpen = ref(false);
const selectedLogDetail = ref<AdminLog | null>(null);

function statusOf(error: any) {
  return error?.statusCode || error?.response?.status || error?.status;
}
function apiError(error: any): string {
  const status = statusOf(error);
  if (status === 401) return "请先登录管理员账号。";
  if (status === 403) return "当前账号没有管理员权限。";
  if (status === 404) return "服务端接口尚未部署，当前页面先保留入口。";
  return error?.data?.statusMessage || error?.message || "后台请求失败。";
}
function show(message: string, error = false) {
  notice.value = message;
  noticeIsError.value = error;
}
function formatTime(value: unknown) {
  if (value instanceof Date) return value.toLocaleString();
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = Math.abs(value) < 1e12 ? value * 1000 : value;
    return milliseconds > 0 ? new Date(milliseconds).toLocaleString() : "—";
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      const milliseconds = Math.abs(numeric) < 1e12 ? numeric * 1000 : numeric;
      return milliseconds > 0 ? new Date(milliseconds).toLocaleString() : "—";
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : "—";
  }
  return "—";
}
function isCustomScope(item: AdminLog) {
  return (item.scope || item.searchScope) === "custom_channels";
}
function searchScopeLabel(item: AdminLog) {
  return isCustomScope(item) ? "自定义频道" : "本站来源";
}
function logResultCountLabel(item: AdminLog) {
  const status = String(item.status || "completed").toLowerCase();
  if (status === "started" || status === "running" || status === "pending")
    return "进行中";
  if (status === "failed" || status === "error") return "失败";
  const count = Number(item.resultCount);
  if (
    Number.isFinite(count) &&
    count >= 0 &&
    (item.outcomeRecorded !== false ||
      status === "completed" ||
      item.hasResults !== undefined)
  ) {
    return `${Math.max(0, Math.trunc(count))} 条`;
  }
  return "未统计";
}
function unwrap<T>(result: any, key: string): T {
  return result?.[key] ?? result?.data?.[key] ?? result?.data ?? result;
}
function normalizeAnalytics(value: any): SearchAnalytics {
  const input = value && typeof value === "object" ? value : {};
  const overview =
    input.overview && typeof input.overview === "object" ? input.overview : {};
  return {
    overview: {
      searches: Number(overview.searches ?? input.total ?? 0),
      withResults: Number(overview.withResults ?? 0),
      noResults: Number(overview.noResults ?? 0),
      resultCount: Number(overview.resultCount ?? 0),
    },
    sources: Array.isArray(input.sources) ? input.sources : [],
  };
}
const displayTotal = computed(() => total.value);
const pageCount = computed(() =>
  Math.max(1, Math.ceil(displayTotal.value / pageSize.value)),
);
const currentRowKeys = computed(() =>
  props.feature === "users"
    ? users.value.map((item) => String(item.id))
    : props.feature === "logs"
      ? logs.value.map((item) => String(item.id))
      : [],
);
const selectedLogSourceCounts = computed(() =>
  Object.entries(selectedLogDetail.value?.sourceResultCounts || {})
    .map(([sourceId, count]) => ({
      sourceId,
      count: Math.max(0, Number(count) || 0),
    }))
    .sort(
      (left, right) =>
        right.count - left.count || left.sourceId.localeCompare(right.sourceId),
    ),
);
const selectedCount = computed(() => selectedKeys.value.length);
const allCurrentSelected = computed(
  () =>
    currentRowKeys.value.length > 0 &&
    currentRowKeys.value.every((key) => selectedKeys.value.includes(key)),
);
const someCurrentSelected = computed(
  () =>
    currentRowKeys.value.some((key) => selectedKeys.value.includes(key)) &&
    !allCurrentSelected.value,
);

function rowNumber(index: number) {
  return (page.value - 1) * pageSize.value + index + 1;
}
function isSelected(id: string | number) {
  return selectedKeys.value.includes(String(id));
}
function toggleSelection(id: string | number) {
  const key = String(id);
  selectedKeys.value = isSelected(key)
    ? selectedKeys.value.filter((item) => item !== key)
    : [...selectedKeys.value, key];
}
function toggleAllCurrent(event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  const current = currentRowKeys.value;
  selectedKeys.value = checked
    ? [...new Set([...selectedKeys.value, ...current])]
    : selectedKeys.value.filter((key) => !current.includes(key));
}
function clearSelection() {
  selectedKeys.value = [];
}

const logPageCursors = new AdminPageCursors();
async function loadData(continuePage = false) {
  if (locked.value || loading.value) return;
  if (!continuePage) logPageCursors.clear();
  loading.value = true;
  show("");
  try {
    if (props.feature === "users") {
      const result = await apiFetch<any>("/api/admin/users", {
        query: {
          q: userQuery.value || undefined,
          status: userStatus.value || undefined,
          page: page.value,
          pageSize: pageSize.value,
        },
        cache: "no-store",
      });
      const data = result?.data ?? result;
      users.value = (data.users || data.items || []).map((item: AdminUser) => ({
        ...item,
        channelCount: item.channelCount ?? item.channels?.length,
      }));
      total.value = Number(data.total || users.value.length);
      page.value = Number(data.page || page.value);
    } else if (props.feature === "logs") {
      const [result, analyticsResult] = await Promise.all([
        apiFetch<any>("/api/admin/search-logs", {
          query: {
            q: logQuery.value || undefined,
            ...logPageCursors.query(page.value, pageSize.value, [logQuery.value]),
          },
          cache: "no-store",
        }),
        apiFetch<any>("/api/admin/search-analytics", { cache: "no-store" }),
      ]);
      const data = result?.data ?? result;
      logPageCursors.remember(page.value, data.nextCursor);
      logs.value = data.logs || data.items || [];
      total.value = Number(data.total || logs.value.length);
      page.value = Number(data.page || page.value);
      analytics.value = normalizeAnalytics(analyticsResult?.data);
    } else {
      const [
        policyResult,
        accountResult,
        wechatResult,
      ] = await Promise.all([
        apiFetch<any>("/api/settings/user-policy", { cache: "no-store" }),
        apiFetch<any>("/api/admin/account", { cache: "no-store" }),
        apiFetch<any>("/api/settings/wechat", { cache: "no-store" }),
      ]);
      const loadedPolicy = normalizePolicy(
        unwrap<Partial<UserPolicy>>(policyResult, "policy"),
      );
      // Rust responses expose the account under data.account; keep the
      // user fallback because older deployments returned data.user.
      const accountPayload = accountResult?.data ?? accountResult ?? {};
      const loadedAccount = (accountPayload.account ??
        accountPayload.user ??
        {}) as { username?: string };
      const loadedWechat = normalizeWechatSettings(
        unwrap<Partial<WechatSettingsView>>(wechatResult, "wechat"),
      );
      policyForm.value = loadedPolicy;
      adminAccount.value = {
        username: String(loadedAccount.username || ""),
        password: "",
        confirmPassword: "",
      };
      auth.showHotSearch.value = loadedPolicy.showHotSearch;
      auth.showAuthButtons.value = loadedPolicy.showAuthButtons;
      auth.homeSearchPlaceholder.value = loadedPolicy.homeSearchPlaceholder;
      wechatSettings.value = loadedWechat;
      wechatForm.value = {
        appId: loadedWechat.appId,
        secret: "",
        qrPage: loadedWechat.qrPage,
        envVersion: loadedWechat.envVersion,
      };
    }
  } catch (error: any) {
    if ([401, 403].includes(statusOf(error))) {
      authenticated.value = false;
      locked.value = true;
    }
    show(apiError(error), true);
  } finally {
    loading.value = false;
  }
}
function runQuery() {
  if (loading.value || busy.value) return;
  page.value = 1;
  clearSelection();
  void loadData();
}
function resetQuery() {
  if (loading.value || busy.value) return;
  userQuery.value = "";
  userStatus.value = "";
  logQuery.value = "";
  runQuery();
}
function goToPage(nextPage: number) {
  if (loading.value || busy.value) return;
  if (nextPage < 1 || nextPage > pageCount.value || nextPage === page.value)
    return;
  page.value = nextPage;
  clearSelection();
  void loadData(true);
}
function changePageSize(size: number) {
  if (loading.value || busy.value) return;
  pageSize.value = size;
  page.value = 1;
  clearSelection();
  void loadData();
}

function openCreateUser() {
  if (busy.value) return;
  newUser.value = { username: "", password: "", nickname: "" };
  modalError.value = "";
  createUserOpen.value = true;
}
function closeCreateUser() {
  if (!busy.value) createUserOpen.value = false;
}

async function createUser() {
  if (busy.value) return;
  busy.value = true;
  try {
    await apiFetch("/api/admin/users", { method: "POST", body: newUser.value });
    newUser.value = { username: "", password: "", nickname: "" };
    modalError.value = "";
    createUserOpen.value = false;
    show("管理员已创建。");
    await loadData();
  } catch (error: any) {
    modalError.value = apiError(error);
    if (statusOf(error) === 401) locked.value = true;
  } finally {
    busy.value = false;
  }
}
async function openUserChannels(item: AdminUser) {
  userChannelsOpen.value = true;
  userChannelsLoading.value = true;
  userChannelsError.value = "";
  selectedUserChannels.value = { username: item.username, channels: [] };
  try {
    const result = await apiFetch<any>(
      `/api/admin/users/${encodeURIComponent(String(item.id))}/channels`,
      { cache: "no-store" },
    );
    const data = unwrap<{ username?: string; channels?: string[] }>(
      result,
      "data",
    );
    selectedUserChannels.value = {
      username: data.username || item.username,
      channels: data.channels || [],
    };
  } catch (error: any) {
    userChannelsError.value = apiError(error);
  } finally {
    userChannelsLoading.value = false;
  }
}
function closeUserChannels() {
  if (!userChannelsLoading.value) userChannelsOpen.value = false;
}
function openLogChannels(item: AdminLog) {
  selectedLogChannels.value = {
    keyword: item.keyword || item.kw || "—",
    channels: item.channels || [],
  };
  logChannelsOpen.value = true;
}
function closeLogChannels() {
  logChannelsOpen.value = false;
}
function openLogDetail(item: AdminLog) {
  selectedLogDetail.value = item;
  logDetailOpen.value = true;
}
function closeLogDetail() {
  logDetailOpen.value = false;
  selectedLogDetail.value = null;
}
async function userAction(item: AdminUser, action: string) {
  if (busy.value) return;
  busy.value = true;
  try {
    const id = encodeURIComponent(String(item.id));
    const method =
      action === "delete" || action === "sessions" ? "DELETE" : "POST";
    const path =
      action === "delete"
        ? `/api/admin/users/${id}`
        : `/api/admin/users/${id}/${action}`;
    await apiFetch(path, { method });
    show(action === "delete" ? "用户已移入回收状态。" : "操作已完成。");
    await loadData();
  } catch (error: any) {
    show(apiError(error), true);
  } finally {
    busy.value = false;
  }
}
async function toggleUser(item: AdminUser) {
  await userAction(item, item.status === "active" ? "disable" : "enable");
}
async function revokeUser(item: AdminUser) {
  await userAction(item, "sessions");
}
async function deleteUser(item: AdminUser) {
  if (
    busy.value ||
    typeof window === "undefined" ||
    !(await confirmAction(
      `确定将用户「${item.username}」移入回收状态吗？该用户会被禁用并注销会话。`,
    ))
  )
    return;
  await userAction(item, "delete");
}
async function disableSelectedUsers() {
  if (
    !selectedCount.value ||
    typeof window === "undefined" ||
    !(await confirmAction(`确定禁用选中的 ${selectedCount.value} 个用户吗？`))
  )
    return;
  busy.value = true;
  try {
    await Promise.all(
      selectedKeys.value.map((id) =>
        apiFetch(`/api/admin/users/${encodeURIComponent(id)}/disable`, {
          method: "POST",
        }),
      ),
    );
    clearSelection();
    show("选中用户已禁用。");
    await loadData();
  } catch (error: any) {
    show(apiError(error), true);
  } finally {
    busy.value = false;
  }
}
async function deleteSelectedLogs() {
  if (
    !selectedCount.value ||
    typeof window === "undefined" ||
    !(await confirmAction(
      `确定删除选中的 ${selectedCount.value} 条日志吗？删除后不可恢复。`,
    ))
  )
    return;
  busy.value = true;
  try {
    await apiFetch<unknown>("/api/admin/search-logs" as string, {
      method: "DELETE",
      body: { ids: selectedKeys.value.map(Number) },
    });
    clearSelection();
    page.value = Math.min(
      page.value,
      Math.max(
        1,
        Math.ceil((total.value - selectedCount.value) / pageSize.value),
      ),
    );
    show("选中日志已删除。");
    await loadData();
  } catch (error: any) {
    show(apiError(error), true);
  } finally {
    busy.value = false;
  }
}
async function deleteLog(item: AdminLog) {
  if (
    busy.value ||
    typeof window === "undefined" ||
    !(await confirmAction("确定删除这条搜索日志吗？删除后不可恢复。"))
  )
    return;
  busy.value = true;
  try {
    await apiFetch<unknown>("/api/admin/search-logs" as string, {
      method: "DELETE",
      body: { ids: [item.id] },
    });
    clearSelection();
    page.value = Math.min(
      page.value,
      Math.max(1, Math.ceil((total.value - 1) / pageSize.value)),
    );
    show("日志已删除。");
    await loadData();
  } catch (error: any) {
    show(apiError(error), true);
  } finally {
    busy.value = false;
  }
}

function normalizePolicy(value: unknown): UserPolicy {
  const input =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Partial<UserPolicy>)
      : {};
  return {
    showHotSearch:
      typeof input.showHotSearch === "boolean"
        ? input.showHotSearch
        : DEFAULT_POLICY.showHotSearch,
    anonymousCustomChannels:
      typeof input.anonymousCustomChannels === "boolean"
        ? input.anonymousCustomChannels
        : DEFAULT_POLICY.anonymousCustomChannels,
    showAuthButtons:
      typeof input.showAuthButtons === "boolean"
        ? input.showAuthButtons
        : DEFAULT_POLICY.showAuthButtons,
    homeSearchPlaceholder:
      typeof input.homeSearchPlaceholder === "string" &&
      input.homeSearchPlaceholder.trim()
        ? input.homeSearchPlaceholder.trim()
        : DEFAULT_POLICY.homeSearchPlaceholder,
    sessionDays:
      typeof input.sessionDays === "number" &&
      Number.isInteger(input.sessionDays)
        ? input.sessionDays
        : DEFAULT_POLICY.sessionDays,
    customChannelLimit:
      typeof input.customChannelLimit === "number" &&
      Number.isInteger(input.customChannelLimit)
        ? input.customChannelLimit
        : DEFAULT_POLICY.customChannelLimit,
    defaultConcurrency:
      typeof input.defaultConcurrency === "number" &&
      Number.isInteger(input.defaultConcurrency)
        ? input.defaultConcurrency
        : DEFAULT_POLICY.defaultConcurrency,
    requestTimeoutMs:
      typeof input.requestTimeoutMs === "number" &&
      Number.isInteger(input.requestTimeoutMs)
        ? input.requestTimeoutMs
        : DEFAULT_POLICY.requestTimeoutMs,
    circuitBreakerMaxFailures:
      typeof input.circuitBreakerMaxFailures === "number" &&
      Number.isInteger(input.circuitBreakerMaxFailures)
        ? input.circuitBreakerMaxFailures
        : DEFAULT_POLICY.circuitBreakerMaxFailures,
    proxyCircuitBreakerMaxFailures:
      typeof input.proxyCircuitBreakerMaxFailures === "number" &&
      Number.isInteger(input.proxyCircuitBreakerMaxFailures)
        ? input.proxyCircuitBreakerMaxFailures
        : DEFAULT_POLICY.proxyCircuitBreakerMaxFailures,
    proxyCircuitBreakerTimeoutSeconds:
      typeof input.proxyCircuitBreakerTimeoutSeconds === "number" &&
      Number.isInteger(input.proxyCircuitBreakerTimeoutSeconds)
        ? input.proxyCircuitBreakerTimeoutSeconds
        : DEFAULT_POLICY.proxyCircuitBreakerTimeoutSeconds,
    searchTimeoutMs:
      typeof input.searchTimeoutMs === "number" &&
      Number.isInteger(input.searchTimeoutMs)
        ? input.searchTimeoutMs
        : DEFAULT_POLICY.searchTimeoutMs,
    cacheTtlMinutes:
      typeof input.cacheTtlMinutes === "number" &&
      Number.isInteger(input.cacheTtlMinutes)
        ? input.cacheTtlMinutes
        : DEFAULT_POLICY.cacheTtlMinutes,
    cacheMaxMemoryMb:
      typeof input.cacheMaxMemoryMb === "number" &&
      Number.isInteger(input.cacheMaxMemoryMb)
        ? input.cacheMaxMemoryMb
        : DEFAULT_POLICY.cacheMaxMemoryMb,
    anonymousSearchRateLimitWindowSeconds:
      typeof input.anonymousSearchRateLimitWindowSeconds === "number" &&
      Number.isInteger(input.anonymousSearchRateLimitWindowSeconds)
        ? input.anonymousSearchRateLimitWindowSeconds
        : DEFAULT_POLICY.anonymousSearchRateLimitWindowSeconds,
    anonymousSearchRateLimitPerSession:
      typeof input.anonymousSearchRateLimitPerSession === "number" &&
      Number.isInteger(input.anonymousSearchRateLimitPerSession)
        ? input.anonymousSearchRateLimitPerSession
        : DEFAULT_POLICY.anonymousSearchRateLimitPerSession,
    anonymousSearchRateLimitPerIp:
      typeof input.anonymousSearchRateLimitPerIp === "number" &&
      Number.isInteger(input.anonymousSearchRateLimitPerIp)
        ? input.anonymousSearchRateLimitPerIp
        : DEFAULT_POLICY.anonymousSearchRateLimitPerIp,
    loggedSearchRateLimitWindowSeconds:
      typeof input.loggedSearchRateLimitWindowSeconds === "number" &&
      Number.isInteger(input.loggedSearchRateLimitWindowSeconds)
        ? input.loggedSearchRateLimitWindowSeconds
        : DEFAULT_POLICY.loggedSearchRateLimitWindowSeconds,
    loggedSearchRateLimitPerSession:
      typeof input.loggedSearchRateLimitPerSession === "number" &&
      Number.isInteger(input.loggedSearchRateLimitPerSession)
        ? input.loggedSearchRateLimitPerSession
        : DEFAULT_POLICY.loggedSearchRateLimitPerSession,
    loggedSearchRateLimitPerIp:
      typeof input.loggedSearchRateLimitPerIp === "number" &&
      Number.isInteger(input.loggedSearchRateLimitPerIp)
        ? input.loggedSearchRateLimitPerIp
        : DEFAULT_POLICY.loggedSearchRateLimitPerIp,
    anonymousSearchConcurrency:
      typeof input.anonymousSearchConcurrency === "number" &&
      Number.isInteger(input.anonymousSearchConcurrency)
        ? input.anonymousSearchConcurrency
        : DEFAULT_POLICY.anonymousSearchConcurrency,
    loggedSearchConcurrency:
      typeof input.loggedSearchConcurrency === "number" &&
      Number.isInteger(input.loggedSearchConcurrency)
        ? input.loggedSearchConcurrency
        : DEFAULT_POLICY.loggedSearchConcurrency,
    globalSearchConcurrency:
      typeof input.globalSearchConcurrency === "number" &&
      Number.isInteger(input.globalSearchConcurrency)
        ? input.globalSearchConcurrency
        : DEFAULT_POLICY.globalSearchConcurrency,
  };
}

function normalizeWechatSettings(value: unknown): WechatSettingsView {
  const input =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Partial<WechatSettingsView>)
      : {};
  const envVersion =
    input.envVersion === "trial" || input.envVersion === "develop"
      ? input.envVersion
      : "release";
  return {
    appId:
      typeof input.appId === "string"
        ? input.appId
        : DEFAULT_WECHAT_SETTINGS.appId,
    qrPage:
      typeof input.qrPage === "string" && input.qrPage
        ? input.qrPage
        : DEFAULT_WECHAT_SETTINGS.qrPage,
    envVersion,
    secretConfigured: input.secretConfigured === true,
    secretLength:
      typeof input.secretLength === "number" ? input.secretLength : 0,
    configured: input.configured === true,
  };
}

async function savePolicy() {
  if (busy.value) return;
  busy.value = true;
  try {
    const result = await apiFetch<any>("/api/settings/user-policy", {
      method: "PUT",
      body: policyForm.value,
    });
    const savedPolicy = normalizePolicy(
      unwrap<Partial<UserPolicy>>(result, "policy"),
    );
    policyForm.value = savedPolicy;
    auth.showHotSearch.value = savedPolicy.showHotSearch;
    auth.showAuthButtons.value = savedPolicy.showAuthButtons;
    auth.homeSearchPlaceholder.value = savedPolicy.homeSearchPlaceholder;
    show("搜索配置已保存。");
  } catch (error: any) {
    show(apiError(error), true);
  } finally {
    busy.value = false;
  }
}

async function saveWechatSettings() {
  if (busy.value) return;
  busy.value = true;
  try {
    const result = await apiFetch<any>("/api/settings/wechat", {
      method: "PUT",
      body: {
        appId: wechatForm.value.appId,
        // An empty field means "keep the stored secret"; the API never returns
        // the current value, so the console cannot send it back unchanged.
        secret: wechatForm.value.secret || undefined,
        qrPage: wechatForm.value.qrPage,
        envVersion: wechatForm.value.envVersion,
      },
    });
    const saved = normalizeWechatSettings(
      unwrap<Partial<WechatSettingsView>>(result, "wechat"),
    );
    wechatSettings.value = saved;
    wechatForm.value = {
      appId: saved.appId,
      secret: "",
      qrPage: saved.qrPage,
      envVersion: saved.envVersion,
    };
    show(
      saved.configured
        ? "微信配置已保存，扫码登录与小程序登录立即生效。"
        : "已保存，但 AppID 或 AppSecret 仍为空，微信登录暂不可用。",
    );
  } catch (error: any) {
    show(apiError(error), true);
  } finally {
    busy.value = false;
  }
}

async function saveAdminAccount() {
  if (busy.value) return;
  if (
    adminAccount.value.password &&
    adminAccount.value.password !== adminAccount.value.confirmPassword
  ) {
    show("两次输入的新密码不一致。", true);
    return;
  }
  busy.value = true;
  try {
    const result = await apiFetch<any>("/api/admin/account", {
      method: "PUT",
      body: {
        username: adminAccount.value.username,
        password: adminAccount.value.password || undefined,
      },
    });
    const saved = unwrap<{ username?: string }>(result, "account");
    adminAccount.value = {
      username: String(saved.username || adminAccount.value.username),
      password: "",
      confirmPassword: "",
    };
    if (auth.user.value && saved.username)
      auth.user.value = { ...auth.user.value, username: saved.username };
    show("管理员账号已保存，新的用户名和密码可用于下次登录。");
  } catch (error: any) {
    show(apiError(error), true);
  } finally {
    busy.value = false;
  }
}

watch(createUserOpen, (open) => {
  if (open) void nextTick(() => usernameInput.value?.focus());
});
watch(pageCount, (count) => {
  if (page.value > count) page.value = count;
});
onMounted(() => {
  ready.value = true;
  void loadData();
});
</script>

<style scoped>
@layer components {
  .analytics-strip {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 10px;
    margin-bottom: 16px;
  }
  .analytics-card {
    display: flex;
    min-height: 72px;
    flex-direction: column;
    justify-content: center;
    gap: 5px;
    padding: 12px 15px;
    border: 1px solid #dfe7f1;
    border-radius: 12px;
    background: #fff;
    box-shadow: 0 8px 22px rgba(40, 62, 92, 0.05);
  }
  .analytics-card span {
    color: #8591a2;
    font-size: 11px;
  }
  .analytics-card strong {
    color: #1f2937;
    font-size: 21px;
    font-variant-numeric: tabular-nums;
  }
  .analytics-table-panel {
    margin-bottom: 16px;
  }
  .analytics-section-heading {
    display: flex;
    align-items: center;
    min-height: 64px;
    padding: 12px 16px;
    border-bottom: 1px solid #edf1f6;
    background: #fbfcfe;
  }
  .analytics-section-heading h2 {
    margin: 0 0 4px;
    color: #1f2937;
    font-size: 14px;
  }
  .analytics-section-heading p {
    margin: 0;
    color: #8591a2;
    font-size: 11px;
  }
  .conversion-cell {
    color: #2563eb !important;
    font-weight: 750;
    font-variant-numeric: tabular-nums;
  }
  .analytics-source-table {
    min-width: 760px !important;
  }
  .analytics-table-scroll {
    max-height: 360px;
  }
  .action-count {
    min-width: 17px;
    padding: 1px 5px;
    border-radius: 99px;
    color: currentColor;
    background: rgba(255, 255, 255, 0.35);
    font-size: 10px;
    text-align: center;
  }
  /* Keep feature tables on the exact visual baseline used by 来源管理. */
  .break-cell {
    max-width: 280px;
    overflow-wrap: anywhere;
  }
  .user-avatar-cell {
    color: #468bb7;
    background: #edf7fb;
  }
  .user-avatar-cell svg {
    width: 18px;
    height: 18px;
  }
  .log-source-count-list {
    display: grid;
    gap: 8px;
    padding-top: 22px;
  }
  .log-source-count-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 11px 13px;
    border: 1px solid #e5edf7;
    border-radius: 9px;
    background: #f8fbff;
  }
  .log-source-name {
    min-width: 0;
    overflow-wrap: anywhere;
    color: #334155;
    font-size: 12px;
  }
  .log-source-count-row strong {
    flex: 0 0 auto;
    color: #1d4ed8;
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }

  .user-table th:nth-child(1),
  .user-table td:nth-child(1) {
    width: 42px;
  }
  .user-table th:nth-child(2),
  .user-table td:nth-child(2) {
    width: 58px;
  }
  .user-table th:nth-child(3),
  .user-table td:nth-child(3) {
    width: 9%;
  }
  .user-table th:nth-child(4),
  .user-table td:nth-child(4) {
    width: 20%;
  }
  .user-table th:nth-child(5),
  .user-table td:nth-child(5) {
    width: 10%;
  }
  .user-table th:nth-child(6),
  .user-table td:nth-child(6) {
    width: 10%;
  }
  .user-table th:nth-child(7),
  .user-table td:nth-child(7) {
    width: 9%;
  }
  .user-table th:nth-child(8),
  .user-table td:nth-child(8) {
    width: 13%;
  }
  .user-table th:nth-child(9),
  .user-table td:nth-child(9) {
    width: 17%;
  }
  .user-table th:nth-child(10),
  .user-table td:nth-child(10) {
    width: 22%;
  }
  .log-table th:nth-child(1),
  .log-table td:nth-child(1) {
    width: 42px;
  }
  .log-table th:nth-child(2),
  .log-table td:nth-child(2) {
    width: 58px;
  }
  .log-table th:nth-child(3),
  .log-table td:nth-child(3) {
    width: 16%;
  }
  .log-table th:nth-child(4),
  .log-table td:nth-child(4) {
    width: 18%;
  }
  .log-table th:nth-child(5),
  .log-table td:nth-child(5) {
    width: 13%;
  }
  .log-table th:nth-child(6),
  .log-table td:nth-child(6) {
    width: 12%;
  }
  .log-table th:nth-child(7),
  .log-table td:nth-child(7) {
    width: 12%;
  }
  .log-table th:nth-child(8),
  .log-table td:nth-child(8) {
    width: 16%;
  }
  .log-table {
    min-width: 1120px !important;
  }
  .log-table th:nth-child(9),
  .log-table td:nth-child(9) {
    width: 13%;
  }
  .log-table th:nth-child(10),
  .log-table td:nth-child(10) {
    width: 9%;
  }
  .policy-table th:nth-child(1),
  .policy-table td:nth-child(1) {
    width: 42px;
  }
  .policy-table th:nth-child(2),
  .policy-table td:nth-child(2) {
    width: 58px;
  }
  .policy-table th:nth-child(3),
  .policy-table td:nth-child(3) {
    width: 25%;
  }
  .policy-table th:nth-child(4),
  .policy-table td:nth-child(4) {
    width: 16%;
  }
  .policy-table th:nth-child(5),
  .policy-table td:nth-child(5) {
    width: 39%;
  }
  .policy-table th:nth-child(6),
  .policy-table td:nth-child(6) {
    width: 20%;
  }
  .user-list-actions {
    display: flex;
    align-items: center;
    gap: 9px;
  }
  .create-user-modal-form {
    display: flex;
    flex-direction: column;
    gap: 15px;
    padding-top: 20px;
  }
  .optional-label {
    margin-left: 5px;
    color: #94a3b8;
    font-size: 11px;
    font-weight: 400;
  }
  @media (max-width: 820px) {
    .analytics-strip {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  .cloud-account-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
    margin-top: 21px;
  }
  .cloud-provider-card {
    min-width: 0;
    padding: 20px;
    border: 1px solid var(--border);
    border-radius: 13px;
    background: var(--card);
  }
  .cloud-provider-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }
  .cloud-provider-heading h3 {
    margin: 0;
    color: var(--foreground);
    font-size: 16px;
  }
  .cloud-provider-heading p {
    margin: 5px 0 0;
    color: var(--muted-foreground);
    font-size: 13px;
    line-height: 1.6;
  }
  .cloud-provider-card .admin-account-form {
    grid-template-columns: 1fr;
    margin-top: 16px;
  }
  .cloud-provider-card .admin-account-form .policy-field:last-of-type {
    grid-column: auto;
  }
  .cloud-credentials { margin-top: 12px; }
  .cloud-credentials summary { min-height: 44px; display: flex; align-items: center; gap: 8px; cursor: pointer; color: var(--foreground); font-size: 14px; }
  .cloud-credentials summary::before { content: '›'; }
  .cloud-credentials[open] summary::before { content: '⌄'; }
  .cloud-credentials summary:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; border-radius: 4px; }
  .cloud-provider-card .admin-account-actions { flex-wrap: wrap; }
  .cloud-provider-card .admin-account-actions button { min-height: 44px; }
  @media (max-width: 700px) {
    .cloud-account-grid {
      grid-template-columns: 1fr;
    }
  }
  @keyframes settings-panel-in {
    from {
      opacity: 0.5;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
}
</style>
