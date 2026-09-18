<template>
  <div class="source-app admin-feature-app" :data-ready="ready ? 'true' : 'false'">
    <AdminAccessGate
      v-if="checking || locked"
      :checking="checking"
      :authenticated="authenticated"
      :error="authError"
      title="进入管理后台"
      @authenticated="checkStatus" />

    <template v-else>
      <aside class="console-sidebar">
        <NuxtLink to="/" class="console-brand">
          <span class="brand-symbol"><ConsoleIcon name="box" :size="22" /></span>PanHub
          <span class="brand-tag">CONSOLE</span>
        </NuxtLink>
        <nav aria-label="后台导航">
          <NuxtLink to="/admin/monitor" class="console-nav-link"><ConsoleIcon name="activity" />运行监控</NuxtLink>
          <NuxtLink to="/admin/sources" class="console-nav-link"><ConsoleIcon name="box" />来源管理</NuxtLink>
          <NuxtLink to="/admin/proxies" class="console-nav-link"><ConsoleIcon name="globe" />代理节点</NuxtLink>
          <NuxtLink to="/admin/resources" :class="['console-nav-link', { active: (feature as string) === 'resources' }]" ><ConsoleIcon name="box" />网盘资源</NuxtLink>
          <NuxtLink to="/admin/hot-searches" class="console-nav-link"><ConsoleIcon name="search" />热门搜索</NuxtLink>
          <NuxtLink to="/admin/users" :class="['console-nav-link', { active: feature === 'users' }]"><ConsoleIcon name="user" />用户管理</NuxtLink>
          <NuxtLink to="/admin/logs" :class="['console-nav-link', { active: feature === 'logs' }]"><ConsoleIcon name="activity" />搜索日志</NuxtLink>
          <NuxtLink to="/admin/policies" :class="['console-nav-link', { active: feature === 'policies' }]"><ConsoleIcon name="sliders" />系统设置</NuxtLink>
        </nav>
      </aside>

      <div class="console-body">
        <header class="console-topbar">
          <div class="breadcrumbs">
            <ConsoleIcon name="grid" :size="16" /><span>管理后台</span>
            <ConsoleIcon name="chevron" :size="13" /><strong>{{ title }}</strong>
          </div>
          <div class="topbar-right">
            <button class="session-button" type="button" @click="lock">
              <span>退出后台</span><ConsoleIcon name="logout" :size="15" />
            </button>
          </div>
        </header>

        <main class="console-main admin-feature-main">
          <section class="feature-content">
            <p v-if="notice" class="feature-notice" :class="{ error: noticeIsError }" role="status">{{ notice }}</p>

            <template v-if="feature === 'users'">
              <section class="query-panel" aria-label="用户查询与操作">
                <form class="query-toolbar" @submit.prevent="runQuery">
                  <label class="query-input">
                    <ConsoleIcon name="search" :size="16" />
                    <input v-model.trim="userQuery" type="search" placeholder="按用户名查询" />
                  </label>
                  <select v-model="userStatus" class="query-select" aria-label="用户状态">
                    <option value="">全部状态</option>
                    <option value="active">正常</option>
                    <option value="disabled">已禁用</option>
                  </select>
                  <div class="query-actions">
                    <button class="button primary" type="submit"><ConsoleIcon name="search" :size="14" />查询</button>
                    <button class="button secondary" type="button" @click="resetQuery">重置</button>
                    <button class="button danger-button" type="button" :disabled="selectedCount === 0 || busy" @click="disableSelectedUsers">
                      <ConsoleIcon name="lock" :size="14" />批量禁用<span v-if="selectedCount" class="action-count">{{ selectedCount }}</span>
                    </button>
                    <button class="button primary" type="button" @click="openCreateUser"><ConsoleIcon name="plus" :size="14" />创建管理员</button>
                  </div>
                </form>
                <div class="query-meta">已选 {{ selectedCount }} 项 · 共 {{ displayTotal }} 个用户</div>
              </section>

              <section class="sources-panel directory-panel table-panel" aria-label="用户列表">
                <div class="table-scroll">
                  <table class="source-table directory-table admin-data-table user-table">
                    <thead><tr>
                      <th class="checkbox-column"><input type="checkbox" :checked="allCurrentSelected" :indeterminate="someCurrentSelected" aria-label="选择当前页全部用户" @change="toggleAllCurrent" /></th>
                      <th class="serial-column">序号</th><th>ID</th><th>用户</th><th>权限</th><th>状态</th><th>频道</th><th>IP</th><th>注册时间</th><th>操作</th>
                    </tr></thead>
                    <tbody>
                      <tr v-for="(item, index) in users" :key="item.id" :class="{ 'selected-row': isSelected(item.id) }">
                        <td class="checkbox-column"><input type="checkbox" :checked="isSelected(item.id)" :aria-label="`选择用户 ${item.username}`" @change="toggleSelection(item.id)" /></td>
                        <td class="serial-column">{{ rowNumber(index) }}</td><td>{{ item.id }}</td>
                        <td class="source-summary-cell"><div class="source-text"><div class="source-name">{{ item.username }}</div><div class="source-description">{{ item.nickname || '未设置昵称' }}</div></div></td>
                        <td><span :class="['role-badge', item.role === 'admin' ? 'admin' : 'user']">{{ item.role === 'admin' ? '管理员' : '普通用户' }}</span></td>
                        <td><span :class="['status-badge', item.status]">{{ item.status === 'active' ? '正常' : '已禁用' }}</span></td>
                        <td><button class="channel-count-button" type="button" @click="openUserChannels(item)">{{ item.channelCount ?? item.channels?.length ?? 0 }}</button></td><td>{{ item.lastLoginIp || '—' }}</td><td>{{ formatTime(item.createdAt || item.created_at) }}</td>
                        <td class="action-column"><div class="row-actions"><button class="icon-button" :class="{ 'danger-icon': item.status === 'active' }" type="button" :title="item.status === 'active' ? '禁用' : '启用'" :aria-label="`${item.status === 'active' ? '禁用' : '启用'}用户 ${item.username}`" @click="toggleUser(item)"><ConsoleIcon :name="item.status === 'active' ? 'lock' : 'unlock'" :size="15" /></button><button class="icon-button danger-icon" type="button" title="退出会话" :aria-label="`退出用户 ${item.username} 的会话`" @click="revokeUser(item)"><ConsoleIcon name="logout" :size="15" /></button><button class="icon-button danger-icon" type="button" title="删除" :aria-label="`删除用户 ${item.username}`" @click="deleteUser(item)"><ConsoleIcon name="trash" :size="15" /></button></div></td>
                      </tr>
                      <tr v-if="!users.length"><td colspan="10" class="empty-cell">暂无用户数据，或服务端用户管理接口尚未启用。</td></tr>
                    </tbody>
                  </table>
                </div>
                <AdminPagination :page="page" :total-pages="pageCount" :total="displayTotal" :page-size="pageSize" @change="goToPage" @update:page-size="changePageSize" />
              </section>

              <Teleport to="body">
                <div v-if="createUserOpen" class="admin-modal-backdrop" @click.self="closeCreateUser">
                  <section class="admin-modal" role="dialog" aria-modal="true" aria-labelledby="create-user-title">
                    <header class="admin-modal-header">
                      <div><p class="modal-eyebrow">NEW ADMIN</p><h2 id="create-user-title">创建管理员</h2><p>创建后即可用该用户名与密码登录管理后台。普通用户账号由小程序首次登录时自动创建，无需在此建号。</p></div>
                      <button class="modal-close" type="button" aria-label="关闭创建管理员弹窗" @click="closeCreateUser"><ConsoleIcon name="close" :size="18" /></button>
                    </header>
                    <form class="create-user-modal-form" @submit.prevent="createUser">
                      <label class="modal-field">用户名<input ref="usernameInput" v-model.trim="newUser.username" required minlength="4" maxlength="32" autocomplete="username" placeholder="至少 4 位字符" /></label>
                      <label class="modal-field">登录密码<input v-model="newUser.password" required minlength="6" maxlength="128" type="password" autocomplete="new-password" placeholder="至少 6 位字符" /></label>
                      <label class="modal-field">昵称<span class="optional-label">可选</span><input v-model.trim="newUser.nickname" maxlength="32" autocomplete="nickname" placeholder="请输入昵称" /></label>
                      <p v-if="modalError" class="modal-error" role="alert"><ConsoleIcon name="info" :size="15" />{{ modalError }}</p>
                      <div class="admin-modal-actions"><button class="modal-button secondary" type="button" :disabled="busy" @click="closeCreateUser">取消</button><button class="modal-button primary" type="submit" :disabled="busy">{{ busy ? '创建中…' : '创建管理员' }}</button></div>
                    </form>
                  </section>
                </div>
              </Teleport>

              <Teleport to="body">
                <div v-if="userChannelsOpen" class="admin-modal-backdrop" @click.self="closeUserChannels">
                  <section class="admin-modal channels-modal" role="dialog" aria-modal="true" aria-labelledby="user-channels-title">
                    <header class="admin-modal-header">
                      <div><p class="modal-eyebrow">USER CHANNELS</p><h2 id="user-channels-title">{{ selectedUserChannels?.username || '用户' }}的频道</h2><p>查看该账号已保存的自定义频道。</p></div>
                      <button class="modal-close" type="button" aria-label="关闭" @click="closeUserChannels">×</button>
                    </header>
                    <p v-if="userChannelsLoading" class="modal-loading">正在读取频道…</p>
                    <p v-else-if="userChannelsError" class="modal-error"><ConsoleIcon name="info" :size="14" />{{ userChannelsError }}</p>
                    <div v-else-if="selectedUserChannels?.channels.length" class="channel-chip-list">
                      <span v-for="channel in selectedUserChannels.channels" :key="channel" class="channel-chip">@{{ channel }}</span>
                    </div>
                    <p v-else class="modal-empty">该用户还没有添加自定义频道。</p>
                  </section>
                </div>
              </Teleport>
            </template>

            <template v-else-if="feature === 'logs'">
              <section class="analytics-strip" aria-label="搜索行为概览">
                <div class="analytics-card"><span>搜索次数</span><strong>{{ analytics.overview.searches }}</strong></div>
                <div class="analytics-card"><span>有结果</span><strong>{{ analytics.overview.withResults }}</strong></div>
                <div class="analytics-card"><span>无结果</span><strong>{{ analytics.overview.noResults }}</strong></div>
                <div class="analytics-card"><span>返回资源</span><strong>{{ analytics.overview.resultCount }}</strong></div>
              </section>
              <section class="query-panel" aria-label="搜索日志查询与操作">
                <form class="query-toolbar" @submit.prevent="runQuery">
                  <label class="query-input"><ConsoleIcon name="search" :size="16" /><input v-model.trim="logQuery" type="search" placeholder="关键词 / 用户 / IP" /></label>
                  <div class="query-actions"><button class="button primary" type="submit"><ConsoleIcon name="search" :size="14" />查询</button><button class="button secondary" type="button" @click="resetQuery">重置</button><button class="button danger-button" type="button" :disabled="selectedCount === 0 || busy" @click="deleteSelectedLogs"><ConsoleIcon name="trash" :size="14" />删除选中<span v-if="selectedCount" class="action-count">{{ selectedCount }}</span></button></div>
                </form>
                <div class="query-meta">已选 {{ selectedCount }} 项 · 共 {{ displayTotal }} 条日志</div>
              </section>
              <section class="sources-panel directory-panel table-panel" aria-label="搜索日志列表">
                <div class="table-scroll">
                  <table class="source-table directory-table admin-data-table log-table">
                    <thead><tr><th class="checkbox-column"><input type="checkbox" :checked="allCurrentSelected" :indeterminate="someCurrentSelected" aria-label="选择当前页全部日志" @change="toggleAllCurrent" /></th><th class="serial-column">序号</th><th>时间</th><th>关键词</th><th>用户</th><th>结果</th><th>搜索范围</th><th>操作</th></tr></thead>
                    <tbody>
                      <tr v-for="(item, index) in logs" :key="item.id" :class="{ 'selected-row': isSelected(item.id) }"><td class="checkbox-column"><input type="checkbox" :checked="isSelected(item.id)" :aria-label="`选择日志 ${item.id}`" @change="toggleSelection(item.id)" /></td><td class="serial-column">{{ rowNumber(index) }}</td><td>{{ formatTime(item.createdAt || item.created_at) }}</td><td class="break-cell">{{ item.keyword || item.kw || '—' }}</td><td>{{ item.username || item.userId || '未登录' }}</td><td>{{ logResultCountLabel(item) }}</td><td><button v-if="isCustomScope(item)" class="scope-link" type="button" @click="openLogChannels(item)">自定义频道</button><span v-else>{{ searchScopeLabel(item) }}</span></td><td class="action-column"><div class="row-actions"><button class="icon-button" type="button" aria-label="查看日志详情" title="详情" @click="openLogDetail(item)"><ConsoleIcon name="info" :size="16" /></button><button class="icon-button danger-icon" type="button" aria-label="删除日志" title="删除日志" @click="deleteLog(item)"><ConsoleIcon name="trash" :size="16" /></button></div></td></tr>
                      <tr v-if="!logs.length"><td colspan="8" class="empty-cell">暂无日志数据，或服务端日志接口尚未启用。</td></tr>
                    </tbody>
                  </table>
                </div>
                <AdminPagination :page="page" :total-pages="pageCount" :total="displayTotal" :page-size="pageSize" @change="goToPage" @update:page-size="changePageSize" />
              </section>
              <Teleport to="body">
                <div v-if="logChannelsOpen" class="admin-modal-backdrop" @click.self="closeLogChannels">
                  <section class="admin-modal channels-modal" role="dialog" aria-modal="true" aria-labelledby="log-channels-title">
                    <header class="admin-modal-header">
                      <div><p class="modal-eyebrow">SEARCH CHANNELS</p><h2 id="log-channels-title">本次搜索的频道</h2><p v-if="selectedLogChannels?.keyword">关键词：{{ selectedLogChannels.keyword }}</p></div>
                      <button class="modal-close" type="button" aria-label="关闭" @click="closeLogChannels">×</button>
                    </header>
                    <div v-if="selectedLogChannels?.channels.length" class="channel-chip-list">
                      <span v-for="channel in selectedLogChannels.channels" :key="channel" class="channel-chip">@{{ channel }}</span>
                    </div>
                    <p v-else class="modal-empty">这条日志没有记录具体频道。</p>
                  </section>
                </div>
              </Teleport>

              <Teleport to="body">
                <div v-if="logDetailOpen" class="admin-modal-backdrop" @click.self="closeLogDetail">
                  <section class="admin-modal log-detail-modal" role="dialog" aria-modal="true" aria-labelledby="log-detail-title">
                    <header class="admin-modal-header">
                      <div><p class="modal-eyebrow">SEARCH RESULT DETAIL</p><h2 id="log-detail-title">搜索结果详情</h2><p v-if="selectedLogDetail">关键词：{{ selectedLogDetail.keyword || selectedLogDetail.kw || '—' }} · 共 {{ selectedLogDetail.resultCount || 0 }} 条</p></div>
                      <button class="modal-close" type="button" aria-label="关闭" @click="closeLogDetail">×</button>
                    </header>
                    <div v-if="selectedLogSourceCounts.length" class="log-source-count-list">
                      <div v-for="item in selectedLogSourceCounts" :key="item.sourceId" class="log-source-count-row">
                        <span class="log-source-name">{{ item.sourceId }}</span>
                        <strong>{{ item.count }} 条</strong>
                      </div>
                    </div>
                    <p v-else class="modal-empty">这条日志没有记录各来源的结果数量。</p>
                  </section>
                </div>
              </Teleport>
            </template>

          <template v-else>
              <section class="feature-card policy-card" aria-labelledby="system-settings-title">
                <div class="policy-card-header">
                  <div class="policy-card-copy">
                    <h2 id="system-settings-title">搜索与账号配置</h2>
                  </div>
                  <div class="policy-card-actions">
                    <span class="policy-count">17 个配置项</span>
                    <button class="refresh-button" type="button" :disabled="loading" @click="loadData">
                      <ConsoleIcon name="refresh" :size="14" />{{ loading ? '读取中…' : '刷新数据' }}
                    </button>
                    <button class="primary-button" type="submit" form="system-settings-form" :disabled="busy"><ConsoleIcon name="check" :size="14" />{{ busy ? '保存中…' : '保存搜索配置' }}</button>
                  </div>
                </div>
                <form id="system-settings-form" class="policy-form" @submit.prevent="savePolicy">
                  <fieldset class="policy-group">
                    <legend>账号与首页</legend>
                    <div class="policy-form-grid">
                      <label class="policy-field policy-toggle"><input v-model="policyForm.showHotSearch" type="checkbox" /><span><strong>展示热门搜索</strong><small>关闭后首页不加载或展示热门搜索区域。</small></span></label>
                      <label class="policy-field policy-toggle"><input v-model="policyForm.anonymousCustomChannels" type="checkbox" /><span><strong>允许匿名用户使用自定义频道</strong><small>关闭后自定义频道仅微信登录用户可用。</small></span></label>
                      <label class="policy-field policy-toggle"><input v-model="policyForm.showAuthButtons" type="checkbox" /><span><strong>是否展示登录按钮</strong><small>关闭后首页顶栏不再显示登录入口，扫码登录接口同时停用。</small></span></label>
                    </div>
                  </fieldset>
                  <fieldset class="policy-group">
                    <legend>会话与频道</legend>
                    <div class="policy-form-grid">
                      <label class="policy-field"><span><strong>会话有效天数</strong><code>sessionDays</code></span><input v-model.number="policyForm.sessionDays" type="number" min="1" max="365" required /><small>范围：1–365 天</small></label>
                      <label class="policy-field"><span><strong>自定义频道数量上限</strong><code>customChannelLimit</code></span><input v-model.number="policyForm.customChannelLimit" type="number" min="0" max="100" required /><small>范围：0–100 个</small></label>
                    </div>
                  </fieldset>
                  <fieldset class="policy-group">
                    <legend>搜索运行</legend>
                    <div class="policy-form-grid">
                      <label class="policy-field"><span><strong>默认并发请求数</strong><code>defaultConcurrency</code></span><input v-model.number="policyForm.defaultConcurrency" type="number" min="1" max="16" required /><small>范围：1–16</small></label>
                      <label class="policy-field"><span><strong>请求 / transform 超时</strong><code>requestTimeoutMs</code></span><input v-model.number="policyForm.requestTimeoutMs" type="number" min="1000" max="60000" required /><small>范围：1000–60000 ms</small></label>
                      <label class="policy-field"><span><strong>来源熔断失败次数</strong><code>circuitBreakerMaxFailures</code></span><input v-model.number="policyForm.circuitBreakerMaxFailures" type="number" min="1" max="20" required /><small>范围：1–20 次</small></label>
                      <label class="policy-field"><span><strong>整次搜索超时</strong><code>searchTimeoutMs</code></span><input v-model.number="policyForm.searchTimeoutMs" type="number" min="1000" max="120000" required /><small>范围：1000–120000 ms</small></label>
                      <label class="policy-field"><span><strong>搜索缓存时长</strong><code>cacheTtlMinutes</code></span><input v-model.number="policyForm.cacheTtlMinutes" type="number" min="1" max="10" required /><small>范围：1–10 分钟</small></label>
                      <label class="policy-field"><span><strong>搜索缓存容量上限</strong><code>cacheMaxMemoryMb</code></span><input v-model.number="policyForm.cacheMaxMemoryMb" type="number" min="16" max="512" required /><small>范围：16–512 MB，调小后按 LRU 立即淘汰</small></label>
                    </div>
                  </fieldset>
                  <fieldset class="policy-group">
                    <legend>搜索限流</legend>
                    <div class="policy-form-grid">
                      <label class="policy-field"><span><strong>匿名账户限流窗口</strong><code>anonymousSearchRateLimitWindowSeconds</code></span><input v-model.number="policyForm.anonymousSearchRateLimitWindowSeconds" type="number" min="10" max="3600" required /><small>范围：10–3600 秒</small></label>
                      <label class="policy-field"><span><strong>匿名账户单 Session 上限</strong><code>anonymousSearchRateLimitPerSession</code></span><input v-model.number="policyForm.anonymousSearchRateLimitPerSession" type="number" min="1" max="300" required /><small>范围：1–300 次</small></label>
                      <label class="policy-field"><span><strong>匿名账户单 IP 上限</strong><code>anonymousSearchRateLimitPerIp</code></span><input v-model.number="policyForm.anonymousSearchRateLimitPerIp" type="number" min="1" max="1000" required /><small>范围：1–1000 次</small></label>
                      <label class="policy-field"><span><strong>登录账户限流窗口</strong><code>loggedSearchRateLimitWindowSeconds</code></span><input v-model.number="policyForm.loggedSearchRateLimitWindowSeconds" type="number" min="10" max="3600" required /><small>范围：10–3600 秒</small></label>
                      <label class="policy-field"><span><strong>登录账户单 Session 上限</strong><code>loggedSearchRateLimitPerSession</code></span><input v-model.number="policyForm.loggedSearchRateLimitPerSession" type="number" min="1" max="300" required /><small>范围：1–300 次</small></label>
                      <label class="policy-field"><span><strong>登录账户单 IP 上限</strong><code>loggedSearchRateLimitPerIp</code></span><input v-model.number="policyForm.loggedSearchRateLimitPerIp" type="number" min="1" max="1000" required /><small>范围：1–1000 次</small></label>
                    </div>
                  </fieldset>
                </form>
              </section>
              <section class="feature-card admin-account-card" aria-labelledby="wechat-mini-title">
                <div class="policy-card-header">
                  <div class="policy-card-copy">
                    <h2 id="wechat-mini-title">微信小程序</h2>
                    <p>网站扫码登录与小程序登录共用这份凭据，保存在数据库里，保存后立即生效，不需要改环境变量或重启服务。</p>
                  </div>
                  <div class="policy-card-actions">
                    <span class="policy-count">{{ wechatSettings.configured ? '已配置' : '未配置' }}</span>
                  </div>
                </div>
                <form class="admin-account-form" @submit.prevent="saveWechatSettings">
                  <label class="policy-field"><span><strong>AppID</strong><small>微信公众平台 → 开发管理 → 开发设置</small></span><input v-model.trim="wechatForm.appId" type="text" maxlength="64" autocomplete="off" placeholder="wx 开头的 AppID" /></label>
                  <label class="policy-field"><span><strong>AppSecret</strong><small>{{ wechatSecretHint }}</small></span><input v-model="wechatForm.secret" type="password" maxlength="128" autocomplete="new-password" :placeholder="wechatSettings.secretConfigured ? '留空表示不修改已保存的密钥' : '填写 AppSecret'" /></label>
                  <label class="policy-field"><span><strong>扫码页面</strong><small>小程序码指向的页面，不带前导斜杠</small></span><input v-model.trim="wechatForm.qrPage" type="text" maxlength="128" placeholder="pages/login/index" /></label>
                  <label class="policy-field"><span><strong>打开版本</strong><small>小程序还没发布时选体验版，否则扫出来的码打不开页面</small></span>
                    <select v-model="wechatForm.envVersion">
                      <option value="release">release（正式版）</option>
                      <option value="trial">trial（体验版）</option>
                      <option value="develop">develop（开发版）</option>
                    </select>
                  </label>
                  <div class="admin-account-actions"><button class="primary-button" type="submit" :disabled="busy"><ConsoleIcon name="check" :size="14" />{{ busy ? '保存中…' : '保存微信配置' }}</button></div>
                </form>
              </section>
              <section class="feature-card admin-account-card" aria-labelledby="admin-account-title">
                <div class="policy-card-header">
                  <div class="policy-card-copy"><h2 id="admin-account-title">管理员账号</h2><p>修改后台登录用户名或密码。当前会话不会被立即退出。</p></div>
                </div>
                <form class="admin-account-form" @submit.prevent="saveAdminAccount">
                  <label class="policy-field"><span><strong>管理员用户名</strong><small>4–32 位字母、数字或下划线</small></span><input v-model.trim="adminAccount.username" type="text" minlength="4" maxlength="32" autocomplete="username" required /></label>
                  <label class="policy-field"><span><strong>新密码</strong><small>留空表示保持当前密码不变，至少 6 位</small></span><input v-model="adminAccount.password" type="password" minlength="6" maxlength="128" autocomplete="new-password" placeholder="不修改密码请留空" /></label>
                  <label v-if="adminAccount.password" class="policy-field"><span><strong>确认新密码</strong></span><input v-model="adminAccount.confirmPassword" type="password" minlength="6" maxlength="128" autocomplete="new-password" required /></label>
                  <div class="admin-account-actions"><button class="primary-button" type="submit" :disabled="busy || !adminAccount.username"><ConsoleIcon name="check" :size="14" />{{ busy ? '保存中…' : '保存管理员账号' }}</button></div>
                </form>
              </section>
            </template>
          </section>
        </main>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import AdminAccessGate from "./AdminAccessGate.vue";
