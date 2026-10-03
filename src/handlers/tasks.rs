use super::common::{admin_only, ok};
use crate::{app::AppState, error::ApiError};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::HeaderMap,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{PgConnection, Postgres, QueryBuilder, Row};
use std::sync::Arc;
use uuid::Uuid;

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskQuery {
    status: Option<String>,
    provider: Option<String>,
    before: Option<String>,
    page: Option<i64>,
    page_size: Option<i64>,
}
#[derive(Deserialize)]
struct Cursor {
    kind: String,
    at: DateTime<Utc>,
    id: String,
}

fn validate(kind: &str, q: &TaskQuery) -> Result<Option<Cursor>, ApiError> {
    if q.page.is_some_and(|p| !(1..=100000).contains(&p))
        || q.page_size
            .is_some_and(|size| ![10, 20, 30, 50].contains(&size))
        || q.before.is_some() && q.page.is_some()
    {
        return Err(ApiError::BadRequest("分页参数无效".into()));
    }
    if !matches!(
        kind,
        "crawl" | "sync" | "checks" | "resolve" | "operations" | "maintenance"
    ) {
        return Err(ApiError::BadRequest("未知任务类型".into()));
    }
    let allowed: &[&str] = match kind {
        "sync" => &["all", "queued"],
        "resolve" => &[
            "all",
            "attention",
            "queued",
            "running",
            "completed",
            "failed",
        ],
        "operations" => &[
            "all",
            "attention",
            "running",
            "completed",
            "failed",
            "uncertain",
        ],
        "maintenance" => &["all", "attention", "completed", "failed"],
        "checks" => &[
            "all",
            "attention",
            "queued",
            "running",
            "completed",
            "failed",
        ],
        _ => &[
            "all",
            "attention",
            "queued",
            "running",
            "completed",
            "failed",
            "paused",
            "cancelled",
        ],
    };
    if !allowed.contains(&q.status.as_deref().unwrap_or("all")) {
        return Err(ApiError::BadRequest("该任务类型不支持此状态".into()));
    }
    if let Some(p) = q.provider.as_deref().filter(|p| !p.is_empty()) {
        if !matches!(kind, "checks" | "resolve" | "operations") {
            return Err(ApiError::BadRequest("该任务类型不支持网盘筛选".into()));
        }
        crate::cloud_drive::Provider::from_name(p)?;
    }
    if q.before.as_ref().is_some_and(|s| s.len() > 2048) {
        return Err(ApiError::BadRequest("分页游标过长".into()));
    }
    let cursor = q
        .before
        .as_deref()
        .map(|s| {
            serde_json::from_str::<Cursor>(s)
                .map_err(|_| ApiError::BadRequest("分页游标无效".into()))
        })
        .transpose()?;
    if let Some(c) = &cursor {
        let valid = match kind {
            "resolve" | "operations" => Uuid::parse_str(&c.id).is_ok(),
            "sync" => !c.id.is_empty() && c.id.len() <= 256,
            _ => c.id.parse::<i64>().is_ok_and(|n| n > 0),
        };
        if !valid || c.kind != kind {
            return Err(ApiError::BadRequest("分页游标不属于此类任务".into()));
        }
    }
    Ok(cursor)
}

// Keep catalog.provider as the source of truth: queued-job snapshots do not
// necessarily follow provider changes for completed/running/reshared jobs.
fn push_check_candidates<'a>(sql: &mut QueryBuilder<'a, Postgres>, q: &'a TaskQuery) {
    let provider = q.provider.as_deref().filter(|p| !p.is_empty());
    let status = q.status.as_deref().unwrap_or("all");
    let branches: &[(&str, bool)] = if status == "attention" {
        &[
            ("j.status='failed'", false),
            ("j.status='running' AND j.lease_until<=now()", false),
            ("c.failure_count>0", true),
        ]
    } else {
        &[("true", false)]
    };
    for (i, (predicate, needs_catalog)) in branches.iter().enumerate() {
        if i > 0 {
            // A failed/expired task may also reference a failed link. UNION
            // preserves the old OR predicate's one-row-per-task semantics.
            sql.push(" UNION ");
        }
        sql.push("SELECT j.id,j.created_at FROM link_check_jobs j");
        if provider.is_some() || *needs_catalog {
            sql.push(" JOIN link_catalog c ON c.id=j.link_id");
        }
        sql.push(" WHERE ").push(*predicate);
        if let Some(provider) = provider {
            sql.push(" AND c.provider=").push_bind(provider);
        }
        if status != "all" && status != "attention" {
            sql.push(" AND j.status=").push_bind(status);
        }
    }
}

