# PanHub · 全网网盘搜索

> 基于 Nuxt 4、Node.js 和 SQLite 的资源源聚合搜索。所有搜索来源都使用同一套 HTTP 请求参数和 `transform(payload, $, context)` 解析函数，不再区分 HTTP、Telegram 或插件搜索架构。

## 核心行为

- **统一资源源**：系统来源保存在 SQLite 的 `resource_sources`，每个来源包含 URL、请求方式、响应格式、请求配置、优先级和 transform；搜索会按优先级从高到低进入执行队列，同优先级保持来源目录顺序。
- **单次执行**：每个资源源每次搜索只发起一次请求、执行一次 transform；不自动分页、不使用 cursor、不做关键词变体、深度搜索、fallback 或来源级重试。
- **聚合最新结果**：所有来源并发执行，结果统一去重、按时间倒序排列，并只保留当前请求返回的首屏/最新部分。
- **唯一搜索入口**：`/api/search` 支持 GET 和 POST，返回 SSE。旧的 `/api/searchHttp*`、`/api/search/channels*` 入口已删除。
- **用户频道模板**：用户添加公开 Telegram 频道时，首次通过 `/api/tg/validate-channel` 校验公开性和可访问性；搜索时使用后台配置的 `source_template_settings` 动态生成资源源，并走同一执行器。
- **统一响应元数据**：响应的 `meta.sources` 列出本次实际参与的全部资源源，`meta.warnings` 汇总超时、网络、业务和解析告警。不再返回 `pluginVersions`、`registryVersion`、`http` 或 `tg` 分组。
- **安全执行**：请求经过 URL/DNS/重定向/请求体/响应体校验；transform 在受限 VM 中同步执行，不能访问网络、文件系统或进程环境。

## 快速开始

```bash
pnpm install
pnpm dev
```

生产环境：

```bash
pnpm build
node .output/server/index.mjs
```

默认 SQLite 文件为 `data/panhub.sqlite`，可通过 `PANHUB_SQLITE_DB` 覆盖。运行数据不应提交到 Git。

## 搜索示例

POST `/api/search`：

```json
{
  "kw": "三体"
}
```

只指定用户添加的频道：

```json
{
  "kw": "三体",
  "channels": ["example_channel"]
}
```

每个 SSE `result` 事件包含一个已完成资源源的增量；`complete` 事件包含最终 `total` 和 `meta`：

```json
{
  "sources": [
    {
      "id": "hunhepan",
      "name": "混合盘",
      "priority": 0,
      "version": "cfg-...",
      "status": "success",
      "resultCount": 3,
      "elapsedMs": 420
    }
  ],
  "warnings": []
}
```

## 后台配置

- `/admin/sources`：资源源配置、启停、导入导出、用户频道模板和来源诊断。
- `/admin/monitor`：资源源和频道健康状态。

资源源的 transform 形式：

```js
function transform(payload, $, context) {
  return [{
    id: "stable-resource-id",
    name: "资源标题",
    description: null,
    datetime: null,
    cloud_types: ["baidu"],
    links: [{ type: "baidu", url: "https://pan.baidu.com/s/xxx", password: null }]
  }];
}
```

`payload` 是本次唯一请求的原始响应，`$` 是 HTML 查询工具，`context` 至少包含 `keyword`、`source`、`format` 和 `rawBody`。解析函数只负责转换结果，不负责发起网络请求。

## 目录结构

```text
pages/                 页面
components/            Vue 组件
server/api/            H3/Nitro API
server/core/services/  搜索、资源源目录、模板、健康和系统设置
server/core/source-runtime/
                       资源源校验、请求执行和 transform 运行时
server/core/storage/   SQLite 结构
utils/                 前端/通用工具
```

## 验证

```bash
pnpm typecheck
pnpm run test:transforms
git diff --check
```

当前重构不提供旧 API 或旧 Plugin 兼容机制；数据库启动时会自动补齐资源源优先级字段。需要重置本地开发数据时，请停止服务后删除 `data/panhub.sqlite` 再启动。

## 搜索压力测试

脚本会为每次搜索先调用 `/api/account/session` 获取新的匿名 `panhub_session` Cookie，再调用搜索接口，避免复用同一会话触发会话级限流。默认使用 `/api/search/json`，因为该接口会返回每个资源源的 `elapsedMs`、`transformMs` 和 warnings；每次测试会把明细追加到 JSONL，并生成汇总 JSON。

```bash
# 默认：300 次搜索，20 个客户端并发，180 秒内完成
pnpm test:stress-search

# 指定部署地址、并发度和报告目录
pnpm test:stress-search -- \
  --base-url http://111.119.233.153:3000 \
  --requests 300 \
  --concurrency 20 \
  --duration-seconds 180 \
  --output .tmp/my-search-stress
```

报告包含每轮的接口状态、失败资源源、源接口失败、transform 失败、transform 总耗时、上游耗时和 warnings。若部署版本没有返回 `meta.sources[].transformMs`，transform 总耗时会显示为 0，表示服务端未上报该字段，不代表 transform 实际耗时为 0。需要模拟浏览器 SSE 时可追加 `--mode sse`，但 SSE 接口不会暴露源级 transform 诊断。