import ConsoleIcon from "../sources/ConsoleIcon.vue";

import AdminPagination from "./AdminPagination.vue";
const auth = useAuth();
type Feature = "users" | "logs" | "policies";
type AdminUser = { id: number; username: string; nickname?: string | null; role?: "admin" | "user"; status: "active" | "disabled"; channels?: string[]; channelCount?: number; lastLoginIp?: string | null; createdAt?: number; created_at?: number };
type AdminLog = { id: number; keyword?: string; kw?: string; username?: string; userId?: number | null; sessionId?: number | string; ip?: string; scope?: string; searchScope?: string; channels?: string[]; createdAt?: number; created_at?: number; status?: string; resultCount?: number; hasResults?: boolean; outcomeRecorded?: boolean; sourceResultCounts?: Record<string, number> };
type SearchAnalytics = {
  overview: { searches: number; withResults: number; noResults: number; resultCount: number };
  sources: Array<{ sourceId: string; resultCount: number }>;
};
type UserPolicy = {
  showHotSearch: boolean;
  anonymousCustomChannels: boolean;
  showAuthButtons: boolean;
  sessionDays: number;
  customChannelLimit: number;
  defaultConcurrency: number;
  requestTimeoutMs: number;
  circuitBreakerMaxFailures: number;
  searchTimeoutMs: number;
  cacheTtlMinutes: number;
  cacheMaxMemoryMb: number;
  anonymousSearchRateLimitWindowSeconds: number;
  anonymousSearchRateLimitPerSession: number;
  anonymousSearchRateLimitPerIp: number;
  loggedSearchRateLimitWindowSeconds: number;
  loggedSearchRateLimitPerSession: number;
  loggedSearchRateLimitPerIp: number;
};

