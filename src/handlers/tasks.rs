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
mod tests;
