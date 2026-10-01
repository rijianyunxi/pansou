# 删除长期保存的采集原文

迁移 019 删除 `source_messages.raw_html`，不是清空或删除消息表。
消息编号、时间、解析状态/错误、哈希/版本、资源关联及搜索索引继续保留。
采集到的 HTML 只在内存中用于解析和计算哈希；不再持久化原文。
后台删除原文、摘要、规则预览功能及对应预览 API；消息详情仍可查看已存资源。

## 已部署数据库

1. 停止所有旧 API、采集 Worker 和链接 Worker，关闭数据库客户端的未提交事务。
2. 使用新代码启动（开发环境可用 `PANSOU_EMBEDDED_WORKERS=false cargo run`），启动过程自动执行迁移 019。不要手动先删列，也不要修改历史迁移或迁移记录。
3. 停止新服务，在维护窗口用 psql 或 Navicat 的自动提交模式执行下面 SQL。必须逐条执行，不能包装进事务；确认已连接目标数据库。

```sql
SET lock_timeout = '5s';
SET statement_timeout = '10min';
VACUUM (FULL, ANALYZE) public.source_messages;
```

4. 确认清理完成后重启新 API / Worker。

删列使原文不可再查询，但不会立即缩小旧数据文件；`VACUUM FULL` 重写表并回收文件空间，期间独占锁表，需要额外磁盘空间。锁超时应先排查正在访问该表的事务，不要强杀连接。普通 `VACUUM` 不能替代这次空间回收。参考 [PostgreSQL ALTER TABLE](https://www.postgresql.org/docs/18/sql-altertable.html) 和 [VACUUM](https://www.postgresql.org/docs/18/sql-vacuum.html)。

## 核对

```sql
SELECT version, success FROM public._sqlx_migrations WHERE version = 19;
SELECT column_name FROM information_schema.columns
 WHERE table_schema='public' AND table_name='source_messages' AND column_name='raw_html';
SELECT count(*) AS messages FROM public.source_messages;
SELECT count(*) AS occurrences FROM public.resource_occurrences;
SELECT count(*) AS resources FROM public.managed_resources;
SELECT pg_size_pretty(pg_total_relation_size('public.source_messages')) AS table_with_indexes;
```

原文删除不可逆，回退旧程序不能恢复原文，旧程序也不能连接已删列的数据库继续写入。
如需恢复只能使用清理前外部备份，或重新抓取上游仍可访问的消息；已解析资源不受影响。

## 本地清理验证（2026-10-02）

目标为本地 Docker PostgreSQL 18 的 `pansou`，迁移 019 已成功执行。
停止 API/Worker，确认无消息表锁后单独执行 `VACUUM (FULL, ANALYZE)`，约 4.2 秒完成。

| 核对项 | 清理前 | 清理后 |
| --- | ---: | ---: |
| 消息表总空间（含索引/TOAST） | 6,092,062,720 字节（5.67 GiB） | 485,056,512 字节（463 MiB） |
| 消息数 | 1,346,154 | 1,346,154 |
| 资源数 | 397,038 | 397,038 |
| 资源关联数 | 1,170,589 | 1,170,589 |
| 检索资源投影数 | 397,038 | 397,038 |
| 检索关联投影数 | 1,170,589 | 1,170,589 |

回收 5,607,006,208 字节（约 5.22 GiB）。TOAST 文件已缩到 8 KiB。
按消息编号、频道、哈希、解析版本/状态/错误、发布时间和更新时间计算的汇总校验值完全一致；10 个频道的统计记录汇总校验值也一致。
这不是消息表清空，没有删除资源或关联。

验证包含旧版 001–018 完整结构带原文升级到 019、消息元数据及外键关联保留、无原文的新采集/搜索、列表及详情不返回原文字段、已删除预览 API 返回 404。
开发页面用隔离模拟数据检查了 375px 窄屏和横屏的消息列表、详情、空状态和错误提示，不使用业务管理员账号或写入真实服务。