const DEFAULT_POLICY: UserPolicy = {
  showHotSearch: true,
  anonymousCustomChannels: false,
  showAuthButtons: true,
  sessionDays: 30,
  customChannelLimit: 10,
  defaultConcurrency: 4,
  requestTimeoutMs: 5000,
  circuitBreakerMaxFailures: 5,
  searchTimeoutMs: 30000,
  cacheTtlMinutes: 10,
  cacheMaxMemoryMb: 100,
  anonymousSearchRateLimitWindowSeconds: 60,
  anonymousSearchRateLimitPerSession: 20,
  anonymousSearchRateLimitPerIp: 60,
  loggedSearchRateLimitWindowSeconds: 60,
  loggedSearchRateLimitPerSession: 60,
  loggedSearchRateLimitPerIp: 240,
};

const props = defineProps<{ feature: Feature }>();
const feature = computed(() => props.feature);
const title = computed(() => ({ users: "用户管理", logs: "搜索日志", policies: "系统设置" })[props.feature]);
const checking = ref(true); const ready = ref(false); const authenticated = ref(false); const locked = ref(true);
const loading = ref(false); const busy = ref(false); const authError = ref(""); const notice = ref(""); const noticeIsError = ref(false);
const users = ref<AdminUser[]>([]); const logs = ref<AdminLog[]>([]); const userQuery = ref(""); const userStatus = ref(""); const logQuery = ref("");
const analytics = ref<SearchAnalytics>({ overview: { searches: 0, withResults: 0, noResults: 0, resultCount: 0 }, sources: [] });
const policyForm = ref<UserPolicy>({ ...DEFAULT_POLICY });
const adminAccount = ref({ username: "", password: "", confirmPassword: "" });
type WechatEnvVersion = "release" | "trial" | "develop";
type WechatSettingsView = { appId: string; qrPage: string; envVersion: WechatEnvVersion; secretConfigured: boolean; secretLength: number; configured: boolean };
type WechatForm = { appId: string; secret: string; qrPage: string; envVersion: WechatEnvVersion };
const DEFAULT_WECHAT_SETTINGS: WechatSettingsView = { appId: "", qrPage: "pages/login/index", envVersion: "release", secretConfigured: false, secretLength: 0, configured: false };
// `secret` is write-only: it is never sent back, so the form always starts blank
// and an empty field means "keep the stored secret".
const wechatSettings = ref<WechatSettingsView>({ ...DEFAULT_WECHAT_SETTINGS });
const wechatForm = ref<WechatForm>({ appId: "", secret: "", qrPage: "pages/login/index", envVersion: "release" });
const wechatSecretHint = computed(() => wechatSettings.value.secretConfigured
  ? `已保存 ${wechatSettings.value.secretLength} 位密钥，留空表示不修改`
  : "与 AppID 配套，仅保存在服务端，保存后不会回显");
