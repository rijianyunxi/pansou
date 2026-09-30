# 管理后台 UI 架构

管理后台使用 Vue 3 + shadcn-vue（new-york / neutral）+ Reka UI + Tailwind CSS 4。范围仅为 /admin/\*\*；首页搜索组件、样式与搜索协议保持不变。

## 目录与职责

- frontend/components/admin/AdminLayout.vue：唯一后台布局、登录门禁、顶栏面包屑与弹层容器（不再显示独立页面标题/说明区域）。
- frontend/components/admin/AdminSidebar.vue + navigation.ts：唯一导航配置，分组、路由高亮、图标折叠、移动端抽屉与账户菜单。
- frontend/components/admin/ui/：项目实际使用的 shadcn-vue 基础组件；未使用的生成组件已删，按需再添加。
- frontend/components/admin/AdminDialog.vue：Dialog / Sheet 的统一弹窗入口，负责可访问标题、焦点管理和 Esc 关闭。
- frontend/components/admin/AdminRowActions.vue：统一表格行操作菜单，保留原有按钮权限与禁用状态。
- frontend/components/admin/AdminSelect.vue、AdminCheckbox.vue、AdminPagination.vue：业务表单与分页封装。
- frontend/composables/admin/useAdminSession.ts：由布局提供共享后台会话，页面不重复登录检查。
- frontend/composables/admin/useAdminConfirm.ts：由布局提供异步确认，离开页面或卸载时安全取消。
- frontend/lib/adminControls.ts：选择器和复选框纯逻辑，可单独回归测试。
- frontend/assets/admin.css：后台专属主题与共享布局样式。
- frontend/components.json：shadcn-vue 注册表配置，后续组件加到管理端 ui 目录，不写入公共组件目录。

## 首页隔离原则

1. /admin 是 lazy-loaded 的嵌套路由，所有页面使用同一 AdminLayout。
2. admin.css 只由 AdminLayout 引入；不向 app.vue、首页或公共搜索组件引入它。
3. Tailwind 使用 tw: 前缀，仅加载 theme / utilities，**不加载 preflight 全局重置**。
4. 手写后台样式、局部重置和主题变量限制在 .admin-root 内。
5. Reka Portal 指向 #admin-portals，保证菜单、选择器、Dialog 与 Sheet 使用同一管理端主题。
6. 公共 ResourceDescription 等组件不做全局替换；后台使用时保持原组件，避免影响首页。

## 开发规范

- 基础交互使用 ui/ 下组件，不再自行维护原生 dialog、手工焦点陷阱、body 滚动锁和 window.confirm。
- 后台页只保留数据加载和业务操作；重复菜单、顶栏、登录表单、分页与弹窗行为交给共享组件。
- 表单数值保留 number 类型，空筛选选项由 Select 封装转换，复选框支持数组、全选和半选。
- 保留当前 Rust API 的请求与响应结构，不为了 UI 改数据库或接口契约。
- 不保留未使用的整个组件库。增加组件时使用 frontend/components.json 对应的 shadcn-vue 配置，并检查 tw: 前缀与 Portal 目标。

## 验证

在 frontend 目录运行：

```powershell
npm run typecheck
npm test
npm run build
```

回归覆盖：GET/POST 隐式选项、空筛选、数字分页、动态选项、禁用选项、复选框数组和半选、Boolean 默认值、单一懒加载后台布局、模板语法与首页样式隔离。

浏览器验收使用本机临时只读代理：仅转发读取请求，写入请求返回模拟错误，不创建管理员、不修改业务数据。该代理只用于验收，不属于产品服务。

## 弹窗、抽屉与表单规范

- AdminDialog 统一渲染可见标题、说明和唯一关闭按钮，调用方不重复添加标题栏。
- 表单采用 admin-dialog-form / admin-form-fields：中间字段区滚动，底部错误与保存、取消按钮保持可见；抽屉同样只有一个主滚动区。
- 点击遮罩不丢弃输入；非提交状态支持 Esc 关闭并恢复焦点。提交中阻止重复保存和意外关闭。
- 来源编辑由父页面维护 saving/error：保存成功才关闭，失败保留字段并在底部显示 role=alert 错误。
- 危险操作使用共享 AlertDialog，默认聚焦取消；不在布局验收中执行删除。

## 样式与响应式约束

- admin-layout.css 负责表格、工具栏、设置卡片与控件；admin-overlays.css 负责弹层尺寸、滚动和表单。均通过 admin.css 加载，选择器限定于 .admin-root。
- 遗留业务 scoped 样式置于 components 层，避免覆盖 shadcn 工具类；Portal 弹层不依赖原页面祖先选择器。
- 后台单独覆盖公共移动端 44px 最小尺寸，Switch 保持 32×18、Checkbox 保持 16×16，不更改公共页面规则。
- 窄屏表单改单列，抽屉占满视口；低高度窗口保持弹层标题和操作区可见。工具栏和分页允许换行。
- Table 通过 ResizeObserver 判断真实溢出，仅溢出时展示横向滚动提示及可聚焦区域；资源表限制长标题、链接列宽，固定右侧操作列。
- 加载期间展示加载态，避免先闪现“暂无数据”。

## 本轮验收覆盖

- 页面：运行监控、来源管理、TG 采集、代理管理、资源管理、热搜管理、用户管理、搜索日志、系统设置。
- 视口：桌面 1280×720、窄屏 390×844 / 320×740、低高度 1280×480。
- 交互：来源编辑/详情/调试、代理策略/节点、资源编辑、用户与频道、日志详情、热词编辑、监控设置/失败记录、危险操作取消；保存错误不关闭表单。
- 验收截图与几何检查记录保存于本地 data/ui-audit；布局测试补充模板实际编译、样式隔离、滚动与保存状态约束。