async fn check_task_page(
    connection: &mut PgConnection,
    q: &TaskQuery,
    cursor: Option<&Cursor>,
    projection: &str,
) -> Result<(i64, Vec<Value>), ApiError> {
    let mut count = QueryBuilder::<Postgres>::new("SELECT count(*) FROM (");
    push_check_candidates(&mut count, q);
    count.push(") candidates");
    let total = count
        .build_query_scalar::<i64>()
        .fetch_one(&mut *connection)
        .await?;

    let mut sql = QueryBuilder::<Postgres>::new("WITH candidates AS (");
    push_check_candidates(&mut sql, q);
    sql.push("), page AS MATERIALIZED (SELECT id,created_at FROM candidates");
    if let Some(cursor) = cursor {
        sql.push(" WHERE (created_at,id)<(")
            .push_bind(cursor.at)
            .push(",")
            .push_bind(
                cursor
                    .id
                    .parse::<i64>()
                    .map_err(|_| ApiError::BadRequest("分页游标无效".into()))?,
            )
            .push(")");
    }
    let page_size = q.page_size.unwrap_or(30);
    sql.push(" ORDER BY created_at DESC,id DESC LIMIT ")
        .push_bind(page_size + 1)
        .push(" OFFSET ")
        .push_bind((q.page.unwrap_or(1) - 1) * page_size)
        .push(") SELECT jsonb_build_object(")
        .push(projection)
        .push(") item FROM page p JOIN link_check_jobs j ON j.id=p.id JOIN link_catalog c ON c.id=j.link_id ORDER BY p.created_at DESC,p.id DESC");
    let items = sql
        .build_query_scalar::<Value>()
        .fetch_all(&mut *connection)
        .await?;
    Ok((total, items))
}