const newUser = ref({ username: "", password: "", nickname: "" }); const createUserOpen = ref(false); const modalError = ref(""); const usernameInput = ref<HTMLInputElement | null>(null);
const selectedKeys = ref<string[]>([]); const page = ref(1); const pageSize = ref(20); const total = ref(0);
const userChannelsOpen = ref(false); const userChannelsLoading = ref(false); const userChannelsError = ref(""); const selectedUserChannels = ref<{ username: string; channels: string[] } | null>(null);
const logChannelsOpen = ref(false); const selectedLogChannels = ref<{ keyword: string; channels: string[] } | null>(null);
const logDetailOpen = ref(false); const selectedLogDetail = ref<AdminLog | null>(null);

function statusOf(error: any) { return error?.statusCode || error?.response?.status || error?.status; }
function apiError(error: any): string { const status = statusOf(error); if (status === 401) return "请先登录管理员账号。"; if (status === 403) return "当前账号没有管理员权限。"; if (status === 404) return "服务端接口尚未部署，当前页面先保留入口。"; return error?.data?.statusMessage || error?.message || "后台请求失败。"; }
function show(message: string, error = false) { notice.value = message; noticeIsError.value = error; }
function formatTime(value: unknown) { const n = Number(value); return Number.isFinite(n) && n > 0 ? new Date(n).toLocaleString() : "—"; }
function formatIp(value: unknown) { const ip = String(value || "").trim(); return ip && ip.toLowerCase() !== "unknown" ? ip : "未知"; }
function isCustomScope(item: AdminLog) { return (item.scope || item.searchScope) === "custom_channels"; }
function searchScopeLabel(item: AdminLog) { return isCustomScope(item) ? "自定义频道" : "本站来源"; }
function logResultCountLabel(item: AdminLog) {
  if (!item.outcomeRecorded) return item.status === "started" ? "进行中" : item.status === "failed" ? "失败" : "未统计";
  return `${Math.max(0, Number(item.resultCount || 0))} 条`;
}
function unwrap<T>(result: any, key: string): T { return result?.[key] ?? result?.data?.[key] ?? result?.data ?? result; }
const displayTotal = computed(() => total.value);
const pageCount = computed(() => Math.max(1, Math.ceil(displayTotal.value / pageSize.value)));
const currentRowKeys = computed(() => props.feature === "users" ? users.value.map((item) => String(item.id)) : props.feature === "logs" ? logs.value.map((item) => String(item.id)) : []);
const selectedLogSourceCounts = computed(() => Object.entries(selectedLogDetail.value?.sourceResultCounts || {})
  .map(([sourceId, count]) => ({ sourceId, count: Math.max(0, Number(count) || 0) }))
  .sort((left, right) => right.count - left.count || left.sourceId.localeCompare(right.sourceId)));
const selectedCount = computed(() => selectedKeys.value.length);
const allCurrentSelected = computed(() => currentRowKeys.value.length > 0 && currentRowKeys.value.every((key) => selectedKeys.value.includes(key)));
const someCurrentSelected = computed(() => currentRowKeys.value.some((key) => selectedKeys.value.includes(key)) && !allCurrentSelected.value);

