# 资源源 transform 审计记录

> 更新时间：2026-09-16

当前审计脚本只按 `resource_sources` 读取来源，不再根据 URL 推断 HTTP/Telegram 类型，也不再执行分页、fallback、Jina 镜像或来源级重试。

## 当前规则

- 每个资源源只执行一次请求。
- 每个资源源只执行一次 `transform(payload, $, context)`。
- transform 必须返回统一资源数组；无有效资源时记为零结果，不再触发第二条抓取链路。
- 用户频道不写入独立来源插件表，而是由 `source_template_settings` 生成临时资源源。

## 验证命令

```bash
pnpm run test:transforms
pnpm run test:transforms:configured
pnpm exec jiti scripts/test-transforms-replay.ts
pnpm run typecheck
```

`test:transforms` 使用固定脱敏 fixture；`--configured` 直接读取当前 `resource_sources`。真实线上响应不提交到仓库，避免把频道全文和敏感请求数据带入版本库。

最近一次离线验证：

```text
4 sources; 45 passed; 0 failed
```
