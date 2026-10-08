# 代码架构与维护边界

本文描述当前仓库的代码职责，不作为旧版本的升级脚本。

## Web 运行时

[前端构建配置](../frontend/vite.config.ts)将 Vue 与 Vue Router 打包到本地 `vue-vendor` chunk，版本由 `frontend/package-lock.json` 锁定。生产 HTML 及运行时模块均从同源 `/assets/` 加载，不依赖公共 CDN；Vite 生成带内容哈希的文件名及 modulepreload。

管理页面仍通过动态 import 按需加载。构建继续生成 gzip 预压缩文件；后端静态文件服务配置见 [app.rs](../src/app.rs)。构建时安装依赖需要包仓库，但部署后的前端运行时不需要访问第三方模块服务器。

验证命令（在 `frontend` 目录）：

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run test:build
```

`test:build` 在独立临时目录执行真实生产构建，检查 HTML、vendor chunk 和生成模块的本地 import，并清理临时产物；不覆盖已有 `frontend/dist`。

## 后端模块

| 模块 | 职责 |
| --- | --- |
| [main.rs](../src/main.rs) | 配置、迁移、启动模式、Worker 生命周期及关停 |
| [app.rs](../src/app.rs) | AppState、显式 API 路由及静态文件服务 |
| [handlers/admin.rs](../src/handlers/admin.rs) | 管理接口模块声明、兼容导出和共享字符串列表辅助 |
| [admin/account.rs](../src/handlers/admin/account.rs) | 管理员个人账号 |
| [admin/resources.rs](../src/handlers/admin/resources.rs) | 资源列表、筛选、创建和批量操作 |
| [admin/hot_searches.rs](../src/handlers/admin/hot_searches.rs) | 热搜列表、维护和审核操作 |
| [admin/proxies.rs](../src/handlers/admin/proxies.rs) | 代理节点维护、引用与重置 |
| [admin/search_logs.rs](../src/handlers/admin/search_logs.rs) | 搜索日志查询、分页、序列化与统计；用户日志也在此复用同一序列化 |
| [admin/users.rs](../src/handlers/admin/users.rs) | 用户启停、频道偏好和会话撤销 |
| [admin/monitoring.rs](../src/handlers/admin/monitoring.rs) | 监控重置 |
| [handlers/search.rs](../src/handlers/search.rs) | 搜索鉴权与 JSON/SSE 入口；子模块负责执行、缓存、日志和分页 |
| [cloud_drive/extended.rs](../src/cloud_drive/extended.rs) | Token 网盘适配器初始化、公共请求协议和账号校验 |
| [extended/credentials.rs](../src/cloud_drive/extended/credentials.rs) | 凭证校验与受限请求头构造 |
| [extended/listing.rs](../src/cloud_drive/extended/listing.rs) | 文件模型、列表分页、分享解析 |
| [extended/operations.rs](../src/cloud_drive/extended/operations.rs) | 转存、分享、删除及异步任务确认 |
| [extended/tests.rs](../src/cloud_drive/extended/tests.rs) | Token 网盘协议回归测试 |
| [runtime.rs](../src/runtime.rs) | 后台任务开关、容量、租约调度与关停辅助 |

## 拆分约定

- `crate::handlers` 继续导出原接口名，路由不随内部文件拆分改变。
- 每个管理子模块自行调用 `admin_only`，不把鉴权假设隐藏在前端或上层路由中。
- 跨业务辅助仅在确有复用时放到共享模块；资源 SQL、热搜事务和用户管理保持各自边界。
- 网盘 API 主机固定在后端，不接受前端任意地址或请求头。
- 结构拆分不修改 SQL、请求参数、重试、幂等、租约或事务语义。
- `cargo test --locked` 不连接业务库；数据库集成测试须使用专用测试 PostgreSQL 与非零 Redis DB，详见 [数据库迁移说明](../migrations/README.md)。

这次拆分覆盖管理接口与 Token 网盘适配器。`cloud_auth/providers.rs`、链接交付与采集编排仍较大，后续应在对应协议/集成测试保护下按职责继续拆分，不应为了行数拆出第二套业务实现。
