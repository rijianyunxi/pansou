use super::*;
use crate::cloud_drive::{Drive, File, Provider, ShareInput};

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderPolicy {
    #[serde(default)]
    pub enabled: bool,
    pub target_dir: Option<String>,
    pub delivery_ttl_seconds: Option<i32>,
    #[serde(default = "minimum")]
    pub delivery_min_remaining_seconds: i32,
    #[serde(default = "days")]
    pub platform_share_days: u32,
}
fn minimum() -> i32 {
    300
}
fn days() -> u32 {
    7
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeliveryPolicy {
    #[serde(default = "revision")]
    pub revision: i64,
    #[serde(default)]
    pub baidu: ProviderPolicy,
    #[serde(default)]
    pub quark: ProviderPolicy,
}
fn revision() -> i64 {
    1
}
impl DeliveryPolicy {
    pub fn validate(&self) -> Result<(), ApiError> {
        for (provider, p) in [
            (Provider::Baidu, &self.baidu),
            (Provider::Quark, &self.quark),
        ] {
            if p.enabled {
                let ttl = p.delivery_ttl_seconds.unwrap_or(0);
                if !(60..=2592000).contains(&ttl)
                    || p.delivery_min_remaining_seconds < 0
                    || p.delivery_min_remaining_seconds >= ttl
                    || ![1, 7, 30].contains(&p.platform_share_days)
                {
                    return Err(ApiError::BadRequest(
                        "保留期须在60秒至30天内，临期窗口须小于保留期，平台分享期限为1/7/30天"
                            .into(),
                    ));
                }
                let dir = p.target_dir.as_deref().unwrap_or("");
                if dir.is_empty() || dir == "/" || dir == "0" {
                    return Err(ApiError::BadRequest(
                        "必须配置非根目录的项目专用目录".into(),
                    ));
                }
                crate::cloud_drive::validate_dir(provider, Some(dir))?;
            }
        }
        Ok(())
    }
}
async fn load(state: &AppState) -> Result<DeliveryPolicy, ApiError> {
    let value: Value =
        sqlx::query_scalar("SELECT value_json FROM policy_settings WHERE key='link-delivery'")
            .fetch_one(&state.pool)
            .await?;
    serde_json::from_value(value).map_err(|_| ApiError::Unavailable("交付策略配置无效".into()))
}
async fn lock(
    state: &AppState,
    drive: &Drive,
) -> Result<sqlx::Transaction<'static, sqlx::Postgres>, ApiError> {
    let mut tx = state.pool.begin().await?;
    let acquired: bool =
        sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0))")
            .bind(format!("pansou:cloud-write:{}", drive.wire.provider.name()))
            .fetch_one(&mut *tx)
            .await?;
    if !acquired {
        return Err(ApiError::Conflict("网盘正在执行其他写操作".into()));
    }
    drive.ensure_current_account(&mut tx).await?;
    Ok(tx)
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
            .begin_temporary_share(files, p.platform_share_days)
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
    let share_expires_at: Option<DateTime<Utc>> =
        serde_json::from_value(share["shareExpiresAt"].clone()).ok();
    let mut share = drive
        .finish_temporary_share(&share)
        .await
        .map_err(|e| e.api())?;
    if share["url"].as_str().is_none_or(str::is_empty) {
        return Err(ApiError::Conflict("分享链接缺失".into()));
    }
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
    let policy: Value =
        sqlx::query_scalar("SELECT value_json FROM policy_settings WHERE key='link-check'")
            .fetch_one(&state.pool)
            .await?;
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
    let policy = load(state).await?;
    let provider = if link.r#type == "baidu" {
        Provider::Baidu
    } else {
        Provider::Quark
    };
    let p = if provider == Provider::Baidu {
        &policy.baidu
    } else {
        &policy.quark
    };
    let drive = Drive::load(state, provider).await?;
    let deadline: DateTime<Utc> = sqlx::query_scalar(
        "SELECT deadline_at FROM link_resolve_requests WHERE subject_key=$1 AND request_key=$2",
    )
    .bind(subject(session))
    .bind(key)
    .fetch_one(&state.pool)
    .await?;
    if !p.enabled && p.target_dir.as_deref().is_none_or(str::is_empty) {
        let _ = original_context(state, &drive, link, deadline).await;
        return Ok(fallback(
            key,
            link,
            &super::fact(state, link_id).await?,
            "delivery_disabled",
        ));
    }
    policy.validate()?;
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
    let policy = load(state).await?;
    policy.validate()?;
    let p = if provider == Provider::Baidu {
        &policy.baidu
    } else {
        &policy.quark
    };
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
                match tokio::time::timeout(
                    Duration::from_millis(remaining as u64),
                    share_saved(state, session, key, &drive, id, &files, p, expires),
                )
                .await
                {
                    Ok(Ok(share)) => return Ok(delivered(key, link, fact, &share, expires, true)),
                    _ => return Ok(fallback(key, link, fact, "share_failed")),
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
    let ttl = p.delivery_ttl_seconds.unwrap();
    let expires = Utc::now() + chrono::Duration::seconds(ttl as i64);
    // Persist both ownership intent and cleanup before the first external write.
    let mut tx = state.pool.begin().await?;
    sqlx::query("INSERT INTO link_share_cache(id,link_id,input_version,target_account_key,account_revision,policy_revision,target_dir,state,generation,retention_seconds,cleanup_after,ownership_manifest_json) VALUES($1,$2,1,$3,1,$4,$5,'saving',(SELECT COALESCE(MAX(generation),0)+1 FROM link_share_cache WHERE link_id=$2),$6,$7,$8)")
        .bind(id).bind(link_id).bind(&drive.account).bind(policy.revision).bind(dir).bind(ttl).bind(expires).bind(json!({"name":format!("pansou-{id}"),"parent":dir,"account":drive.account,"stage":"directory_intent","minRemainingSeconds":p.delivery_min_remaining_seconds})).execute(&mut *tx).await?;
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
        sqlx::query("UPDATE link_share_cache SET owned_dir_id=$2,owned_dir_path=$3,ownership_manifest_json=ownership_manifest_json || $4 WHERE id=$1").bind(id).bind(&owned.id).bind(&owned.path).bind(json!({"directory":owned,"stage":"transfer_intent"})).execute(&state.pool).await?;
        if !drive.list(&target).await.map_err(|e| e.api())?.is_empty() {
            return Err(ApiError::Conflict("新目录不为空".into()));
        }
        authorize_write(state, session, key).await?;
        let ids = drive
            .transfer(&context, &target)
            .await
            .map_err(|e| e.api())?;
        let files = drive.list(&target).await.map_err(|e| e.api())?;
        if files.len() != context.files.len() || files.iter().any(|f| !ids.contains(&f.id)) {
            return Err(ApiError::Conflict("转存结果身份不确定".into()));
        }
        let tree = manifest(&drive, &target).await?;
        sqlx::query("UPDATE link_share_cache SET state='saved',target_files_json=$2,ownership_manifest_json=ownership_manifest_json || $3,updated_at=now() WHERE id=$1").bind(id).bind(json!(files)).bind(json!({"tree":tree,"stage":"saved"})).execute(&state.pool).await?;
        let share = share_saved(state, session, key, &drive, id, &files, p, expires).await?;
        Ok::<_, ApiError>(share)
    };
    match tokio::time::timeout(Duration::from_millis(remaining as u64), workflow).await {
        Ok(Ok(share)) => Ok(delivered(key, link, &current, &share, expires, false)),
        _ => {
            // An interrupted external write is never treated as safe to repeat.
            sqlx::query("UPDATE link_share_cache SET state=CASE WHEN ownership_manifest_json->>'stage' IN('saved','share_created') THEN 'saved' ELSE $2 END,last_error_code='uncertain',updated_at=now() WHERE id=$1 AND state<>'ready'").bind(id).bind(if drive.wrote(){"uncertain"}else{"failed"}).execute(&state.pool).await?;
            if !drive.wrote() {
                let mut tx = state.pool.begin().await?;
                sqlx::query("UPDATE link_share_cache SET state='deleted',deleted_at=now(),last_error_code='no_cloud_write' WHERE id=$1").bind(id).execute(&mut *tx).await?;
                sqlx::query("UPDATE link_cleanup_jobs SET status='completed',completed_at=now(),progress_json='{\"noCloudWrite\":true}' WHERE share_cache_id=$1").bind(id).execute(&mut *tx).await?;
                tx.commit().await?;
            }
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

pub(super) async fn cleanup_tick(state: &AppState) -> Result<(), ApiError> {
    let token = Uuid::new_v4();
    let row=sqlx::query("UPDATE link_cleanup_jobs SET status='running',lease_token=$1,lease_until=now()+interval '180 seconds',attempts=attempts+1 WHERE id=(SELECT id FROM link_cleanup_jobs WHERE (status='queued' AND run_after<=now()) OR (status='running' AND lease_until<now()) ORDER BY run_after,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *").bind(token).fetch_optional(&state.pool).await?;
    let Some(job) = row else { return Ok(()) };
    let job_id: i64 = job.get("id");
    let id: Uuid = job.get("share_cache_id");
    let result =
        tokio::time::timeout(Duration::from_secs(120), cleanup(state, id, job_id, token)).await;
    if !matches!(result, Ok(Ok(()))) {
        let blocked =
            matches!(result, Ok(Err(ApiError::Conflict(_)))) || job.get::<i32, _>("attempts") >= 5;
        if blocked {
            sqlx::query("UPDATE link_share_cache SET state='uncertain',last_error_code='ownership_verification_required' WHERE id=$1").bind(id).execute(&state.pool).await?;
        }
        sqlx::query("UPDATE link_cleanup_jobs SET status=$3,last_error_code=$4,lease_until=NULL,run_after=now()+interval '30 minutes',updated_at=now() WHERE id=$1 AND lease_token=$2")
            .bind(job_id).bind(token).bind(if blocked{"blocked"}else{"queued"}).bind(if blocked{"ownership_verification_required"}else{"cleanup_retry"}).execute(&state.pool).await?;
    }
    Ok(())
}
async fn cleanup(state: &AppState, id: Uuid, job_id: i64, token: Uuid) -> Result<(), ApiError> {
    let row=sqlx::query("SELECT s.*,c.provider FROM link_share_cache s JOIN link_catalog c ON c.id=s.link_id WHERE s.id=$1").bind(id).fetch_one(&state.pool).await?;
    let provider = if row.get::<String, _>("provider") == "baidu" {
        Provider::Baidu
    } else {
        Provider::Quark
    };
    let drive = Drive::load(state, provider).await?;
    let _lock = lock(state, &drive).await?;
    if drive.account != row.get::<String, _>("target_account_key") {
        return Err(ApiError::Conflict("账号已变化".into()));
    }
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
        return Err(ApiError::Conflict("产物写入状态不确定".into()));
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
        if current.name != owned.name || !current.is_dir {
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
        drive.revoke_share(&share).await.map_err(|e| e.api())?;
        revoked.push(share);
        sqlx::query("UPDATE link_cleanup_jobs SET stage='revoke_shares',progress_json=$3 WHERE id=$1 AND lease_token=$2").bind(job_id).bind(token).bind(json!({"revoked":revoked})).execute(&state.pool).await?;
    }
    if present.is_some() {
        if manifest(&drive, &target).await? != evidence["tree"] {
            return Err(ApiError::Conflict("目录内容变化，拒绝递归删除".into()));
        }
        sqlx::query(
            "UPDATE link_cleanup_jobs SET stage='delete_files' WHERE id=$1 AND lease_token=$2",
        )
        .bind(job_id)
        .bind(token)
        .execute(&state.pool)
        .await?;
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
    sqlx::query("UPDATE link_share_cache SET state='deleted',deleted_at=now(),share_validity=0,updated_at=now() WHERE id=$1").bind(id).execute(&mut *tx).await?;
    sqlx::query("UPDATE link_cleanup_jobs SET status='completed',stage='verify_deleted',completed_at=now(),lease_until=NULL WHERE id=$1 AND lease_token=$2").bind(job_id).bind(token).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

pub async fn get_policy(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    super::admin(&state, &headers).await?;
    Ok(response(StatusCode::OK, json!(load(&state).await?)))
}
pub async fn put_policy(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(mut policy): Json<DeliveryPolicy>,
) -> Result<Response, ApiError> {
    super::admin(&state, &headers).await?;
    policy.validate()?;
    let mut tx = state.pool.begin().await?;
    for provider in ["baidu", "quark"] {
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
            .bind(format!("pansou:cloud-write:{provider}"))
            .execute(&mut *tx)
            .await?;
    }
    let old: Value = sqlx::query_scalar(
        "SELECT value_json FROM policy_settings WHERE key='link-delivery' FOR UPDATE",
    )
    .fetch_one(&mut *tx)
    .await?;
    policy.revision = old["revision"].as_i64().unwrap_or(0) + 1;
    sqlx::query(
        "UPDATE policy_settings SET value_json=$1,updated_at=now() WHERE key='link-delivery'",
    )
    .bind(json!(policy))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(response(StatusCode::OK, json!(policy)))
}
