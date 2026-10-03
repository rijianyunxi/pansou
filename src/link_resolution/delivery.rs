use super::*;
use crate::cloud_drive::{Drive, File, Provider, ShareInput};

/// One row of `cloud_provider_policies`: the delivery switch/parameters plus the
/// background detection parameters for a single provider. This struct is both the
/// API payload and the database row, so there is exactly one shape to keep in sync.
#[derive(Clone, Debug, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderPolicy {
    #[serde(default)]
    pub provider: String,
    #[sqlx(rename = "delivery_enabled")]
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub target_dir: Option<String>,
    #[serde(default)]
    pub target_dir_name: String,
    #[serde(default)]
    pub retention_seconds: Option<i32>,
    #[serde(default = "minimum")]
    pub delivery_min_remaining_seconds: i32,
    #[serde(default = "days")]
    pub platform_share_days: i32,
    #[serde(default = "check_interval")]
    pub check_interval_seconds: i32,
    #[serde(default = "check_valid")]
    pub check_valid_seconds: i32,
    #[serde(default = "check_invalid")]
    pub check_invalid_seconds: i32,
    #[serde(default = "check_budget")]
    pub check_daily_budget: i32,
    #[serde(default = "revision")]
    pub revision: i64,
}
fn minimum() -> i32 {
    300
}
fn days() -> i32 {
    7
}
fn check_interval() -> i32 {
    2
}
fn check_valid() -> i32 {
    86400
}
fn check_invalid() -> i32 {
    604800
}
fn check_budget() -> i32 {
    1000
}
fn revision() -> i64 {
    1
}
impl Default for ProviderPolicy {
    fn default() -> Self {
        Self {
            provider: String::new(),
            enabled: false,
            target_dir: None,
            target_dir_name: String::new(),
            retention_seconds: None,
            delivery_min_remaining_seconds: minimum(),
            platform_share_days: days(),
            check_interval_seconds: check_interval(),
            check_valid_seconds: check_valid(),
            check_invalid_seconds: check_invalid(),
            check_daily_budget: check_budget(),
            revision: revision(),
        }
    }
}
pub(super) const POLICY_COLUMNS: &str = "provider,delivery_enabled,target_dir,target_dir_name,retention_seconds,delivery_min_remaining_seconds,platform_share_days,check_interval_seconds,check_valid_seconds,check_invalid_seconds,check_daily_budget,revision";
impl ProviderPolicy {
    pub fn validate(&self, provider: Provider) -> Result<(), ApiError> {
        if !(2..=3600).contains(&self.check_interval_seconds)
            || !(60..=2592000).contains(&self.check_valid_seconds)
            || !(60..=2592000).contains(&self.check_invalid_seconds)
            || !(1..=100000).contains(&self.check_daily_budget)
        {
            return Err(ApiError::BadRequest(
                "检测间隔、缓存时长或每日额度无效".into(),
            ));
        }
        if self.enabled {
            let ttl = self.retention_seconds.unwrap_or(0);
            if !(60..=2592000).contains(&ttl)
                || self.delivery_min_remaining_seconds < 0
                || self.delivery_min_remaining_seconds >= ttl
                || ![1, 7, 30].contains(&self.platform_share_days)
            {
                return Err(ApiError::BadRequest(
                    "保留期须在60秒至30天内，临期窗口须小于保留期，平台分享期限为1/7/30天"
                        .into(),
                ));
            }
            let dir = self.target_dir.as_deref().unwrap_or("");
            if dir.is_empty() || dir == "/" || dir == "0" || dir == "root" {
                return Err(ApiError::BadRequest(
                    "必须配置非根目录的项目专用目录".into(),
                ));
            }
            crate::cloud_drive::validate_dir(provider, Some(dir))?;
        }
        Ok(())
    }
}
pub(super) async fn load_provider(
    state: &AppState,
    provider: Provider,
) -> Result<ProviderPolicy, ApiError> {
    sqlx::query_as(&format!(
        "SELECT {POLICY_COLUMNS} FROM cloud_provider_policies WHERE provider=$1"
    ))
    .bind(provider.name())
    .fetch_one(&state.pool)
    .await
    .map_err(|_| ApiError::Unavailable("网盘策略配置无效".into()))
}
async fn lock(
    state: &AppState,
    drive: &Drive,
) -> Result<sqlx::Transaction<'static, sqlx::Postgres>, ApiError> {
    try_lock(state, drive).await?.ok_or_else(|| ApiError::Conflict("网盘正在执行其他写操作".into()))
}
async fn try_lock(
    state: &AppState,
    drive: &Drive,
) -> Result<Option<sqlx::Transaction<'static, sqlx::Postgres>>, ApiError> {
    let mut tx = state.pool.begin().await?;
    let acquired: bool =
        sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0))")
            .bind(format!("pansou:cloud-write:{}", drive.wire.provider.name()))
            .fetch_one(&mut *tx)
            .await?;
    if !acquired {
        return Ok(None);
    }
    drive.ensure_current_account(&mut tx).await?;
    Ok(Some(tx))
}
fn directory_key(provider: Provider, file: &File) -> String {
    if provider == Provider::Baidu {
        file.path.clone()
    } else {
        file.id.clone()
    }
}
/// Read every descendant, refusing truncated or excessively deep manifests.
async fn manifest(drive: &Drive, root: &str) -> Result<Value, ApiError> {
    let mut pending = vec![(root.to_string(), 0)];
    let mut entries = vec![];
    let mut seen = std::collections::HashSet::new();
    while let Some((parent, depth)) = pending.pop() {
        if depth > 16 || entries.len() > 5000 || !seen.insert(parent.clone()) {
            return Err(ApiError::Conflict(
                "文件树过大或结构异常，需人工核实".into(),
            ));
        }
        for file in drive.list(&parent).await.map_err(|e| e.api())? {
            if file.is_dir {
                pending.push((directory_key(drive.wire.provider, &file), depth + 1));
            }
            entries.push(json!({"parent":parent,"file":file}));
        }
    }
    entries.sort_by_key(|v| v["file"]["id"].as_str().unwrap_or("").to_owned());
    Ok(json!(entries))
}
fn delivered(
    key: Uuid,
    link: &Link,
    fact: &Fact,
    share: &Value,
    expires: DateTime<Utc>,
    hit: bool,
) -> Value {
    json!({"requestKey":key,"status":"completed","type":link.r#type,"url":share["url"],"password":share["password"],"delivery":"reshared","originalValidity":fact.current(),"validity":1,"checkedAt":Utc::now(),"stale":false,"reasonCode":null,"deliveryExpiresAt":expires,"shareExpiresAt":share["shareExpiresAt"],"cacheHit":hit})
}
async fn share_saved(
    state: &AppState,
    session: &Session,
    key: Uuid,
    drive: &Drive,
    id: Uuid,
    files: &[File],
    p: &ProviderPolicy,
    expires: DateTime<Utc>,
) -> Result<Value, ApiError> {
    authorize_write(state, session, key).await?;
    let row = sqlx::query(
        "SELECT ownership_manifest_json,upstream_share_ids_json FROM link_share_cache WHERE id=$1",
    )
    .bind(id)
    .fetch_one(&state.pool)
    .await?;
    let evidence: Value = row.get("ownership_manifest_json");
    let share = if evidence["stage"] == "share_created" {
        evidence["pendingShare"].clone()
    } else {
        sqlx::query("UPDATE link_share_cache SET state='sharing',ownership_manifest_json=jsonb_set(ownership_manifest_json,'{stage}','\"share_intent\"'),updated_at=now() WHERE id=$1").bind(id).execute(&state.pool).await?;
        match drive
            .begin_temporary_share(files, p.platform_share_days as u32)
            .await
        {
            Ok(share) => share,
            Err(error) => {
                // Explicit business rejection means no share was created. Transport uncertainty does not.
                if error.code.is_some() {
                    sqlx::query("UPDATE link_share_cache SET state='saved',ownership_manifest_json=jsonb_set(ownership_manifest_json,'{stage}','\"saved\"'),last_error_code='share_failed' WHERE id=$1").bind(id).execute(&state.pool).await?;
                }
                return Err(error.api());
            }
        }
    };
    if share["shareId"].as_str().is_none_or(str::is_empty) {
        return Err(ApiError::Conflict("分享身份不确定".into()));
    }
    sqlx::query("UPDATE link_share_cache SET upstream_share_ids_json=$2,ownership_manifest_json=ownership_manifest_json || $3 WHERE id=$1").bind(id).bind(json!([share["shareId"]])).bind(json!({"stage":"share_created","pendingShare":share})).execute(&state.pool).await?;
    // Keep the acknowledgement even when it arrives after the response deadline.
    // Do not continue publishing a share that the caller will never receive.
    authorize_write(state, session, key).await?;
    let share_expires_at: Option<DateTime<Utc>> =
        serde_json::from_value(share["shareExpiresAt"].clone()).ok();
    let mut share = drive
        .finish_temporary_share(&share)
        .await
        .map_err(|e| e.api())?;
    if share["url"].as_str().is_none_or(str::is_empty) {
        return Err(ApiError::Conflict("分享链接缺失".into()));
    }
    authorize_write(state, session, key).await?;
    sqlx::query("UPDATE link_share_cache SET state='ready',share_url=$2,share_password=$3,share_validity=1,share_checked_at=now(),share_valid_until=$4,share_expires_at=$5,ownership_manifest_json=jsonb_set(ownership_manifest_json,'{stage}','\"ready\"'),updated_at=now() WHERE id=$1")
        .bind(id).bind(share["url"].as_str()).bind(share["password"].as_str()).bind(expires).bind(share_expires_at).execute(&state.pool).await?;
    share["shareExpiresAt"] = json!(share_expires_at);
    Ok(share)
}

/// Inspect the source once, before any external write. Only definitive absence is invalid.
pub(super) async fn original_context(
    state: &AppState,
    drive: &Drive,
    link: &Link,
    deadline: DateTime<Utc>,
) -> Result<crate::cloud_drive::Context, ApiError> {
    let policy = load_provider(state, drive.wire.provider).await?;
    let wait_until = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if worker::allow_check(state, drive.wire.provider, &policy, true).await? {
            break;
        }
        if tokio::time::Instant::now() >= wait_until || Utc::now() >= deadline {
            return Err(ApiError::Unavailable("检测额度或限频暂不可用".into()));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let reference = ShareInput {
        url: link.url.clone(),
        provider: Some(drive.wire.provider),
        password: link.password.clone(),
    }
    .parse()?;
    // Bound the read itself, not the whole observation future: cancellation must not skip -1.
    let remaining = (deadline - Utc::now()).num_milliseconds().clamp(1, 45000);
    let result = tokio::time::timeout(
        Duration::from_millis(remaining as u64),
        drive.resolve(&reference),
    )
    .await;
    let value = match &result {
        Ok(Ok(ctx)) if ctx.files.is_empty() => {
            json!({"status":"invalid","reasonCode":"resource_missing"})
        }
        Ok(Ok(_)) => json!({"status":"valid"}),
        Ok(Err(error)) => {
            json!({"status":if error.kind == crate::cloud_drive::ErrorKind::InvalidLink {"invalid"}else{"unknown"},"errorKind":error.kind})
        }
        Err(_) => json!({"status":"unknown","errorKind":"network"}),
    };
    super::record_check(state, link, &value).await?;
    match result {
        Ok(Ok(ctx)) if !ctx.files.is_empty() => Ok(ctx),
        _ => Err(ApiError::Unavailable("原分享暂不可取用".into())),
    }
}
pub(super) async fn deliver(
    state: &AppState,
    session: &Session,
    key: Uuid,
    link_id: Uuid,
    link: &Link,
    fact: &Fact,
) -> Result<Value, ApiError> {
    let provider = Provider::from_name(&link.r#type)?;
    let p = load_provider(state, provider).await?;
    let drive = Drive::load(state, provider).await?;
    let deadline: DateTime<Utc> = sqlx::query_scalar(
        "SELECT deadline_at FROM link_resolve_requests WHERE subject_key=$1 AND request_key=$2",
    )
    .bind(subject(session))
    .bind(key)
    .fetch_one(&state.pool)
    .await?;
    drive.wire.write_deadline_ms.store(deadline.timestamp_millis(), std::sync::atomic::Ordering::SeqCst);
    if !p.enabled && p.target_dir.as_deref().is_none_or(str::is_empty) {
        let _ = original_context(state, &drive, link, deadline).await;
        return Ok(fallback(
            key,
            link,
            &super::fact(state, link_id).await?,
            "delivery_disabled",
        ));
    }
    p.validate(provider)?;
    let _lock = loop {
        match lock(state, &drive).await {
            Ok(tx) => break tx,
            Err(ApiError::Conflict(_)) if Utc::now() < deadline => {
                authorize_write(state, session, key).await?;
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
            Err(_) => return Ok(fallback(key, link, fact, "account_unavailable")),
        }
    };
    // Admin policy saves share this lock. Requests that waited must honor the latest switch.
    let p = load_provider(state, provider).await?;
    p.validate(provider)?;
    let remaining = (deadline - Utc::now()).num_milliseconds();
    if remaining <= 0 {
        return Ok(fallback(key, link, fact, "deadline_exceeded"));
    }
    let dir = p.target_dir.as_deref().unwrap_or("");
    let existing=sqlx::query("SELECT * FROM link_share_cache WHERE link_id=$1 AND target_account_key=$2 AND target_dir=$3 AND state NOT IN('expiring','cleaning','deleted') ORDER BY generation DESC LIMIT 1")
        .bind(link_id).bind(&drive.account).bind(dir).fetch_optional(&state.pool).await?;
    if let Some(row) = existing {
        let id: Uuid = row.get("id");
        let expires: DateTime<Utc> = row.get("cleanup_after");
        let platform_expired = row
            .get::<Option<DateTime<Utc>>, _>("share_expires_at")
            .is_some_and(|t| t <= Utc::now());
        if row.get::<String, _>("state") == "ready"
            && expires
                > Utc::now() + chrono::Duration::seconds(p.delivery_min_remaining_seconds as i64)
            && row
                .get::<Option<DateTime<Utc>>, _>("share_expires_at")
                .is_none_or(|t| {
                    t > Utc::now()
                        + chrono::Duration::seconds(p.delivery_min_remaining_seconds as i64)
                })
        {
            let share = json!({"url":row.get::<Option<String>,_>("share_url"),"password":row.get::<Option<String>,_>("share_password"),"shareExpiresAt":row.get::<Option<DateTime<Utc>>,_>("share_expires_at")});
            let input = ShareInput {
                url: share["url"].as_str().unwrap_or("").into(),
                provider: Some(provider),
                password: share["password"].as_str().map(str::to_owned),
            };
            if let Ok(reference) = input.parse() {
                let checked = tokio::time::timeout(
                    Duration::from_millis(remaining as u64),
                    drive.resolve(&reference),
                )
                .await;
                if matches!(checked, Ok(Ok(ref ctx)) if !ctx.files.is_empty()) {
                    sqlx::query("UPDATE link_share_cache SET share_validity=1,share_checked_at=now(),last_error_code=NULL WHERE id=$1").bind(id).execute(&state.pool).await?;
                    sqlx::query("UPDATE link_resolve_requests SET share_cache_id=$3 WHERE subject_key=$1 AND request_key=$2").bind(subject(session)).bind(key).bind(id).execute(&state.pool).await?;
                    return Ok(delivered(key, link, fact, &share, expires, true));
                }
                if matches!(checked, Ok(Err(ref e)) if e.kind == crate::cloud_drive::ErrorKind::InvalidLink)
                    || matches!(checked, Ok(Ok(ref ctx)) if ctx.files.is_empty())
                {
                    let mut tx = state.pool.begin().await?;
                    sqlx::query("UPDATE link_share_cache SET state='expiring',share_validity=0,last_error_code='share_invalid',updated_at=now() WHERE id=$1").bind(id).execute(&mut *tx).await?;
                    sqlx::query("UPDATE link_cleanup_jobs SET run_after=now() WHERE share_cache_id=$1 AND status='queued'").bind(id).execute(&mut *tx).await?;
                    tx.commit().await?;
                } else {
                    sqlx::query("UPDATE link_share_cache SET share_validity=-1,share_checked_at=now(),last_error_code='share_check_failed' WHERE id=$1").bind(id).execute(&state.pool).await?;
                }
            }
            let _ = original_context(state, &drive, link, deadline).await;
            return Ok(fallback(
                key,
                link,
                &super::fact(state, link_id).await?,
                "share_failed",
            ));
        }
        if !p.enabled {
            let _ = original_context(state, &drive, link, deadline).await;
            return Ok(fallback(
                key,
                link,
                &super::fact(state, link_id).await?,
                "delivery_disabled",
            ));
        }
        let evidence: Value = row.get("ownership_manifest_json");
        if expires > Utc::now() + chrono::Duration::seconds(p.delivery_min_remaining_seconds as i64)
            && matches!(evidence["stage"].as_str(), Some("saved" | "share_created"))
        {
            let owned: File = serde_json::from_value(evidence["directory"].clone())
                .map_err(|_| ApiError::Conflict("目录归属缺失".into()))?;
            if manifest(&drive, &directory_key(provider, &owned)).await? == evidence["tree"] {
                let files: Vec<File> = serde_json::from_value(row.get("target_files_json"))
                    .map_err(|_| ApiError::Conflict("文件映射损坏".into()))?;
                sqlx::query("UPDATE link_resolve_requests SET share_cache_id=$3 WHERE subject_key=$1 AND request_key=$2").bind(subject(session)).bind(key).bind(id).execute(&state.pool).await?;
                sqlx::query("UPDATE link_share_cache SET ownership_manifest_json=ownership_manifest_json || $2 WHERE id=$1")
                    .bind(id).bind(json!({"writerRequestKey":key})).execute(&state.pool).await?;
                match share_saved(state, session, key, &drive, id, &files, &p, expires).await {
                    Ok(share) => return Ok(delivered(key, link, fact, &share, expires, true)),
                    Err(_) => {
                        retire_timed_out_artifacts(state, session, key).await?;
                        return Ok(fallback(key, link, fact, "share_failed"));
                    }
                }
            }
        }
        if !matches!(
            evidence["stage"].as_str(),
            Some("ready" | "saved" | "share_created")
        ) {
            return Ok(fallback(key, link, fact, "uncertain"));
        }
        if expires > Utc::now() && !platform_expired {
            return Ok(fallback(key, link, fact, "delivery_expired"));
        }
        sqlx::query("UPDATE link_share_cache SET state='expiring',updated_at=now() WHERE id=$1")
            .bind(id)
            .execute(&state.pool)
            .await?;
        if platform_expired {
            sqlx::query("UPDATE link_cleanup_jobs SET run_after=now() WHERE share_cache_id=$1 AND status='queued'").bind(id).execute(&state.pool).await?;
        }
    }
    if !p.enabled {
        let _ = original_context(state, &drive, link, deadline).await;
        return Ok(fallback(
            key,
            link,
            &super::fact(state, link_id).await?,
            "delivery_disabled",
        ));
    }
    let context = match original_context(state, &drive, link, deadline).await {
        Ok(context) => context,
        _ => {
            return Ok(fallback(
                key,
                link,
                &super::fact(state, link_id).await?,
                "check_failed",
            ));
        }
    };
    let current = super::fact(state, link_id).await?;
    let remaining = (deadline - Utc::now()).num_milliseconds();
    if remaining <= 0 {
        return Ok(fallback(key, link, &current, "deadline_exceeded"));
    }
    let id = Uuid::new_v4();
    let ttl = p.retention_seconds.unwrap();
    let expires = Utc::now() + chrono::Duration::seconds(ttl as i64);
    // Persist both ownership intent and cleanup before the first external write.
    let mut tx = state.pool.begin().await?;
    sqlx::query("INSERT INTO link_share_cache(id,link_id,input_version,target_account_key,account_revision,policy_revision,target_dir,state,generation,retention_seconds,cleanup_after,ownership_manifest_json) VALUES($1,$2,1,$3,1,$4,$5,'saving',(SELECT COALESCE(MAX(generation),0)+1 FROM link_share_cache WHERE link_id=$2),$6,$7,$8)")
        .bind(id).bind(link_id).bind(&drive.account).bind(p.revision).bind(dir).bind(ttl).bind(expires).bind(json!({"name":format!("pansou-{id}"),"parent":dir,"account":drive.account,"stage":"directory_intent","minRemainingSeconds":p.delivery_min_remaining_seconds,"writerRequestKey":key})).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO link_cleanup_jobs(share_cache_id,run_after) VALUES($1,$2)")
        .bind(id)
        .bind(expires)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE link_resolve_requests SET share_cache_id=$3 WHERE subject_key=$1 AND request_key=$2").bind(subject(session)).bind(key).bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    let workflow = async {
        let before = drive.list(dir).await.map_err(|e| e.api())?;
        if before.iter().any(|f| f.name == format!("pansou-{id}")) {
            return Err(ApiError::Conflict("目录已存在".into()));
        }
        authorize_write(state, session, key).await?;
        let owned = drive
            .create_directory(dir, &format!("pansou-{id}"))
            .await
            .map_err(|e| e.api())?;
        let target = directory_key(provider, &owned);
        if target.is_empty() || target == dir {
            return Err(ApiError::Conflict("无法核实新目录".into()));
        }
        sqlx::query("UPDATE link_share_cache SET owned_dir_id=$2,owned_dir_path=$3,ownership_manifest_json=ownership_manifest_json || $4 WHERE id=$1").bind(id).bind(&owned.id).bind(&owned.path).bind(json!({"directory":owned,"stage":"directory_created"})).execute(&state.pool).await?;
        if !drive.list(&target).await.map_err(|e| e.api())?.is_empty() {
            return Err(ApiError::Conflict("新目录不为空".into()));
        }
        // A confirmed empty directory can also be safely removed if creation was late.
        sqlx::query("UPDATE link_share_cache SET ownership_manifest_json=ownership_manifest_json || $2 WHERE id=$1")
            .bind(id).bind(json!({"stage":"saved","tree":[]})).execute(&state.pool).await?;
        authorize_write(state, session, key).await?;
        sqlx::query("UPDATE link_share_cache SET ownership_manifest_json=jsonb_set(ownership_manifest_json,'{stage}','\"transfer_intent\"') WHERE id=$1")
            .bind(id).execute(&state.pool).await?;
        let ids = match drive.transfer(&context, &target).await {
            Ok(ids) => ids,
            Err(error) => {
                // Multi-file copies may stop at the deadline after earlier files
                // were acknowledged. Preserve those exact IDs for safe cleanup.
                let confirmed = drive.wire.confirmed_file_ids.lock().await.clone();
                if !confirmed.is_empty() {
                    let files = drive.list(&target).await.map_err(|e| e.api())?;
                    if files.len() == confirmed.len() && files.iter().all(|f| confirmed.contains(&f.id)) {
                        let tree = manifest(&drive, &target).await?;
                        sqlx::query("UPDATE link_share_cache SET state='saved',target_files_json=$2,ownership_manifest_json=ownership_manifest_json || $3,updated_at=now() WHERE id=$1")
                            .bind(id).bind(json!(files)).bind(json!({"tree":tree,"stage":"saved"})).execute(&state.pool).await?;
                    }
                }
                return Err(error.api());
            }
        };
        let files = drive.list(&target).await.map_err(|e| e.api())?;
        if files.len() != context.files.len() || files.iter().any(|f| !ids.contains(&f.id)) {
            return Err(ApiError::Conflict("转存结果身份不确定".into()));
        }
        let tree = manifest(&drive, &target).await?;
        sqlx::query("UPDATE link_share_cache SET state='saved',target_files_json=$2,ownership_manifest_json=ownership_manifest_json || $3,updated_at=now() WHERE id=$1").bind(id).bind(json!(files)).bind(json!({"tree":tree,"stage":"saved"})).execute(&state.pool).await?;
        let share = share_saved(state, session, key, &drive, id, &files, &p, expires).await?;
        Ok::<_, ApiError>(share)
    };
    // The HTTP handler owns the five-second response deadline. Already-sent writes
    // must finish here so their exact file/share identities remain available to cleanup.
    match workflow.await {
        Ok(share) => Ok(delivered(key, link, &current, &share, expires, false)),
        Err(error) => {
            // The request itself falls back to the original link, so without
            // this line the upstream reason (a rejected transfer, a rejected
            // share) would be invisible: messages are business-level replies,
            // never credentials or file listings.
            tracing::warn!(provider=%drive.wire.provider.name(), error=%error, wrote=drive.wrote(), "delivery workflow failed; artifacts stay for reconciliation");
            // An interrupted external write is never treated as safe to repeat.
            // A share rejected by the provider already recorded `share_failed`
            // on the row; keep that specific code instead of masking it.
            sqlx::query("UPDATE link_share_cache SET state=CASE WHEN ownership_manifest_json->>'stage' IN('saved','share_created') THEN 'saved' ELSE $2 END,last_error_code=CASE WHEN last_error_code='share_failed' THEN 'share_failed' ELSE 'uncertain' END,updated_at=now() WHERE id=$1 AND state<>'ready'").bind(id).bind(if drive.wrote(){"uncertain"}else{"failed"}).execute(&state.pool).await?;
            if !drive.wrote() {
                let mut tx = state.pool.begin().await?;
                sqlx::query("UPDATE link_share_cache SET state='deleted',deleted_at=now(),last_error_code='no_cloud_write' WHERE id=$1").bind(id).execute(&mut *tx).await?;
                sqlx::query("UPDATE link_cleanup_jobs SET status='completed',completed_at=now(),progress_json='{\"noCloudWrite\":true}' WHERE share_cache_id=$1").bind(id).execute(&mut *tx).await?;
                tx.commit().await?;
            }
            retire_timed_out_artifacts(state, session, key).await?;
            Ok(fallback(
                key,
                link,
                &super::fact(state, link_id).await?,
                if drive.wrote() {
                    "uncertain"
                } else {
                    "transfer_failed"
                },
            ))
        }
    }
}

/// Retire only artifacts written by this expired request, never a delivered cache hit.
pub(super) async fn retire_timed_out_artifacts(
    state: &AppState,
    session: &Session,
    key: Uuid,
) -> Result<(), ApiError> {
    sqlx::query(include_str!("retire_timed_out_artifacts.sql"))
        .bind(subject(session)).bind(key).execute(&state.pool).await?;
    Ok(())
}

pub(super) async fn cleanup_tick(state: &AppState) -> Result<(), ApiError> {
    let token = Uuid::new_v4();
    let row=sqlx::query("UPDATE link_cleanup_jobs SET status='running',lease_token=$1,lease_until=now()+interval '180 seconds',attempts=attempts+1 WHERE id=(SELECT id FROM link_cleanup_jobs WHERE (status='queued' AND run_after<=now()) OR (status='running' AND lease_until<now()) ORDER BY run_after,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *").bind(token).fetch_optional(&state.pool).await?;
    let Some(job) = row else { return Ok(()) };
    let job_id: i64 = job.get("id");
    let id: Uuid = job.get("share_cache_id");
    let result =
        tokio::time::timeout(Duration::from_secs(120), cleanup(state, id, job_id, token)).await;
    if !matches!(result, Ok(Ok(()))) {
        // The job row keeps only a fixed reason code; this line keeps the
        // human-readable cause visible without it being lost between retries.
        let detail = match &result {
            Ok(Err(error)) => error.to_string(),
            Err(_) => "cleanup exceeded its 120s budget".into(),
            Ok(Ok(())) => String::new(),
        };
        tracing::warn!(job=job_id, detail=%detail, "cleanup attempt failed");
        let waiting_auth=matches!(&result,Ok(Err(ApiError::CloudAuthRequired(_))));
        let busy = matches!(&result, Ok(Err(ApiError::Unavailable(message))) if message == "网盘正在执行其他写操作，稍后重试清理"||message=="网盘凭证已更新，稍后重试当前任务");
        let blocked = waiting_auth || matches!(result, Ok(Err(ApiError::Conflict(_) | ApiError::Forbidden(_))))
            || (!busy && job.get::<i32, _>("attempts") >= 5);
        let reason = match &result {
            _ if waiting_auth => "waiting_auth",
            Ok(Err(ApiError::Conflict(_) | ApiError::Forbidden(_))) => "ownership_verification_required",
            Ok(Err(ApiError::BadRequest(_) | ApiError::Unauthorized(_))) => "cleanup_credentials_or_permissions",
            Err(_) => "cleanup_timeout",
            _ if busy => "cleanup_busy",
            _ => "cleanup_retry",
        };
        if blocked && !waiting_auth {
            sqlx::query("UPDATE link_share_cache SET state='uncertain',last_error_code=$4 WHERE id=$1 AND EXISTS(SELECT 1 FROM link_cleanup_jobs WHERE id=$2 AND lease_token=$3 AND status='running' AND lease_until>now())").bind(id).bind(job_id).bind(token).bind(reason).execute(&state.pool).await?;
        }
        sqlx::query("UPDATE link_cleanup_jobs SET status=$3,last_error_code=$4,lease_until=NULL,run_after=now()+make_interval(secs=>$5),attempts=attempts-CASE WHEN $6 THEN 1 ELSE 0 END,updated_at=now() WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now()")
            .bind(job_id).bind(token).bind(if blocked{"blocked"}else{"queued"}).bind(reason).bind(if busy { 10.0f64 } else { 1800.0 }).bind(busy||waiting_auth).execute(&state.pool).await?;
    }
    Ok(())
}
async fn cleanup(state: &AppState, id: Uuid, job_id: i64, token: Uuid) -> Result<(), ApiError> {
    let row=sqlx::query("SELECT s.*,c.provider FROM link_share_cache s JOIN link_catalog c ON c.id=s.link_id WHERE s.id=$1").bind(id).fetch_one(&state.pool).await?;
    let cleanup_after: DateTime<Utc> = row.get("cleanup_after");
    if cleanup_after > Utc::now() {
        sqlx::query("UPDATE link_cleanup_jobs SET status='queued',run_after=$3,lease_until=NULL,attempts=GREATEST(attempts-1,0),updated_at=now() WHERE id=$1 AND lease_token=$2 AND status='running'")
            .bind(job_id).bind(token).bind(cleanup_after).execute(&state.pool).await?;
        return Ok(());
    }
    let provider = Provider::from_name(&row.get::<String, _>("provider"))?;
    let drive = Drive::load(state, provider).await?;
    let _lock = try_lock(state, &drive).await?
        .ok_or_else(|| ApiError::Unavailable("网盘正在执行其他写操作，稍后重试清理".into()))?;
    // Credential migration can rewrite an old Cookie fingerprint before this
    // lock was acquired. Compare the current artifact, not the pre-lock snapshot.
    let row=sqlx::query("SELECT s.*,c.provider FROM link_share_cache s JOIN link_catalog c ON c.id=s.link_id WHERE s.id=$1").bind(id).fetch_one(&state.pool).await?;
    if drive.account != row.get::<String, _>("target_account_key") {
        return Err(ApiError::Conflict("账号已变化".into()));
    }
    let lease = cleanup_checkpoint(state, job_id, token, "verify").await?;
    drive.wire.write_deadline_ms.store(lease.timestamp_millis(), std::sync::atomic::Ordering::SeqCst);
    sqlx::query("UPDATE link_share_cache SET state='cleaning',updated_at=now() WHERE id=$1")
        .bind(id)
        .execute(&state.pool)
        .await?;
    let evidence: Value = row.get("ownership_manifest_json");
    // Unknown directory/transfer/share writes need read-only reconciliation, never blind deletion.
    if !matches!(
        evidence["stage"].as_str(),
        Some("ready" | "saved" | "share_created")
    ) {
        // A directory/transfer intent may never have issued an upstream write.
        // An owned directory that is provably empty means nothing was written,
        // which is exactly as safe as the tracked empty "saved" stage; any
        // content still requires human review.
        let reconcilable = matches!(
            evidence["stage"].as_str(),
            Some("directory_created" | "directory_intent" | "transfer_intent")
        ) && match serde_json::from_value::<File>(evidence["directory"].clone()) {
            Ok(owned) => drive
                .list(&directory_key(provider, &owned))
                .await
                .map(|files| files.is_empty())
                .unwrap_or(false),
            Err(_) => false,
        };
        if !reconcilable {
            tracing::warn!(
                stage=evidence["stage"].as_str().unwrap_or(""),
                "cleanup refuses an artifact whose write state is not reconcilable"
            );
            return Err(ApiError::Conflict("产物写入状态不确定".into()));
        }
    }
    let owned: File = serde_json::from_value(evidence["directory"].clone())
        .map_err(|_| ApiError::Conflict("目录归属缺失".into()))?;
    let root = row.get::<String, _>("target_dir");
    let target = directory_key(provider, &owned);
    let present = drive
        .list(&root)
        .await
        .map_err(|e| e.api())?
        .into_iter()
        .find(|f| f.id == owned.id);
    if let Some(current) = &present {
        // A directory created before the create response carried its name has
        // an empty recorded name; the id match plus the tree comparison below
        // remain the ownership proof in that case.
        if (!owned.name.is_empty() && current.name != owned.name) || !current.is_dir {
            return Err(ApiError::Conflict("目录被修改".into()));
        }
    }
    let shares: Vec<String> = serde_json::from_value(row.get("upstream_share_ids_json"))
        .map_err(|_| ApiError::Conflict("分享记录损坏".into()))?;
    let progress: Value = sqlx::query_scalar(
        "SELECT progress_json FROM link_cleanup_jobs WHERE id=$1 AND lease_token=$2",
    )
    .bind(job_id)
    .bind(token)
    .fetch_one(&state.pool)
    .await?;
    let mut revoked: Vec<String> =
        serde_json::from_value(progress["revoked"].clone()).unwrap_or_default();
    for share in shares {
        if revoked.contains(&share) {
            continue;
        }
        cleanup_checkpoint(state, job_id, token, "revoke_shares").await?;
        drive.revoke_share(&share).await.map_err(|e| e.api())?;
        revoked.push(share);
        sqlx::query("UPDATE link_cleanup_jobs SET stage='revoke_shares',progress_json=$3 WHERE id=$1 AND lease_token=$2").bind(job_id).bind(token).bind(json!({"revoked":revoked})).execute(&state.pool).await?;
    }
    if present.is_some() {
        if manifest(&drive, &target).await? != evidence["tree"] {
            return Err(ApiError::Conflict("目录内容变化，拒绝递归删除".into()));
        }
        cleanup_checkpoint(state, job_id, token, "delete_files").await?;
        drive
            .delete_files(&[owned.clone()])
            .await
            .map_err(|e| e.api())?;
        if drive
            .list(&root)
            .await
            .map_err(|e| e.api())?
            .iter()
            .any(|f| f.id == owned.id)
        {
            return Err(ApiError::Unavailable("删除尚未确认".into()));
        }
    }
    let mut tx = state.pool.begin().await?;
    let finished = sqlx::query("UPDATE link_cleanup_jobs SET status='completed',stage='verify_deleted',completed_at=now(),lease_until=NULL WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now()").bind(job_id).bind(token).execute(&mut *tx).await?;
    if finished.rows_affected() != 1 { return Err(ApiError::Conflict("清理任务租约已失效，未覆盖新任务状态".into())); }
    sqlx::query("UPDATE link_share_cache SET state='deleted',deleted_at=now(),share_validity=0,updated_at=now() WHERE id=$1").bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

// Fence every new cloud mutation against the live job generation. Admin retry
// or lease reclamation must never let a stale worker continue issuing deletes.
pub(super) async fn cleanup_checkpoint(state: &AppState, job_id: i64, token: Uuid, stage: &str) -> Result<DateTime<Utc>, ApiError> {
    sqlx::query_scalar("UPDATE link_cleanup_jobs SET stage=$3,updated_at=now() WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now() RETURNING lease_until")
        .bind(job_id).bind(token).bind(stage).fetch_optional(&state.pool).await?
        .ok_or_else(|| ApiError::Conflict("清理任务租约已失效，停止后续云端写操作".into()))
}

pub async fn get_cloud_providers(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    super::admin(&state, &headers).await?;
    let items: Vec<ProviderPolicy> = sqlx::query_as(&format!(
        "SELECT {POLICY_COLUMNS} FROM cloud_provider_policies ORDER BY array_position(ARRAY['quark','baidu','aliyun','xunlei','guangya'],provider)"
    ))
    .fetch_all(&state.pool)
    .await?;
    Ok(response(StatusCode::OK, json!({"items":items})))
}
pub async fn put_cloud_provider(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(provider): Path<String>,
    Json(policy): Json<ProviderPolicy>,
) -> Result<Response, ApiError> {
    super::admin(&state, &headers).await?;
    let p = Provider::from_name(&provider)?;
    policy.validate(p)?;
    let dir = policy.target_dir.as_deref().map(str::trim).filter(|d| !d.is_empty());
    let saved: ProviderPolicy = sqlx::query_as(&format!(
        "UPDATE cloud_provider_policies SET delivery_enabled=$2,target_dir=$3,target_dir_name=$4,retention_seconds=$5,delivery_min_remaining_seconds=$6,platform_share_days=$7,check_interval_seconds=$8,check_valid_seconds=$9,check_invalid_seconds=$10,check_daily_budget=$11,revision=revision+1,updated_at=now() WHERE provider=$1 RETURNING {POLICY_COLUMNS}"
    ))
    .bind(&provider)
    .bind(policy.enabled)
    .bind(dir)
    .bind(policy.target_dir_name.trim())
    .bind(policy.retention_seconds)
    .bind(policy.delivery_min_remaining_seconds)
    .bind(policy.platform_share_days)
    .bind(policy.check_interval_seconds)
    .bind(policy.check_valid_seconds)
    .bind(policy.check_invalid_seconds)
    .bind(policy.check_daily_budget)
    .fetch_one(&state.pool)
    .await?;
    Ok(response(StatusCode::OK, json!(saved)))
}
/// Clear the delivery half of a provider row (switch, directory, retention) while
/// keeping the detection parameters. Already transferred artifacts are untouched.
pub async fn clear_cloud_provider_delivery(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(provider): Path<String>,
) -> Result<Response, ApiError> {
    super::admin(&state, &headers).await?;
    Provider::from_name(&provider)?;
    let saved: ProviderPolicy = sqlx::query_as(&format!(
        "UPDATE cloud_provider_policies SET delivery_enabled=false,target_dir=NULL,target_dir_name='',retention_seconds=NULL,revision=revision+1,updated_at=now() WHERE provider=$1 RETURNING {POLICY_COLUMNS}"
    ))
    .bind(&provider)
    .fetch_one(&state.pool)
    .await?;
    Ok(response(StatusCode::OK, json!(saved)))
}