pub async fn background_tasks(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Path(kind): Path<String>,
    Query(q): Query<TaskQuery>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&h, &s).await?;
    let cursor = validate(&kind, &q)?;
    let page = q.page.unwrap_or(1);
    // Keep the legacy cursor API's default batch size for existing clients.
    let page_size = q.page_size.unwrap_or(30);
    // Explicit field allowlists: never return request snapshots, account keys,
    // passwords, credentials, response bodies or file-access tokens.
    let (projection, source, condition, order, id_cast) = match kind.as_str() {
        "crawl" => (
            "'id',j.id::text,'title',j.channel_id,'kind',j.kind,'status',j.status,'createdAt',j.created_at,'updatedAt',j.updated_at,'attempts',j.attempts,'runAfter',j.next_run_at,'leaseUntil',j.lease_until,'pages',j.pages,'messages',j.messages,'resources',j.resources,'errorCode',CASE WHEN j.last_error IS NOT NULL THEN 'crawl_failed' END,'canRetry',j.status='failed' AND c.enabled,'canCancel',j.status IN('queued','running','paused')",
            "crawl_jobs j JOIN crawl_channels c ON c.id=j.channel_id",
            "($1='' ) AND ($2='all' OR $2='attention' AND (j.status='failed' OR j.status='running' AND j.lease_until<=now()) OR j.status=$2)",
            "j.created_at",
            "bigint",
        ),
        "sync" => (
            "'id',j.resource_id,'title',r.name,'kind','link-sync','status','queued','createdAt',j.updated_at,'updatedAt',j.updated_at,'revision',r.links_revision,'canRetry',false,'canCancel',false",
            "link_sync_queue j JOIN managed_resources r ON r.id=j.resource_id",
            "$1='' AND $2 IN('all','queued')",
            "j.updated_at",
            "text",
        ),
        "checks" => (
            "'id',j.id::text,'title',c.identity,'provider',c.provider,'kind',j.kind,'status',j.status,'createdAt',j.created_at,'updatedAt',j.updated_at,'attempts',j.attempts,'runAfter',j.run_after,'leaseUntil',j.lease_until,'validity',CASE WHEN j.kind='original' THEN CASE WHEN c.valid_until>now() THEN c.validity ELSE -1 END END,'lastAttemptAt',c.last_attempt_at,'checkedAt',c.checked_at,'failureCount',c.failure_count,'errorCode',COALESCE(j.last_error_code,CASE WHEN j.kind='original' THEN c.last_error_code END),'originalUrl',c.original_url,'canRetry',j.kind='original' AND (j.status<>'running' OR j.lease_until<=now()),'canCancel',false",
            "link_check_jobs j JOIN link_catalog c ON c.id=j.link_id",
            "($1='' OR c.provider=$1) AND ($2='all' OR $2='attention' AND (j.status='failed' OR c.failure_count>0 OR j.status='running' AND j.lease_until<=now()) OR j.status=$2)",
            "j.created_at",
            "bigint",
        ),
        "resolve" => (
            "'id',j.id::text,'title',c.identity,'provider',c.provider,'kind','resolve','status',j.status,'createdAt',j.created_at,'updatedAt',j.updated_at,'deadlineAt',j.deadline_at,'delivery',j.delivery,'reasonCode',j.reason_code,'resultKind',j.result_kind,'cacheHit',j.response_json->'cacheHit','originalUrl',c.original_url,'canRetry',false,'canCancel',false",
            "link_resolve_requests j JOIN link_catalog c ON c.id=j.link_id",
            "($1='' OR c.provider=$1) AND ($2='all' OR $2='attention' AND (j.status='failed' OR j.result_kind='unavailable' OR j.delivery='original' AND j.reason_code NOT IN('delivery_disabled','unsupported_provider') OR j.status IN('queued','running') AND j.deadline_at<=now()) OR j.status=$2)",
            "j.created_at",
            "uuid",
        ),
        "operations" => (
            "'id',j.request_key::text,'title',j.action,'provider',j.provider,'kind',j.action,'status',CASE WHEN j.status='running' AND j.expires_at<=now() THEN 'uncertain' ELSE j.status END,'createdAt',j.created_at,'updatedAt',j.updated_at,'deadlineAt',j.expires_at,'httpStatus',j.http_status,'canRetry',false,'canCancel',false",
            "cloud_drive_operations j",
            "($1='' OR j.provider=$1) AND ($2='all' OR $2='attention' AND (j.status IN('failed','uncertain') OR j.status='running' AND j.expires_at<=now()) OR $2='uncertain' AND j.status='running' AND j.expires_at<=now() OR j.status=$2 AND NOT ($2='running' AND j.expires_at<=now()))",
            "j.created_at",
            "uuid",
        ),
        _ => (
            "'id',j.id::text,'title',j.lane,'kind',j.lane,'status',j.status,'createdAt',j.created_at,'updatedAt',j.created_at,'durationMs',j.duration_ms,'errorCode',j.error_code,'canRetry',false,'canCancel',false",
            "worker_task_runs j",
            "$1='' AND ($2='all' OR $2='attention' AND j.status='failed' OR j.status=$2)",
            "j.created_at",
            "bigint",
        ),
    };
    let id = match kind.as_str() {
        "sync" => "j.resource_id",
        "operations" => "j.request_key",
        _ => "j.id",
    };
    let (total, mut items) = if kind == "checks" {
        let mut connection = s.pool.acquire().await?;
        check_task_page(&mut connection, &q, cursor.as_ref(), projection).await?
    } else {
        let count_sql = format!("SELECT count(*) FROM {source} WHERE ({condition})");
        let total: i64 = sqlx::query_scalar(&count_sql)
            .bind(q.provider.as_deref().unwrap_or(""))
            .bind(q.status.as_deref().unwrap_or("all"))
            .fetch_one(&s.pool)
            .await?;
        let sql = format!(
            "SELECT jsonb_build_object({projection}) item FROM {source} WHERE ({condition}) AND ($3::timestamptz IS NULL OR ({order},{id})<($3,$4::text::{id_cast})) ORDER BY {order} DESC,{id} DESC LIMIT $5 OFFSET $6"
        );
        let items: Vec<Value> = sqlx::query_scalar(&sql)
            .bind(q.provider.as_deref().unwrap_or(""))
            .bind(q.status.as_deref().unwrap_or("all"))
            .bind(cursor.as_ref().map(|c| c.at))
            .bind(cursor.as_ref().map(|c| c.id.as_str()))
            .bind(page_size + 1)
            .bind((page - 1) * page_size)
            .fetch_all(&s.pool)
            .await?;
        (total, items)
    };
    let more = items.len() > page_size as usize;
    items.truncate(page_size as usize);
    let next = if more {
        items
            .last()
            .map(|v| json!({"kind":kind,"at":v["createdAt"],"id":v["id"]}).to_string())
    } else {
        None
    };
    let enabled = match kind.as_str() {
        "crawl"=>Some(crate::runtime::settings(&s).await?.crawl_enabled),
        "checks"=>Some(sqlx::query_scalar::<_,bool>("SELECT COALESCE((value_json->>'enabled')::boolean,false) FROM policy_settings WHERE key='link-check'").fetch_one(&s.pool).await?),
        _=>None,
    };
    let worker_state = match kind.as_str() {
        "crawl" => super::monitoring::worker_status(&s, crate::runtime::WorkerKind::Crawl, true)
            .await["state"]
            .clone(),
        "sync" | "checks" | "maintenance" => super::monitoring::worker_status(
            &s,
            crate::runtime::WorkerKind::Links,
            true,
        )
        .await["state"]
            .clone(),
        _ => Value::Null,
    };
    Ok(ok(
        json!({"items":items,"total":total,"page":page,"pageSize":page_size,"hasMore":more,"nextCursor":next,"enabled":enabled,"workerState":worker_state}),
    ))
}