function rowNumber(index: number) { return (page.value - 1) * pageSize.value + index + 1; }
function isSelected(id: string | number) { return selectedKeys.value.includes(String(id)); }
function toggleSelection(id: string | number) { const key = String(id); selectedKeys.value = isSelected(key) ? selectedKeys.value.filter((item) => item !== key) : [...selectedKeys.value, key]; }
function toggleAllCurrent(event: Event) { const checked = (event.target as HTMLInputElement).checked; const current = currentRowKeys.value; selectedKeys.value = checked ? [...new Set([...selectedKeys.value, ...current])] : selectedKeys.value.filter((key) => !current.includes(key)); }
function clearSelection() { selectedKeys.value = []; }
async function checkStatus() {
  checking.value = true;
  authError.value = "";
  try {
    const status = await $fetch<{ authenticated: boolean; user: { role?: string } | null }>("/api/account/session", {
      credentials: "include",
      cache: "no-store",
      retry: 0,
    });
    authenticated.value = status.authenticated;
    locked.value = !(status.authenticated && status.user?.role === "admin");
    ready.value = true;
    if (!locked.value) await loadData();
  } catch (error: any) {
    authenticated.value = false;
    locked.value = true;
    authError.value = apiError(error);
    ready.value = true;
  } finally {
    checking.value = false;
  }
}
async function lock() {
  createUserOpen.value = false;
  try {
    await auth.logout();
  } finally {
    authenticated.value = false;
    locked.value = true;
    await navigateTo("/");
  }
}

async function loadData() {
  if (locked.value || loading.value) return;
  loading.value = true; show("");
  try {
    if (props.feature === "users") {
      const result = await $fetch<any>("/api/admin/users", { query: { q: userQuery.value || undefined, status: userStatus.value || undefined, page: page.value, pageSize: pageSize.value }, cache: "no-store" });
      const data = result?.data ?? result; users.value = (data.users || data.items || []).map((item: AdminUser) => ({ ...item, channelCount: item.channelCount ?? item.channels?.length })); total.value = Number(data.total || users.value.length); page.value = Number(data.page || page.value);
    } else if (props.feature === "logs") {
      const [result, analyticsResult] = await Promise.all([
        $fetch<any>("/api/admin/search-logs", { query: { q: logQuery.value || undefined, page: page.value, pageSize: pageSize.value }, cache: "no-store" }),
        $fetch<any>("/api/admin/search-analytics", { cache: "no-store" }),
      ]);
      const data = result?.data ?? result; logs.value = data.logs || data.items || []; total.value = Number(data.total || logs.value.length); page.value = Number(data.page || page.value);
      analytics.value = analyticsResult?.data ?? analytics.value;
    } else {
      const [policyResult, accountResult, wechatResult] = await Promise.all([
        $fetch<any>("/api/settings/user-policy", { cache: "no-store" }),
        $fetch<any>("/api/admin/account", { cache: "no-store" }),
        $fetch<any>("/api/settings/wechat", { cache: "no-store" }),
      ]);
      const loadedPolicy = normalizePolicy(unwrap<Partial<UserPolicy>>(policyResult, "policy"));
      const loadedAccount = unwrap<{ username?: string }>(accountResult, "account");
      const loadedWechat = normalizeWechatSettings(unwrap<Partial<WechatSettingsView>>(wechatResult, "wechat"));
      policyForm.value = loadedPolicy;
      adminAccount.value = { username: String(loadedAccount.username || ""), password: "", confirmPassword: "" };
      auth.showHotSearch.value = loadedPolicy.showHotSearch;
      auth.showAuthButtons.value = loadedPolicy.showAuthButtons;
      wechatSettings.value = loadedWechat;
      wechatForm.value = { appId: loadedWechat.appId, secret: "", qrPage: loadedWechat.qrPage, envVersion: loadedWechat.envVersion };
    }
  } catch (error: any) { if ([401, 403].includes(statusOf(error))) { authenticated.value = false; locked.value = true; } show(apiError(error), true); }
  finally { loading.value = false; }
}
function runQuery() { page.value = 1; clearSelection(); void loadData(); }
function resetQuery() { userQuery.value = ""; userStatus.value = ""; logQuery.value = ""; runQuery(); }
function goToPage(nextPage: number) { if (nextPage < 1 || nextPage > pageCount.value || nextPage === page.value) return; page.value = nextPage; clearSelection(); void loadData(); }
function changePageSize(size: number) { pageSize.value = size; page.value = 1; clearSelection(); void loadData(); }

function openCreateUser() { if (busy.value) return; newUser.value = { username: "", password: "", nickname: "" }; modalError.value = ""; createUserOpen.value = true; }
function closeCreateUser() { if (!busy.value) createUserOpen.value = false; }
function handleModalKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  if (createUserOpen.value) closeCreateUser();
  else if (userChannelsOpen.value) closeUserChannels();
  else if (logDetailOpen.value) closeLogDetail();
  else if (logChannelsOpen.value) closeLogChannels();
}
async function createUser() { if (busy.value) return; busy.value = true; try { await $fetch("/api/admin/users", { method: "POST", body: newUser.value }); newUser.value = { username: "", password: "", nickname: "" }; modalError.value = ""; createUserOpen.value = false; show("管理员已创建。"); await loadData(); } catch (error: any) { modalError.value = apiError(error); if (statusOf(error) === 401) locked.value = true; } finally { busy.value = false; } }
async function openUserChannels(item: AdminUser) {
  userChannelsOpen.value = true;
  userChannelsLoading.value = true;
  userChannelsError.value = "";
  selectedUserChannels.value = { username: item.username, channels: [] };
  try {
    const result = await $fetch<any>(`/api/admin/users/${encodeURIComponent(String(item.id))}/channels`, { cache: "no-store" });
    const data = unwrap<{ username?: string; channels?: string[] }>(result, "data");
    selectedUserChannels.value = { username: data.username || item.username, channels: data.channels || [] };
  } catch (error: any) {
    userChannelsError.value = apiError(error);
  } finally {
    userChannelsLoading.value = false;
  }
}
function closeUserChannels() { if (!userChannelsLoading.value) userChannelsOpen.value = false; }
function openLogChannels(item: AdminLog) {
  selectedLogChannels.value = { keyword: item.keyword || item.kw || "—", channels: item.channels || [] };
  logChannelsOpen.value = true;
}
function closeLogChannels() { logChannelsOpen.value = false; }
function openLogDetail(item: AdminLog) { selectedLogDetail.value = item; logDetailOpen.value = true; }
function closeLogDetail() { logDetailOpen.value = false; selectedLogDetail.value = null; }
async function userAction(item: AdminUser, action: string) { if (busy.value) return; busy.value = true; try { const id = encodeURIComponent(String(item.id)); const method = action === "delete" || action === "sessions" ? "DELETE" : "POST"; const path = action === "delete" ? `/api/admin/users/${id}` : `/api/admin/users/${id}/${action}`; await $fetch(path, { method }); show(action === "delete" ? "用户已移入回收状态。" : "操作已完成。"); await loadData(); } catch (error: any) { show(apiError(error), true); } finally { busy.value = false; } }
async function toggleUser(item: AdminUser) { await userAction(item, item.status === "active" ? "disable" : "enable"); }
async function revokeUser(item: AdminUser) { await userAction(item, "sessions"); }
async function deleteUser(item: AdminUser) {
  if (busy.value || !import.meta.client || !window.confirm(`确定将用户「${item.username}」移入回收状态吗？该用户会被禁用并注销会话。`)) return;
  await userAction(item, "delete");
}
async function disableSelectedUsers() { if (!selectedCount.value || !import.meta.client || !window.confirm(`确定禁用选中的 ${selectedCount.value} 个用户吗？`)) return; busy.value = true; try { await Promise.all(selectedKeys.value.map((id) => $fetch(`/api/admin/users/${encodeURIComponent(id)}/disable`, { method: "POST" }))); clearSelection(); show("选中用户已禁用。"); await loadData(); } catch (error: any) { show(apiError(error), true); } finally { busy.value = false; } }
async function deleteSelectedLogs() { if (!selectedCount.value || !import.meta.client || !window.confirm(`确定删除选中的 ${selectedCount.value} 条日志吗？删除后不可恢复。`)) return; busy.value = true; try { await $fetch<unknown>("/api/admin/search-logs" as string, { method: "DELETE", body: { ids: selectedKeys.value.map(Number) } }); clearSelection(); page.value = Math.min(page.value, Math.max(1, Math.ceil((total.value - selectedCount.value) / pageSize.value))); show("选中日志已删除。"); await loadData(); } catch (error: any) { show(apiError(error), true); } finally { busy.value = false; } }
async function deleteLog(item: AdminLog) { if (busy.value || !import.meta.client || !window.confirm("确定删除这条搜索日志吗？删除后不可恢复。")) return; busy.value = true; try { await $fetch<unknown>("/api/admin/search-logs" as string, { method: "DELETE", body: { ids: [item.id] } }); clearSelection(); page.value = Math.min(page.value, Math.max(1, Math.ceil((total.value - 1) / pageSize.value))); show("日志已删除。"); await loadData(); } catch (error: any) { show(apiError(error), true); } finally { busy.value = false; } }

