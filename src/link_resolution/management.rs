use super::*;
use axum::extract::Query;

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupQuery {
    status: Option<String>,
    provider: Option<String>,
    page: Option<i64>,
    page_size: Option<i64>,
}

fn retry_unavailable_reason(
    status: &str,
    cleanup_after: DateTime<Utc>,
    lease: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> Option<&'static str> {
    if status == "completed" {
        Some("completed")
    } else if cleanup_after > now {
        Some("not_due")
    } else if status == "running" && lease.is_none_or(|until| until > now) {
        Some("running")
    } else {
        None
    }
}

pub async fn cleanup_jobs(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<CleanupQuery>,
) -> Result<Response, ApiError> {
    admin(&state, &headers).await?;
    let status = query.status.as_deref().unwrap_or("attention");
    if !matches!(
        status,
        "all" | "attention" | "queued" | "running" | "completed" | "failed" | "blocked"
    ) {
        return Err(ApiError::BadRequest("无效的清理任务状态".into()));
    }
    let page = query.page.unwrap_or(1).clamp(1, 100000);
    let page_size = query.page_size.unwrap_or(30);
    if ![10, 20, 30, 50].contains(&page_size) {
        return Err(ApiError::BadRequest("无效的每页条数".into()));
    }
    let provider = query.provider.as_deref().filter(|p| !p.is_empty());
    if let Some(provider) = provider {
        crate::cloud_drive::Provider::from_name(provider)?;
    }
    let total: i64 = sqlx::query_scalar("SELECT count(*) FROM link_cleanup_jobs j JOIN link_share_cache s ON s.id=j.share_cache_id JOIN link_catalog c ON c.id=s.link_id WHERE ($1='all' OR $1='attention' AND (j.status IN('failed','blocked') OR j.status='queued' AND j.last_error_code IS NOT NULL) OR j.status=$1) AND ($2::text IS NULL OR c.provider=$2)")
        .bind(status).bind(provider).fetch_one(&state.pool).await?;
    let rows = sqlx::query("SELECT j.*,s.cleanup_after,s.target_account_key,s.target_dir,s.owned_dir_id,s.owned_dir_path,s.ownership_manifest_json,s.upstream_share_ids_json,s.state artifact_state,c.provider,c.original_url FROM link_cleanup_jobs j JOIN link_share_cache s ON s.id=j.share_cache_id JOIN link_catalog c ON c.id=s.link_id WHERE ($1='all' OR $1='attention' AND (j.status IN('failed','blocked') OR j.status='queued' AND j.last_error_code IS NOT NULL) OR j.status=$1) AND ($2::text IS NULL OR c.provider=$2) ORDER BY j.updated_at DESC,j.id DESC LIMIT $3 OFFSET $4")
        .bind(status).bind(provider).bind(page_size).bind((page-1)*page_size).fetch_all(&state.pool).await?;
    let items: Vec<Value> = rows.into_iter().map(|r| {
        let manifest: Value = r.get("ownership_manifest_json");
        let retry_reason = if r.get::<Option<String>,_>("last_error_code").as_deref()==Some("waiting_auth"){Some("waiting_auth")}else{retry_unavailable_reason(&r.get::<String,_>("status"), r.get("cleanup_after"), r.get("lease_until"), Utc::now())};
        let can_retry = retry_reason.is_none();
        let files: Vec<Value> = manifest["tree"].as_array().into_iter().flatten().map(|entry| json!({
            "parent":entry["parent"], "file":{"id":entry["file"]["id"],"name":entry["file"]["name"],"size":entry["file"]["size"],"isDir":entry["file"]["isDir"]}
        })).collect();
        json!({
            "id":r.get::<i64,_>("id"), "provider":r.get::<String,_>("provider"),
            "originalUrl":r.get::<String,_>("original_url"), "status":r.get::<String,_>("status"),
            "stage":r.get::<String,_>("stage"), "lastErrorCode":r.get::<Option<String>,_>("last_error_code"),
            "attempts":r.get::<i32,_>("attempts"), "runAfter":r.get::<DateTime<Utc>,_>("run_after"),
            "cleanupAfter":r.get::<DateTime<Utc>,_>("cleanup_after"), "updatedAt":r.get::<DateTime<Utc>,_>("updated_at"),
            "artifactState":r.get::<String,_>("artifact_state"), "targetDir":r.get::<String,_>("target_dir"),
            "ownedDirId":r.get::<Option<String>,_>("owned_dir_id"), "ownedDirPath":r.get::<Option<String>,_>("owned_dir_path"),
            "writeStage":manifest["stage"], "directoryName":manifest["name"], "files":files,
            "shares":r.get::<Value,_>("upstream_share_ids_json"), "progress":r.get::<Value,_>("progress_json"),
            "canRetry":can_retry, "retryUnavailableReason":retry_reason
        })
    }).collect();
    Ok(response(
        StatusCode::OK,
        json!({"items":items,"total":total,"page":page,"pageSize":page_size}),
    ))
}

pub async fn retry_cleanup(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Response, ApiError> {
    admin(&state, &headers).await?;
    // Preserve deletion/revocation progress. Retrying never bypasses account,
    // directory identity or manifest checks in the cleanup worker.
    let retried: Option<i64> = sqlx::query_scalar("UPDATE link_cleanup_jobs j SET status='queued',run_after=now(),attempts=0,last_error_code=NULL,lease_token=NULL,lease_until=NULL,completed_at=NULL,updated_at=now() WHERE j.id=$1 AND status<>'completed' AND last_error_code IS DISTINCT FROM 'waiting_auth' AND (status<>'running' OR lease_until<=now()) AND EXISTS(SELECT 1 FROM link_share_cache s WHERE s.id=j.share_cache_id AND s.cleanup_after<=now()) RETURNING j.id")
        .bind(id).fetch_optional(&state.pool).await?;
    if retried.is_none() {
        return Err(ApiError::Conflict(
            "任务不存在、尚未到期、已完成、仍在执行或等待原账号授权，不能重试".into(),
        ));
    }
    Ok(response(StatusCode::OK, json!({"id":id,"status":"queued"})))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retry_reason_matches_completion_due_time_and_live_lease_guards() {
        let now = Utc::now();
        let past = now - chrono::Duration::seconds(1);
        let future = now + chrono::Duration::seconds(1);
        assert_eq!(
            retry_unavailable_reason("completed", past, None, now),
            Some("completed")
        );
        assert_eq!(
            retry_unavailable_reason("queued", future, None, now),
            Some("not_due")
        );
        assert_eq!(
            retry_unavailable_reason("running", past, Some(future), now),
            Some("running")
        );
        assert_eq!(
            retry_unavailable_reason("running", past, None, now),
            Some("running")
        );
        assert_eq!(
            retry_unavailable_reason("running", past, Some(past), now),
            None
        );
        assert_eq!(retry_unavailable_reason("blocked", past, None, now), None);
    }
}