pub async fn background_check_retry(
    State(s): State<Arc<AppState>>,
    h: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&h, &s).await?;
    let mut tx = s.pool.begin().await?;
    // Same global lock order as check recording and link synchronization.
    crate::crawl::lock_index(&mut tx).await?;
    let enabled:bool=sqlx::query_scalar("SELECT COALESCE((value_json->>'enabled')::boolean,false) FROM policy_settings WHERE key='link-check'").fetch_one(&mut *tx).await?;
    if !enabled {
        return Err(ApiError::Conflict(
            "有效性检测已关闭，请先在系统设置启用；重新检测不会绕过策略或额度".into(),
        ));
    }
    let row=sqlx::query("SELECT j.link_id,j.kind,c.provider FROM link_check_jobs j JOIN link_catalog c ON c.id=j.link_id WHERE j.id=$1")
        .bind(id).fetch_optional(&mut *tx).await?.ok_or_else(||ApiError::NotFound("检测任务不存在".into()))?;
    if row.get::<String, _>("kind") != "original" {
        return Err(ApiError::Conflict("此任务不支持手动重检".into()));
    }
    let provider = row.get::<String, _>("provider");
    crate::cloud_drive::Provider::from_name(&provider)?;
    let configured:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM cloud_account_settings WHERE provider=$1 AND length(trim(credential))>0)")
        .bind(&provider).fetch_one(&mut *tx).await?;
    if !configured {
        return Err(ApiError::Conflict(
            "该网盘未配置登录凭据，请先配置账号".into(),
        ));
    }
    let link: Uuid = row.get("link_id");
    // Lock queued rows too, so a worker cannot claim between validation and enqueue.
    let active=sqlx::query("SELECT status,lease_until FROM link_check_jobs WHERE link_id=$1 AND kind='original' AND status IN('queued','running') FOR UPDATE")
        .bind(link).fetch_all(&mut *tx).await?;
    let busy = active.iter().any(|j| {
        j.get::<String, _>("status") == "running"
            && j.get::<Option<DateTime<Utc>>, _>("lease_until")
                .is_none_or(|until| until > Utc::now())
    });
    if busy {
        return Err(ApiError::Conflict("该链接仍在检测，不能重复入队".into()));
    }
    sqlx::query("UPDATE link_check_jobs SET status='queued',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE link_id=$1 AND kind='original' AND status='running' AND lease_until<=now()")
        .bind(link).execute(&mut *tx).await?;
    // The catalog trigger keeps all queued schedules in sync; preserve observations.
    sqlx::query("UPDATE link_catalog SET next_check_at=now(),updated_at=now() WHERE id=$1")
        .bind(link)
        .execute(&mut *tx)
        .await?;
    let job:i64=sqlx::query_scalar("INSERT INTO link_check_jobs(link_id,input_version,kind,priority) SELECT id,input_version,'original',10 FROM link_catalog WHERE id=$1 ON CONFLICT(link_id,input_version) WHERE kind='original' AND status IN('queued','running') DO UPDATE SET priority=10,updated_at=now() RETURNING id")
        .bind(link).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(ok(json!({"id":job,"status":"queued"})))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn query_validation_is_category_specific() {
        assert!(
            validate(
                "sync",
                &TaskQuery {
                    status: Some("failed".into()),
                    ..Default::default()
                }
            )
            .is_err()
        );
        assert!(
            validate(
                "maintenance",
                &TaskQuery {
                    provider: Some("quark".into()),
                    ..Default::default()
                }
            )
            .is_err()
        );
        assert!(
            validate(
                "checks",
                &TaskQuery {
                    before: Some("bad".into()),
                    ..Default::default()
                }
            )
            .is_err()
        );
        assert!(validate("unknown", &TaskQuery::default()).is_err());
        assert!(validate("resolve", &TaskQuery::default()).is_ok());
        for page in [0, -1, 100001] {
            assert!(
                validate(
                    "checks",
                    &TaskQuery {
                        page: Some(page),
                        ..Default::default()
                    }
                )
                .is_err()
            );
        }
        for page_size in [0, -1, 11, 51] {
            assert!(
                validate(
                    "checks",
                    &TaskQuery {
                        page_size: Some(page_size),
                        ..Default::default()
                    }
                )
                .is_err()
            );
        }
        for page_size in [10, 20, 30, 50] {
            assert!(
                validate(
                    "checks",
                    &TaskQuery {
                        page: Some(2),
                        page_size: Some(page_size),
                        ..Default::default()
                    }
                )
                .is_ok()
            );
        }
    }

    #[tokio::test]
    #[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test"]
    async fn check_task_queries_match_reference_with_overlaps_and_stale_providers() {
        let database = std::env::var("PANSOU_TEST_DATABASE_URL").unwrap();
        assert!(
            url::Url::parse(&database)
                .unwrap()
                .path()
                .ends_with("_test")
        );
        let pool = crate::db::connect(&database).await.unwrap();
        crate::db::init_db(&pool).await.unwrap();
        let mut tx = pool.begin().await.unwrap();
        // Distinct links permit every combination without violating active-job
        // uniqueness. Overlapping attention reasons and equal timestamps are
        // intentional; neither may duplicate rows or destabilize pagination.
        for provider in ["quark", "baidu"] {
            for status in ["queued", "running", "completed", "failed"] {
                for kind in ["original", "reshared"] {
                    for lease in [None, Some(-60_i64), Some(0), Some(3600)] {
                        let link = Uuid::new_v4();
                        let failed = kind == "original" && lease != Some(3600);
                        sqlx::query("INSERT INTO link_catalog(id,provider,identity,original_url,input_fingerprint,failure_count) VALUES($1,$2,$3,'https://example.invalid/test',$3,$4)")
                            .bind(link).bind(provider).bind(link.to_string()).bind(i32::from(failed))
                            .execute(&mut *tx).await.unwrap();
                        let cache = if kind == "reshared" {
                            let id = Uuid::new_v4();
                            sqlx::query("INSERT INTO link_share_cache(id,link_id,input_version,target_account_key,account_revision,policy_revision,target_dir,state,retention_seconds,cleanup_after) VALUES($1,$2,1,'test',1,1,'test','deleted',60,now())")
                                .bind(id).bind(link).execute(&mut *tx).await.unwrap();
                            Some(id)
                        } else {
                            None
                        };
                        sqlx::query("INSERT INTO link_check_jobs(link_id,input_version,kind,share_cache_id,status,lease_until,created_at) VALUES($1,1,$2,$3,$4,now()+$5::bigint*interval '1 second','2026-01-01'::timestamptz)")
                            .bind(link).bind(kind).bind(cache).bind(status).bind(lease)
                            .execute(&mut *tx).await.unwrap();
                        // Provider edits legitimately leave historical/running
                        // queue snapshots stale. Filtering must still use c.
                        sqlx::query("UPDATE link_catalog SET provider=$2 WHERE id=$1")
                            .bind(link)
                            .bind(if provider == "quark" {
                                "baidu"
                            } else {
                                "quark"
                            })
                            .execute(&mut *tx)
                            .await
                            .unwrap();
                    }
                }
            }
        }
        let stale: i64 = sqlx::query_scalar("SELECT count(*) FROM link_check_jobs j JOIN link_catalog c ON c.id=j.link_id WHERE j.provider<>c.provider")
            .fetch_one(&mut *tx).await.unwrap();
        assert!(stale > 0);
        let projection = "'id',j.id::text,'createdAt',j.created_at,'provider',c.provider,'status',j.status,'kind',j.kind";
        for mode in ["force_custom_plan", "force_generic_plan"] {
            sqlx::query(&format!("SET LOCAL plan_cache_mode='{mode}'"))
                .execute(&mut *tx)
                .await
                .unwrap();
            for provider in ["", "quark", "baidu", "uc"] {
                for status in [
                    "all",
                    "attention",
                    "queued",
                    "running",
                    "completed",
                    "failed",
                ] {
                    let reference: Vec<Value> = sqlx::query_scalar(&format!(
                        "SELECT jsonb_build_object({projection}) FROM link_check_jobs j JOIN link_catalog c ON c.id=j.link_id WHERE ($1='' OR c.provider=$1) AND ($2='all' OR $2='attention' AND (j.status='failed' OR c.failure_count>0 OR j.status='running' AND j.lease_until<=now()) OR j.status=$2) ORDER BY j.created_at DESC,j.id DESC"))
                        .bind(provider).bind(status).fetch_all(&mut *tx).await.unwrap();
                    let mut q = TaskQuery {
                        provider: Some(provider.into()),
                        status: Some(status.into()),
                        page_size: Some(10),
                        ..Default::default()
                    };
                    for page in [1, 2, 100] {
                        q.page = Some(page);
                        let (total, actual) = check_task_page(&mut tx, &q, None, projection)
                            .await
                            .unwrap();
                        let expected: Vec<Value> = reference
                            .iter()
                            .skip(((page - 1) * 10) as usize)
                            .take(11)
                            .cloned()
                            .collect();
                        assert_eq!(total, reference.len() as i64, "{mode}/{provider}/{status}");
                        assert_eq!(actual, expected, "{mode}/{provider}/{status}/page={page}");
                    }
                    if let Some(last) = reference.get(9) {
                        q.page = None;
                        let cursor = Cursor {
                            kind: "checks".into(),
                            at: serde_json::from_value(last["createdAt"].clone()).unwrap(),
                            id: last["id"].as_str().unwrap().into(),
                        };
                        let (total, actual) =
                            check_task_page(&mut tx, &q, Some(&cursor), projection)
                                .await
                                .unwrap();
                        assert_eq!(total, reference.len() as i64);
                        assert_eq!(
                            actual,
                            reference
                                .iter()
                                .skip(10)
                                .take(11)
                                .cloned()
                                .collect::<Vec<_>>()
                        );
                    }
                }
            }
        }
        tx.rollback().await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test and PANSOU_TEST_REDIS_URL"]
    async fn task_center_lists_filters_paginates_and_fences_rechecks() {
        use axum::{
            body::{Body, to_bytes},
            http::{Request, StatusCode},
        };
        use tower::ServiceExt;
        async fn call(
            router: &axum::Router,
            method: &str,
            path: &str,
            token: Option<&str>,
        ) -> (StatusCode, Value) {
            let mut r = Request::builder().method(method).uri(path);
            if let Some(t) = token {
                r = r.header("authorization", format!("Bearer {t}"));
            }
            let out = router
                .clone()
                .oneshot(r.body(Body::empty()).unwrap())
                .await
                .unwrap();
            let code = out.status();
            let body = to_bytes(out.into_body(), 1024 * 1024).await.unwrap();
            (code, serde_json::from_slice(&body).unwrap())
        }
        let database = std::env::var("PANSOU_TEST_DATABASE_URL").unwrap();
        assert!(
            url::Url::parse(&database)
                .unwrap()
                .path()
                .ends_with("_test")
        );
        let redis_url = std::env::var("PANSOU_TEST_REDIS_URL").unwrap();
        assert!(!matches!(
            url::Url::parse(&redis_url).unwrap().path(),
            "" | "/" | "/0"
        ));
        let pool = crate::db::connect(&database).await.unwrap();
        crate::db::init_db(&pool).await.unwrap();
        let state = Arc::new(AppState::new(
            pool.clone(),
            crate::redis_store::RedisStore::connect(&redis_url)
                .await
                .unwrap(),
        ));
        let router = crate::app::build_router(state.clone());
        let unique = Uuid::new_v4().simple().to_string();
        let username = format!("tasks_{unique}");
        let admin:i64=sqlx::query_scalar("INSERT INTO users(username,username_normalized,password_hash,role) VALUES($1,$1,$2,'admin') RETURNING id")
            .bind(&username).bind(crate::auth::hash_password(&unique).unwrap()).fetch_one(&pool).await.unwrap();
        let (session, _) = state.auth().login(&username, &unique).await.unwrap();
        let token = Some(session.token.as_str());
        let member = format!("member_{unique}");
        sqlx::query("INSERT INTO users(username,username_normalized,password_hash,role) VALUES($1,$1,$2,'user')").bind(&member).bind(crate::auth::hash_password(&unique).unwrap()).execute(&pool).await.unwrap();
        let (member_session, _) = state.auth().login(&member, &unique).await.unwrap();
        assert_eq!(
            call(
                &router,
                "GET",
                "/api/admin/tasks/checks",
                Some(&member_session.token)
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        for kind in [
            "crawl",
            "sync",
            "checks",
            "resolve",
            "operations",
            "maintenance",
        ] {
            assert_eq!(
                call(&router, "GET", &format!("/api/admin/tasks/{kind}"), None)
                    .await
                    .0,
                StatusCode::UNAUTHORIZED
            );
        }
        let channel = format!("tasks_{}", &unique[..16]);
        sqlx::query("INSERT INTO crawl_channels(id) VALUES($1)")
            .bind(&channel)
            .execute(&pool)
            .await
            .unwrap();
        let crawl:i64=sqlx::query_scalar("INSERT INTO crawl_jobs(channel_id,kind,status,last_error) VALUES($1,'sync','failed','credential=DO_NOT_EXPOSE') RETURNING id").bind(&channel).fetch_one(&pool).await.unwrap();
        let resource = format!("task-resource-{unique}");
        sqlx::query("INSERT INTO managed_resources(id,name) VALUES($1,'任务中心模拟资源')")
            .bind(&resource)
            .execute(&pool)
            .await
            .unwrap();
        let link = Uuid::new_v4();
        sqlx::query("INSERT INTO link_catalog(id,provider,identity,original_url,input_fingerprint,next_check_at,failure_count,last_error_code) VALUES($1,'quark',$2,'https://pan.quark.cn/s/test',$2,now(),1,'check_failed')")
            .bind(link).bind(&unique).execute(&pool).await.unwrap();
        let check:i64=sqlx::query_scalar("INSERT INTO link_check_jobs(link_id,input_version,kind) VALUES($1,1,'original') RETURNING id").bind(link).fetch_one(&pool).await.unwrap();
        sqlx::query("INSERT INTO link_resolve_requests(id,request_key,subject_key,request_fingerprint,link_id,authorization_json,status,delivery,reason_code,response_json,deadline_at) VALUES($1,$2,'private-subject',$3,$4,'{\"credential\":\"DO_NOT_EXPOSE\"}','completed','original','deadline_exceeded','{\"cookie\":\"DO_NOT_EXPOSE\"}',now())")
            .bind(Uuid::new_v4()).bind(Uuid::new_v4()).bind(&unique).bind(link).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO cloud_drive_operations(request_key,actor_id,provider,action,fingerprint,expires_at) VALUES($1,$2,'quark','save','DO_NOT_EXPOSE',now()-interval '1 second')")
            .bind(Uuid::new_v4()).bind(admin).execute(&pool).await.unwrap();
        crate::runtime::record_lane_run(
            &state,
            "link-sync",
            std::time::Duration::from_millis(12),
            &Err(ApiError::Upstream("DO_NOT_EXPOSE".into())),
        )
        .await;
        crate::runtime::record_lane_run(
            &state,
            "link-maintenance",
            std::time::Duration::from_millis(4),
            &Ok(()),
        )
        .await;
        let lane = format!("fixture-{unique}");
        for _ in 0..2 {
            crate::runtime::record_lane_run(
                &state,
                &lane,
                std::time::Duration::from_millis(1),
                &Err(ApiError::Upstream("DO_NOT_EXPOSE".into())),
            )
            .await;
        }
        let logged: i64 = sqlx::query_scalar("SELECT count(*) FROM worker_task_runs WHERE lane=$1")
            .bind(&lane)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(logged, 1);
        crate::runtime::record_lane_run(
            &state,
            &lane,
            std::time::Duration::from_millis(1),
            &Ok(()),
        )
        .await;
        let logged: i64 = sqlx::query_scalar("SELECT count(*) FROM worker_task_runs WHERE lane=$1")
            .bind(&lane)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(logged, 1);
        sqlx::query("INSERT INTO worker_task_runs(lane,status,duration_ms,created_at) VALUES($1,'failed',1,now()-interval '8 days')").bind(&lane).execute(&pool).await.unwrap();
        crate::runtime::record_lane_run(
            &state,
            "link-maintenance",
            std::time::Duration::from_millis(1),
            &Ok(()),
        )
        .await;
        let old:i64=sqlx::query_scalar("SELECT count(*) FROM worker_task_runs WHERE lane=$1 AND created_at<now()-interval '7 days'").bind(&lane).fetch_one(&pool).await.unwrap();
        assert_eq!(old, 0);
        for kind in [
            "crawl",
            "sync",
            "checks",
            "resolve",
            "operations",
            "maintenance",
        ] {
            let (code, out) =
                call(&router, "GET", &format!("/api/admin/tasks/{kind}"), token).await;
            assert_eq!(code, StatusCode::OK, "{kind}: {out}");
            assert!(
                !out["data"]["items"].as_array().unwrap().is_empty(),
                "{kind}"
            );
            let body = out.to_string();
            assert!(!body.contains("DO_NOT_EXPOSE"));
            assert!(!body.contains("authorization_json"));
            assert!(!body.contains("subject_key"));
        }
        let (_, out) = call(
            &router,
            "GET",
            "/api/admin/tasks/operations?status=uncertain",
            token,
        )
        .await;
        assert_eq!(out["data"]["items"][0]["status"], "uncertain");
        for path in [
            "/api/admin/tasks/unknown",
            "/api/admin/tasks/checks?provider=evil",
            "/api/admin/tasks/sync?status=failed",
            "/api/admin/tasks/resolve?before=bad",
        ] {
            assert_eq!(
                call(&router, "GET", path, token).await.0,
                StatusCode::BAD_REQUEST
            );
        }
        let retry = format!("/api/admin/tasks/checks/{check}/retry");
        assert_eq!(
            call(&router, "POST", &retry, None).await.0,
            StatusCode::UNAUTHORIZED
        );
        sqlx::query("UPDATE policy_settings SET value_json=jsonb_set(value_json,'{enabled}','false') WHERE key='link-check'").execute(&pool).await.unwrap();
        assert_eq!(
            call(&router, "POST", &retry, token).await.0,
            StatusCode::CONFLICT
        );
        sqlx::query("UPDATE policy_settings SET value_json=jsonb_set(value_json,'{enabled}','true') WHERE key='link-check'").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO cloud_account_settings(provider,credential) VALUES('quark','') ON CONFLICT(provider) DO UPDATE SET credential='' ").execute(&pool).await.unwrap();
        assert_eq!(
            call(&router, "POST", &retry, token).await.0,
            StatusCode::CONFLICT
        );
        sqlx::query(
            "UPDATE cloud_account_settings SET credential='synthetic-only' WHERE provider='quark'",
        )
        .execute(&pool)
        .await
        .unwrap();
        let lease = Uuid::new_v4();
        sqlx::query("UPDATE link_check_jobs SET status='running',lease_token=$2,lease_until=now()+interval '1 minute' WHERE id=$1").bind(check).bind(lease).execute(&pool).await.unwrap();
        assert_eq!(
            call(&router, "POST", &retry, token).await.0,
            StatusCode::CONFLICT
        );
        sqlx::query("UPDATE link_check_jobs SET lease_until=NULL WHERE id=$1")
            .bind(check)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            call(&router, "POST", &retry, token).await.0,
            StatusCode::CONFLICT
        );
        sqlx::query("UPDATE link_check_jobs SET lease_until=now()-interval '1 second' WHERE id=$1")
            .bind(check)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(call(&router, "POST", &retry, token).await.0, StatusCode::OK);
        assert_eq!(call(&router, "POST", &retry, token).await.0, StatusCode::OK);
        let row =
            sqlx::query("SELECT status,lease_token,priority FROM link_check_jobs WHERE id=$1")
                .bind(check)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(row.get::<String, _>("status"), "queued");
        assert!(row.get::<Option<Uuid>, _>("lease_token").is_none());
        assert_eq!(row.get::<i32, _>("priority"), 10);
        let n:i64=sqlx::query_scalar("SELECT count(*) FROM link_check_jobs WHERE link_id=$1 AND status IN('queued','running')").bind(link).fetch_one(&pool).await.unwrap();
        assert_eq!(n, 1);
        assert_eq!(
            call(
                &router,
                "POST",
                &format!("/api/admin/crawl/jobs/{crawl}/retry"),
                token
            )
            .await
            .0,
            StatusCode::OK
        );
        for _ in 0..32 {
            sqlx::query("INSERT INTO link_check_jobs(link_id,input_version,kind,status) VALUES($1,1,'original','completed')").bind(link).execute(&pool).await.unwrap();
        }
        let (_, page) = call(
            &router,
            "GET",
            "/api/admin/tasks/checks?provider=quark",
            token,
        )
        .await;
        assert_eq!(page["data"]["items"].as_array().unwrap().len(), 30);
        assert_eq!(page["data"]["hasMore"], true);
        let total = page["data"]["total"].as_i64().unwrap();
        assert!(total > 30);
        let cache = Uuid::new_v4();
        sqlx::query("INSERT INTO link_share_cache(id,link_id,input_version,target_account_key,account_revision,policy_revision,target_dir,state,retention_seconds,cleanup_after) VALUES($1,$2,1,'fixture-account',1,1,'fixture-dir','deleted',60,now())")
            .bind(cache).bind(link).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO link_cleanup_jobs(share_cache_id,status,run_after) SELECT $1,'completed',now() FROM generate_series(1,65)")
            .bind(cache).execute(&pool).await.unwrap();
        for (endpoint, total) in [("tasks/checks", total), ("link-cleanup", 65)] {
            for page_size in [10, 20, 50] {
                let mut ids = Vec::new();
                for number in 1..=(total + page_size - 1) / page_size {
                    let (code, numbered) = call(&router, "GET", &format!("/api/admin/{endpoint}?status=all&provider=quark&page={number}&pageSize={page_size}"), token).await;
                    assert_eq!(code, StatusCode::OK);
                    assert_eq!(numbered["data"]["total"], total);
                    assert_eq!(numbered["data"]["page"], number);
                    assert_eq!(numbered["data"]["pageSize"], page_size);
                    let rows = numbered["data"]["items"].as_array().unwrap();
                    assert_eq!(
                        rows.len() as i64,
                        page_size.min(total - (number - 1) * page_size)
                    );
                    for row in rows {
                        let id = row["id"].to_string();
                        assert!(!ids.contains(&id));
                        ids.push(id);
                    }
                }
                assert_eq!(ids.len() as i64, total);
            }
            let (code, empty) = call(
                &router,
                "GET",
                &format!("/api/admin/{endpoint}?status=all&provider=quark&page=100&pageSize=10"),
                token,
            )
            .await;
            assert_eq!(code, StatusCode::OK);
            assert_eq!(empty["data"]["total"], total);
            assert!(empty["data"]["items"].as_array().unwrap().is_empty());
            let (code, filtered) = call(
                &router,
                "GET",
                &format!("/api/admin/{endpoint}?status=all&provider=baidu&page=1&pageSize=10"),
                token,
            )
            .await;
            assert_eq!(code, StatusCode::OK);
            assert_eq!(filtered["data"]["total"], 0);
            assert!(filtered["data"]["items"].as_array().unwrap().is_empty());
        }
        let before = page["data"]["nextCursor"].as_str().unwrap();
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("before", before)
            .finish();
        let (code, next) = call(
            &router,
            "GET",
            &format!("/api/admin/tasks/checks?{query}"),
            token,
        )
        .await;
        assert_eq!(code, StatusCode::OK);
        assert!(!next["data"]["items"].as_array().unwrap().is_empty());
        for a in page["data"]["items"].as_array().unwrap() {
            assert!(
                !next["data"]["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|b| a["id"] == b["id"])
            );
        }
        assert_eq!(
            call(
                &router,
                "GET",
                &format!("/api/admin/tasks/crawl?{query}"),
                token
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
}