function normalizePolicy(value: unknown): UserPolicy {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Partial<UserPolicy> : {};
  return {
    showHotSearch: typeof input.showHotSearch === "boolean" ? input.showHotSearch : DEFAULT_POLICY.showHotSearch,
    anonymousCustomChannels: typeof input.anonymousCustomChannels === "boolean" ? input.anonymousCustomChannels : DEFAULT_POLICY.anonymousCustomChannels,
    showAuthButtons: typeof input.showAuthButtons === "boolean" ? input.showAuthButtons : DEFAULT_POLICY.showAuthButtons,
    sessionDays: typeof input.sessionDays === "number" && Number.isInteger(input.sessionDays) ? input.sessionDays : DEFAULT_POLICY.sessionDays,
    customChannelLimit: typeof input.customChannelLimit === "number" && Number.isInteger(input.customChannelLimit) ? input.customChannelLimit : DEFAULT_POLICY.customChannelLimit,
    defaultConcurrency: typeof input.defaultConcurrency === "number" && Number.isInteger(input.defaultConcurrency) ? input.defaultConcurrency : DEFAULT_POLICY.defaultConcurrency,
    requestTimeoutMs: typeof input.requestTimeoutMs === "number" && Number.isInteger(input.requestTimeoutMs) ? input.requestTimeoutMs : DEFAULT_POLICY.requestTimeoutMs,
    circuitBreakerMaxFailures: typeof input.circuitBreakerMaxFailures === "number" && Number.isInteger(input.circuitBreakerMaxFailures) ? input.circuitBreakerMaxFailures : DEFAULT_POLICY.circuitBreakerMaxFailures,
    searchTimeoutMs: typeof input.searchTimeoutMs === "number" && Number.isInteger(input.searchTimeoutMs) ? input.searchTimeoutMs : DEFAULT_POLICY.searchTimeoutMs,
    cacheTtlMinutes: typeof input.cacheTtlMinutes === "number" && Number.isInteger(input.cacheTtlMinutes) ? input.cacheTtlMinutes : DEFAULT_POLICY.cacheTtlMinutes,
    cacheMaxMemoryMb: typeof input.cacheMaxMemoryMb === "number" && Number.isInteger(input.cacheMaxMemoryMb) ? input.cacheMaxMemoryMb : DEFAULT_POLICY.cacheMaxMemoryMb,
    anonymousSearchRateLimitWindowSeconds: typeof input.anonymousSearchRateLimitWindowSeconds === "number" && Number.isInteger(input.anonymousSearchRateLimitWindowSeconds) ? input.anonymousSearchRateLimitWindowSeconds : DEFAULT_POLICY.anonymousSearchRateLimitWindowSeconds,
    anonymousSearchRateLimitPerSession: typeof input.anonymousSearchRateLimitPerSession === "number" && Number.isInteger(input.anonymousSearchRateLimitPerSession) ? input.anonymousSearchRateLimitPerSession : DEFAULT_POLICY.anonymousSearchRateLimitPerSession,
    anonymousSearchRateLimitPerIp: typeof input.anonymousSearchRateLimitPerIp === "number" && Number.isInteger(input.anonymousSearchRateLimitPerIp) ? input.anonymousSearchRateLimitPerIp : DEFAULT_POLICY.anonymousSearchRateLimitPerIp,
    loggedSearchRateLimitWindowSeconds: typeof input.loggedSearchRateLimitWindowSeconds === "number" && Number.isInteger(input.loggedSearchRateLimitWindowSeconds) ? input.loggedSearchRateLimitWindowSeconds : DEFAULT_POLICY.loggedSearchRateLimitWindowSeconds,
    loggedSearchRateLimitPerSession: typeof input.loggedSearchRateLimitPerSession === "number" && Number.isInteger(input.loggedSearchRateLimitPerSession) ? input.loggedSearchRateLimitPerSession : DEFAULT_POLICY.loggedSearchRateLimitPerSession,
    loggedSearchRateLimitPerIp: typeof input.loggedSearchRateLimitPerIp === "number" && Number.isInteger(input.loggedSearchRateLimitPerIp) ? input.loggedSearchRateLimitPerIp : DEFAULT_POLICY.loggedSearchRateLimitPerIp,
  };
}

function normalizeWechatSettings(value: unknown): WechatSettingsView {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Partial<WechatSettingsView> : {};
  const envVersion = input.envVersion === "trial" || input.envVersion === "develop" ? input.envVersion : "release";
  return {
    appId: typeof input.appId === "string" ? input.appId : DEFAULT_WECHAT_SETTINGS.appId,
    qrPage: typeof input.qrPage === "string" && input.qrPage ? input.qrPage : DEFAULT_WECHAT_SETTINGS.qrPage,
    envVersion,
    secretConfigured: input.secretConfigured === true,
    secretLength: typeof input.secretLength === "number" ? input.secretLength : 0,
    configured: input.configured === true,
  };
}

async function savePolicy() {
  if (busy.value) return;
  busy.value = true;
  try {
    const result = await $fetch<any>("/api/settings/user-policy", { method: "PUT", body: policyForm.value });
    const savedPolicy = normalizePolicy(unwrap<Partial<UserPolicy>>(result, "policy"));
    policyForm.value = savedPolicy;
    auth.showHotSearch.value = savedPolicy.showHotSearch;
    auth.showAuthButtons.value = savedPolicy.showAuthButtons;
    show("搜索配置已保存。");
  } catch (error: any) { show(apiError(error), true); }
  finally { busy.value = false; }
}

