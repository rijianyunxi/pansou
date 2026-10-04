# SQLx 离线元数据

此目录的 `query-*.json` 由 SQLx 查询宏连接数据库后生成，记录查询的参数、列类型和可空性，不包含连接凭据或业务数据。

目前覆盖来源加载与探测、来源健康快照、搜索日志创建，以及本地标题/grams 查询和索引版本读取。动态管理查询仍使用 `QueryBuilder` 或运行时查询，不能据此认为全部 SQL 都有编译期检查。

普通构建无需数据库：

```sh
SQLX_OFFLINE=true cargo check --all-targets
SQLX_OFFLINE=true cargo build --release
```

修改已检查的 SQL 或其依赖结构后，先给开发数据库应用当前迁移，在环境中设置 `DATABASE_URL`（也接受 `PANSOU_DATABASE_URL`），再执行：

```sh
bash scripts/prepare-sqlx.sh
```

脚本不读取或执行 `.env`，不应用迁移，也不执行业务查询；它只让 SQLx 分析 SQL 并重新生成类型元数据。保留与当前宏查询对应的 JSON 文件，将 SQL 修改和元数据一起纳入版本管理。
