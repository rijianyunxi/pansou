# PanHub 当前整改清单

> 更新日期：2026-09-16
>
> 本文件只记录当前架构和真正未完成的事项；已废弃的 HTTP/Telegram 分层、Parser Plugin、分页、深度搜索、关键词变体、fallback、重试和旧数据库兼容迁移不再列入 TODO。

## 当前架构约束

- 所有可搜索对象统一称为**资源源**，持久化在 SQLite 的 `resource_sources`。
- 每个资源源只执行一次请求、一次 `transform(payload, $, context)`，然后转换为统一资源结果。
- `/api/search` 是唯一搜索入口，支持 GET 查询参数和 POST JSON；搜索结果通过 SSE 返回。
- 不提供分页、cursor、深度搜索或关键词变体；每个资源源只返回本次请求得到的首屏/最新部分，聚合后按时间倒序输出。
- 系统来源和用户频道来源都走同一套资源源执行器：系统来源读取自身配置，用户频道使用后台保存的 `source_template_settings` 动态生成临时资源源。
- 用户添加频道只保存在浏览器；首次添加必须调用 `/api/tg/validate-channel`，确认频道用户名有效、公开且页面可访问后才写入浏览器设置。
- `meta.sources` 展示本次实际参与的全部资源源，`meta.warnings` 汇总失败、超时和业务告警；不再返回 `pluginVersions`、`registryVersion`、`http` 或 `tg` 分组。
- 不兼容旧 API、旧 Plugin 机制、旧 TG 来源字段或旧数据库结构。当前数据库只使用 `resource_sources`、`deleted_sources`、`source_template_settings` 和搜索/账户/健康相关表。

## 已完成

- [x] 删除独立的 Telegram 搜索链路、PluginManager、Parser Plugin 兼容层和旧搜索入口。
- [x] 删除自动分页、fallback、Jina 镜像链路、关键词变体和来源级重试。
- [x] 将系统来源和 Telegram 频道统一接入单请求/单解析执行器。
- [x] 增加后台用户频道资源源模板配置，并在用户添加频道时做公开性和可访问性校验。
- [x] 将搜索响应的来源诊断与 warnings 合并到 `meta`，并展示所有实际参与的资源源。
- [x] 清理旧 SQLite 表、旧迁移代码和旧数据库字段；当前数据库已切换到资源源模型。
- [x] 删除 `fetchWithRetry`、`fetchRawWithRetry`、`safeExecute`、`safeExecuteAll` 等废弃重试/批量封装。
- [x] 离线 transform 测试覆盖当前资源源格式；`pnpm typecheck`、`pnpm run test:transforms`、`git diff --check` 通过。

## 仍未完成

### P1：来源质量

- [ ] **PanSearch 线上恢复验证**：确认当前已入库的 URL、请求参数和 transform 与线上首屏响应一致；补充脱敏响应样本并验证业务错误、空结果和结构变化。
- [ ] **各资源源正式 fixture**：为混合盘、PanSearch、Nyaa 和公共频道模板补齐固定响应样本，避免线上结构变化只能通过日志发现。
- [ ] **来源编辑器校验增强**：保存前提供一次性请求/解析试运行结果，明确显示请求状态、解析数量和错误位置。

### P2：结果质量与运维

- [ ] 规范化分享链接并去除无关追踪参数后再去重。
- [ ] 将同一资源的多个来源合并展示，并保留来源诊断信息。
- [ ] 增加标题命中和时间排序之外的轻量相关性排序。
- [ ] 增加异步失效链接检测，不阻塞首屏搜索。
- [ ] 增加多实例环境下的健康状态共享；当前健康状态仍是单实例内存数据。

## 验证命令

```bash
pnpm typecheck
pnpm run test:transforms
git diff --check
```

不要为了验证启动长期开发服务；需要接口联调时只做短时启动并及时停止。