async function saveWechatSettings() {
  if (busy.value) return;
  busy.value = true;
  try {
    const result = await $fetch<any>("/api/settings/wechat", {
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
    const saved = normalizeWechatSettings(unwrap<Partial<WechatSettingsView>>(result, "wechat"));
    wechatSettings.value = saved;
    wechatForm.value = { appId: saved.appId, secret: "", qrPage: saved.qrPage, envVersion: saved.envVersion };
    show(saved.configured
      ? "微信配置已保存，扫码登录与小程序登录立即生效。"
      : "已保存，但 AppID 或 AppSecret 仍为空，微信登录暂不可用。");
  } catch (error: any) { show(apiError(error), true); }
  finally { busy.value = false; }
}

async function saveAdminAccount() {
  if (busy.value) return;
  if (adminAccount.value.password && adminAccount.value.password !== adminAccount.value.confirmPassword) {
    show("两次输入的新密码不一致。", true);
    return;
  }
  busy.value = true;
  try {
    const result = await $fetch<any>("/api/admin/account", {
      method: "PUT",
      body: {
        username: adminAccount.value.username,
        password: adminAccount.value.password || undefined,
      },
    });
    const saved = unwrap<{ username?: string }>(result, "account");
    adminAccount.value = { username: String(saved.username || adminAccount.value.username), password: "", confirmPassword: "" };
    if (auth.user.value && saved.username) auth.user.value = { ...auth.user.value, username: saved.username };
    show("管理员账号已保存，新的用户名和密码可用于下次登录。");
  } catch (error: any) { show(apiError(error), true); }
  finally { busy.value = false; }
}

watch(createUserOpen, (open) => { if (import.meta.client) document.body.style.overflow = open ? "hidden" : ""; if (open) void nextTick(() => usernameInput.value?.focus()); });
watch(pageCount, (count) => { if (page.value > count) page.value = count; });
onMounted(() => { checkStatus(); window.addEventListener("keydown", handleModalKeydown); });
onBeforeUnmount(() => { window.removeEventListener("keydown", handleModalKeydown); document.body.style.overflow = ""; });
</script>

<style src="../../assets/source-console.css"></style>

<style scoped>
.feature-content { width: 100%; margin: 0; padding: 0; }
.analytics-strip { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; margin-bottom: 16px; }
.analytics-card { display: flex; min-height: 72px; flex-direction: column; justify-content: center; gap: 5px; padding: 12px 15px; border: 1px solid #dfe7f1; border-radius: 12px; background: #fff; box-shadow: 0 8px 22px rgba(40,62,92,.05); }
.analytics-card span { color: #8591a2; font-size: 11px; }
.analytics-card strong { color: #1f2937; font-size: 21px; font-variant-numeric: tabular-nums; }
.analytics-table-panel { margin-bottom: 16px; }
.analytics-section-heading { display: flex; align-items: center; min-height: 64px; padding: 12px 16px; border-bottom: 1px solid #edf1f6; background: #fbfcfe; }
.analytics-section-heading h2 { margin: 0 0 4px; color: #1f2937; font-size: 14px; }
.analytics-section-heading p { margin: 0; color: #8591a2; font-size: 11px; }
.conversion-cell { color: #2563eb !important; font-weight: 750; font-variant-numeric: tabular-nums; }
.analytics-source-table { min-width: 760px !important; }
.analytics-table-scroll { max-height: 360px; }
.feature-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; margin-bottom: 22px; }
.feature-heading h1 { margin: 0 0 7px; font-size: 29px; }
.feature-heading p:not(.eyebrow) { margin: 0; color: #64748b; font-size: 13px; }
.refresh-button { display: inline-flex; align-items: center; gap: 7px; min-height: 38px; padding: 8px 14px; border: 1px solid #dbe1ea; border-radius: 8px; color: #475569; background: #fff; font: 600 12px inherit; cursor: pointer; }
.refresh-button:hover:not(:disabled) { border-color: #93c5fd; color: #2563eb; background: #eff6ff; }
.refresh-button:disabled { cursor: wait; opacity: .55; }
.feature-notice { margin: 0 0 14px; padding: 10px 13px; border: 1px solid #dbeafe; border-radius: 8px; color: #1d4ed8; background: #eff6ff; font-size: 12px; }
.feature-notice:empty { display: none; }
.feature-notice.error { border-color: #fecaca; color: #b91c1c; background: #fef2f2; }
.query-panel { position: sticky; top: calc(var(--console-topbar-height) + 10px); z-index: 12; margin-bottom: 16px; padding: 0; border: 1px solid #dfe7f1; border-radius: 14px; background: rgba(255,255,255,.98); box-shadow: 0 10px 30px rgba(40,62,92,.06); overflow: visible; backdrop-filter: blur(12px); }
.query-toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 14px 16px; border-bottom: 1px solid #edf1f6; background: #fbfcfe; }
.query-input { display: flex; align-items: center; gap: 8px; flex: 1 1 260px; min-width: 220px; height: 44px; padding: 0 13px; border: 1px solid #dce5f0; border-radius: 10px; color: #7b8794; background: #fff; }
.query-input:focus-within { border-color: #60a5fa; box-shadow: 0 0 0 3px rgba(37,99,235,.1); }
.query-input input { min-width: 0; flex: 1; border: 0; outline: 0; color: #111827; background: transparent; font: inherit; font-size: 12px; }
.query-select { width: 120px; flex: 0 0 120px; height: 44px; padding: 0 25px 0 12px; border: 1px solid #dce5f0; border-radius: 10px; color: #475569; background: #fff; font: inherit; font-size: 12px; }
.query-actions { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.query-actions .button { min-height: 44px; border-radius: 10px; }
.action-count { min-width: 17px; padding: 1px 5px; border-radius: 99px; color: currentColor; background: rgba(255,255,255,.35); font-size: 10px; text-align: center; }
.query-meta { display: flex; align-items: center; min-height: 39px; margin: 0; padding: 0 16px; border-bottom: 1px solid #edf1f6; background: #fbfcfe; color: #8591a2; font-size: 10px; }
.table-panel { overflow: hidden; border: 1px solid #dfe7f1; border-radius: 14px; background: #fff; box-shadow: 0 10px 30px rgba(40,62,92,.06); }
.table-scroll { max-height: min(680px, calc(100vh - 300px)); overflow: auto; }
.table-scroll table { width: 100%; min-width: 0; table-layout: fixed; }
.table-scroll thead th { position: sticky; top: 0; z-index: 3; }
.table-scroll th, .table-scroll td { vertical-align: middle; }
.table-scroll td { color: #334155; }
/* Keep feature tables on the exact visual baseline used by 来源管理. */
.admin-feature-app .table-panel .directory-table {
  min-width: 980px !important;
  width: 100% !important;
  table-layout: fixed;
}
.admin-feature-app .table-panel .directory-table thead {
  box-shadow: inset 0 1px #e3eaf2, inset 0 -1px #dfe7f0;
}
.admin-feature-app .table-panel .directory-table th {
  height: 42px;
  padding: 0 12px;
  background: #f3f6fa;
  color: #526176;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .18px;
}
.admin-feature-app .table-panel .directory-table td {
  height: 72px;
  padding: 12px;
  border-bottom-color: #e9eef4;
  background: #fff;
  color: #334155;
  font-size: 11px;
}
.admin-feature-app .table-panel .directory-table tbody tr {
  box-shadow: none;
  transition: background-color 140ms ease;
}
.admin-feature-app .table-panel .directory-table tbody tr:nth-child(even) td {
  background: #fcfdff;
}
.admin-feature-app .table-panel .directory-table tbody tr:hover,
.admin-feature-app .table-panel .directory-table tbody tr:hover td {
  background: #f5f8fc;
  box-shadow: none;
}
.admin-feature-app .table-panel .directory-table tbody tr.selected-row td {
  background: #eff6ff;
  box-shadow: none;
}
.admin-feature-app .table-panel .directory-table tbody tr.selected-row td:first-child {
  box-shadow: inset 3px 0 #2563eb;
}
.admin-data-table { white-space: normal; }
.admin-data-table tbody tr { cursor: default; }
.admin-data-table tbody tr:hover { background: #f7faff; box-shadow: inset 3px 0 #9dc2fa; }
.admin-data-table tbody tr.selected-row { background: #eff6ff; }
.table-scroll input[type="checkbox"] { width: 15px; height: 15px; accent-color: #2563eb; }
.checkbox-column { width: 42px; padding-right: 3px !important; padding-left: 16px !important; text-align: center !important; }
.serial-column { width: 58px; color: #94a3b8 !important; font-variant-numeric: tabular-nums; }
.status-badge { display: inline-flex; padding: 3px 7px; border-radius: 999px; font-size: 10px; }
.role-badge { display: inline-flex; padding: 3px 7px; border-radius: 999px; font-size: 10px; }
.role-badge.admin { color: #7c2d12; background: #ffedd5; }
.role-badge.user { color: #1d4ed8; background: #dbeafe; }
.status-badge.active { color: #166534; background: #dcfce7; }.status-badge.disabled { color: #64748b; background: #f1f5f9; }
.table-action { margin-right: 8px; padding: 0; border: 0; color: #2563eb; background: transparent; font: inherit; font-size: 11px; cursor: pointer; }.table-action:hover { color: #1d4ed8; }
.empty-cell { padding: 34px 8px !important; color: #94a3b8 !important; text-align: center !important; }
.break-cell { max-width: 280px; overflow-wrap: anywhere; }
.user-avatar-cell { color: #468bb7; background: #edf7fb; }
.user-avatar-cell svg { width: 18px; height: 18px; }
.channel-count-button, .scope-link { padding: 3px 7px; border: 0; border-radius: 6px; color: #2563eb; background: #eff6ff; font: inherit; font-size: 11px; font-weight: 700; cursor: pointer; }
.channel-count-button:hover, .scope-link:hover { color: #1d4ed8; background: #dbeafe; }
.channel-count-button:focus-visible, .scope-link:focus-visible { outline: 2px solid #60a5fa; outline-offset: 2px; }
.modal-loading, .modal-empty { margin: 0; padding: 26px 0 4px; color: #64748b; font-size: 12px; text-align: center; }
.channels-modal { width: min(560px, 100%); }
.log-detail-modal { width: min(620px, 100%); }
.channel-chip-list { display: flex; flex-wrap: wrap; gap: 9px; padding-top: 22px; }
.channel-chip { display: inline-flex; align-items: center; min-height: 30px; padding: 5px 10px; border: 1px solid #dbeafe; border-radius: 999px; color: #1d4ed8; background: #eff6ff; font-size: 12px; }
.log-source-count-list { display: grid; gap: 8px; padding-top: 22px; }
.log-source-count-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 11px 13px; border: 1px solid #e5edf7; border-radius: 9px; background: #f8fbff; }
.log-source-name { min-width: 0; overflow-wrap: anywhere; color: #334155; font-size: 12px; }
.log-source-count-row strong { flex: 0 0 auto; color: #1d4ed8; font-size: 13px; font-variant-numeric: tabular-nums; }
.admin-data-table { min-width: 0 !important; width: 100% !important; }
.admin-data-table th { height: 38px; padding-top: 1px; color: #7f8b9d; background: #f8fafc; font-size: 9px; font-weight: 700; letter-spacing: .45px; }
.admin-data-table td { height: 82px; padding-top: 12px; padding-bottom: 12px; }
.admin-data-table tbody tr { transition: background 140ms ease, box-shadow 140ms ease; }
.admin-data-table .source-name { color: #1f2937; font-size: 12px; font-weight: 700; line-height: 1.35; }
.admin-data-table .source-description { margin: 0; color: #64748b; font-size: 10px; line-height: 1.4; }
.admin-data-table .row-actions { gap: 7px; justify-content: flex-start; }
.admin-data-table .row-actions .button.tiny, .admin-data-table .icon-button { border-radius: 8px; }

.user-table th:nth-child(1), .user-table td:nth-child(1) { width: 42px; }
.user-table th:nth-child(2), .user-table td:nth-child(2) { width: 58px; }
.user-table th:nth-child(3), .user-table td:nth-child(3) { width: 9%; }
.user-table th:nth-child(4), .user-table td:nth-child(4) { width: 20%; }
.user-table th:nth-child(5), .user-table td:nth-child(5) { width: 10%; }
.user-table th:nth-child(6), .user-table td:nth-child(6) { width: 10%; }
.user-table th:nth-child(7), .user-table td:nth-child(7) { width: 9%; }
.user-table th:nth-child(8), .user-table td:nth-child(8) { width: 13%; }
.user-table th:nth-child(9), .user-table td:nth-child(9) { width: 17%; }
.user-table th:nth-child(10), .user-table td:nth-child(10) { width: 22%; }
.log-table th:nth-child(1), .log-table td:nth-child(1) { width: 42px; }
.log-table th:nth-child(2), .log-table td:nth-child(2) { width: 58px; }
.log-table th:nth-child(3), .log-table td:nth-child(3) { width: 16%; }
.log-table th:nth-child(4), .log-table td:nth-child(4) { width: 18%; }
.log-table th:nth-child(5), .log-table td:nth-child(5) { width: 13%; }
.log-table th:nth-child(6), .log-table td:nth-child(6) { width: 12%; }
.log-table th:nth-child(7), .log-table td:nth-child(7) { width: 12%; }
.log-table th:nth-child(8), .log-table td:nth-child(8) { width: 16%; }
.log-table { min-width: 1120px !important; }
.log-table th:nth-child(9), .log-table td:nth-child(9) { width: 13%; }
.log-table th:nth-child(10), .log-table td:nth-child(10) { width: 9%; }
.policy-table th:nth-child(1), .policy-table td:nth-child(1) { width: 42px; }
.policy-table th:nth-child(2), .policy-table td:nth-child(2) { width: 58px; }
.policy-table th:nth-child(3), .policy-table td:nth-child(3) { width: 25%; }
.policy-table th:nth-child(4), .policy-table td:nth-child(4) { width: 16%; }
.policy-table th:nth-child(5), .policy-table td:nth-child(5) { width: 39%; }
.policy-table th:nth-child(6), .policy-table td:nth-child(6) { width: 20%; }
.table-panel :deep(.pagination) { min-height: 42px; padding: 0 20px; background: #fbfcfe; }
.user-list-actions { display: flex; align-items: center; gap: 9px; }
.admin-modal-backdrop { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; padding: 20px; background: rgba(15, 23, 42, .42); backdrop-filter: blur(3px); }
.admin-modal { width: min(460px, 100%); padding: 24px; border: 1px solid #e5e7eb; border-radius: 16px; background: #fff; box-shadow: 0 24px 70px rgba(15, 23, 42, .22); }
.admin-modal-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; padding-bottom: 20px; border-bottom: 1px solid #eef2f7; }.admin-modal-header h2 { margin: 0 0 6px; color: #111827; font-size: 20px; }.admin-modal-header p:not(.modal-eyebrow) { margin: 0; color: #64748b; font-size: 12px; line-height: 1.65; }
.modal-eyebrow { margin: 0 0 7px; color: #2563eb; font: 700 10px ui-monospace, SFMono-Regular, Consolas, monospace; letter-spacing: 1.6px; }.modal-close { display: grid; place-items: center; width: 32px; height: 32px; flex: 0 0 32px; padding: 0; border: 0; border-radius: 8px; color: #64748b; background: transparent; cursor: pointer; }.modal-close:hover { color: #111827; background: #f1f5f9; }
.create-user-modal-form { display: flex; flex-direction: column; gap: 15px; padding-top: 20px; }.modal-field { display: flex; flex-direction: column; gap: 7px; color: #374151; font-size: 12px; font-weight: 650; }.modal-field input { min-height: 42px; padding: 9px 11px; border: 1px solid #dbe1ea; border-radius: 8px; outline: none; color: #111827; background: #fff; font: inherit; font-size: 13px; font-weight: 400; }.optional-label { margin-left: 5px; color: #94a3b8; font-size: 11px; font-weight: 400; }.modal-error { display: flex; align-items: flex-start; gap: 7px; margin: 0; padding: 10px 11px; border: 1px solid #fecaca; border-radius: 8px; color: #b91c1c; background: #fef2f2; font-size: 11px; line-height: 1.5; }.admin-modal-actions { display: flex; justify-content: flex-end; gap: 9px; padding-top: 7px; }.modal-button { min-height: 40px; padding: 8px 15px; border: 1px solid transparent; border-radius: 8px; font: 600 12px inherit; cursor: pointer; }.modal-button.primary { border-color: #2563eb; color: #fff; background: #2563eb; }.modal-button.primary:hover:not(:disabled) { background: #1d4ed8; }.modal-button.secondary { border-color: #dbe1ea; color: #475569; background: #fff; }.modal-button.secondary:hover:not(:disabled) { background: #f8fafc; }.modal-button:disabled { cursor: wait; opacity: .55; }
@media (min-width: 821px) { .query-toolbar { flex-wrap: nowrap; }.query-actions { flex-wrap: nowrap; }.query-input { min-width: 180px; }.query-actions .button { flex: 0 0 auto; } }
@media (max-width: 820px) { .feature-heading { flex-direction: column; align-items: stretch; }.query-toolbar { align-items: stretch; }.query-input { min-width: 100%; }.query-select { width: 100%; flex: 1 1 100%; }.query-actions { width: 100%; }.query-actions .button { flex: 1 1 auto; } }
@media (max-width: 820px) { .analytics-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 700px) { .admin-data-table { min-width: 820px !important; }.query-toolbar { padding: 12px 16px; }.table-scroll { max-height: min(58vh, 560px); }.query-panel { top: calc(var(--console-topbar-height) + 6px); padding: 0; }.query-actions .button { flex: 1 1 calc(50% - 7px); }.admin-modal { padding: 20px; } }
</style>
