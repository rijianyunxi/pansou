//! Administrative account bindings. Every credential replacement is fenced by
//! binding epoch, token revision and lease.
mod providers;
pub(crate) mod qr_settings;
pub(crate) use providers::xunlei::retry_after as xunlei_retry_after;
#[cfg(test)]
mod tests;

use crate::{
    app::AppState,
    cloud_drive::{self, Drive, Provider},
    error::ApiError,
};
use chrono::{DateTime, Duration, Utc};
use serde_json::{Value, json};
use sqlx::{FromRow, Row};
use std::sync::Arc;
use uuid::Uuid;

#[derive(Clone, Copy, Debug)]
pub enum AuthFailure {
    Network,
    Protocol,
    RateLimited,
    RateLimitedAfter(i64),
    Reauthorize,
    Verification,
    AccountMismatch,
    AccountUnverified,
    ExchangeUncertain,
    ClientConfiguration,
    Unsupported,
}
impl AuthFailure {
    pub fn code(self) -> &'static str {
        match self {
            Self::Network => "network_error",
            Self::Protocol => "provider_protocol_error",
            Self::RateLimited | Self::RateLimitedAfter(_) => "rate_limited",
            Self::Reauthorize => "reauthorization_required",
            Self::Verification => "verification_required",
            Self::AccountMismatch => "account_mismatch",
            Self::AccountUnverified => "account_unverified",
            Self::ExchangeUncertain => "authorization_exchange_uncertain",
            Self::ClientConfiguration => "client_configuration_required",
            Self::Unsupported => "qr_unavailable",
        }
    }
    pub fn api(self) -> ApiError {
        let message = match self {
            Self::Network => "网盘认证服务连接失败，请稍后重试",
            Self::Protocol => "网盘认证协议返回异常，请使用高级导入或稍后重试",
            Self::RateLimited | Self::RateLimitedAfter(_) => "网盘认证操作过于频繁，请稍后再试",
            Self::Reauthorize => "网盘授权已失效，请重新连接账号",
            Self::Verification => "网盘要求额外验证，请在官方网盘完成验证后重新连接",
            Self::AccountMismatch => {
                "账号或存储空间不一致，未更新凭证；切换账号请先明确选择更换账号"
            }
            Self::AccountUnverified => {
                "原账号凭证已失效且从未完成身份核实，无法确认是否为同一账号；请选择更换账号，或先断开连接再连接"
            }
            Self::ExchangeUncertain => {
                "扫码授权兑换结果未确认，为避免重复使用一次性票据，请重新扫码"
            }
            Self::ClientConfiguration => {
                "缺少同一官方登录会话的客户端或设备配置，请检查服务端配置或高级导入完整凭证"
            }
            Self::Unsupported => "此网盘的扫码协议尚未确认，请使用高级导入",
        };
        match self {
            Self::AccountMismatch | Self::AccountUnverified => ApiError::Conflict(message.into()),
            Self::RateLimited | Self::RateLimitedAfter(_) => {
                ApiError::TooManyRequests(message.into())
            }
            Self::Reauthorize | Self::Verification => ApiError::CloudAuthRequired(message.into()),
            Self::ExchangeUncertain => ApiError::CloudAuthRequired(message.into()),
            Self::Network | Self::Protocol => ApiError::Upstream(message.into()),
            _ => ApiError::BadRequest(message.into()),
        }
    }
}

#[derive(FromRow)]
pub struct Stored {
    pub credential: String,
    pub account_key: Option<String>,
    pub binding_epoch: i64,
    pub token_revision: i64,
    pub auth_status: String,
    pub refreshable: bool,
    pub expires_at: Option<DateTime<Utc>>,
    pub auth_source: String,
    pub refresh_lease_until: Option<DateTime<Utc>>,
    pub refresh_started_at: Option<DateTime<Utc>>,
    pub pending_refresh_credential: Option<String>,
}
impl Stored {
    fn configured(&self) -> bool {
        !self.credential.trim().is_empty()
    }
}
pub async fn verify_binding_identity(
    state: &AppState,
    p: Provider,
    raw: &str,
    key: &str,
) -> Result<(), ApiError> {
    let identity = providers::identity(state, p, raw)
        .await
        .map_err(AuthFailure::api)?;
    if providers::stable_key(p, &identity.subject, &identity.scope) != key {
        return Err(AuthFailure::AccountMismatch.api());
    }
    Ok(())
}
pub async fn persist_cookies(
    pool: &sqlx::PgPool,
    p: Provider,
    epoch: i64,
    revision: i64,
    updates: &[String],
) -> Result<Option<i64>, ApiError> {
    let old=sqlx::query_as::<_,Stored>("SELECT * FROM cloud_account_settings WHERE provider=$1 AND binding_epoch=$2 AND token_revision=$3 AND credential<>''").bind(p.name()).bind(epoch).bind(revision).fetch_optional(pool).await?;
    let Some(old) = old else { return Ok(None) };
    let raw = old.credential.clone();
    let merged = cloud_drive::transport::merge_cookies(&raw, updates);
    if raw == merged {
        return Ok(Some(revision));
    }
    let changed=sqlx::query("UPDATE cloud_account_settings SET credential=$4,token_revision=token_revision+1,updated_at=now() WHERE provider=$1 AND binding_epoch=$2 AND token_revision=$3 AND refresh_lease IS NULL").bind(p.name()).bind(epoch).bind(revision).bind(merged).execute(pool).await?.rows_affected();
    Ok((changed == 1).then_some(revision + 1))
}
pub async fn stored(state: &AppState, p: Provider) -> Result<Option<Stored>, ApiError> {
    Ok(
        sqlx::query_as::<_, Stored>("SELECT * FROM cloud_account_settings WHERE provider=$1")
            .bind(p.name())
            .fetch_optional(&state.pool)
            .await?,
    )
}
pub async fn list(state: &AppState) -> Result<Value, ApiError> {
    let rows=sqlx::query("SELECT provider,credential<>'' AS configured,subject_id,display_name,storage_scope,auth_status,auth_source,refreshable,binding_epoch,token_revision,expires_at,last_verified_at,last_refresh_at,last_error_code FROM cloud_account_settings").fetch_all(&state.pool).await?;
    let mut result = Vec::new();
    for p in Provider::ALL {
        let row = rows
            .iter()
            .find(|r| r.get::<String, _>("provider") == p.name());
        let mut item = json!({"provider":p,"configured":false,"status":"disconnected","bindingEpoch":0,"tokenRevision":0,"refreshable":false,"qrSupported":providers::qr_supported(state, p).await?,"officialUrl":providers::official_url(p)});
        if let Some(r) = row {
            let configured = r.get::<bool, _>("configured");
            item["configured"] = json!(configured);
            item["status"] = json!(if configured {
                r.get::<String, _>("auth_status")
            } else {
                "disconnected".into()
            });
            for (to, from) in [
                ("subjectId", "subject_id"),
                ("displayName", "display_name"),
                ("lastErrorCode", "last_error_code"),
            ] {
                item[to] = json!(r.get::<Option<String>, _>(from));
            }
            item["storageScope"] = json!(r.get::<String, _>("storage_scope"));
            item["source"] = json!(r.get::<String, _>("auth_source"));
            item["refreshable"] = json!(r.get::<bool, _>("refreshable"));
            item["bindingEpoch"] = json!(r.get::<i64, _>("binding_epoch"));
            item["tokenRevision"] = json!(r.get::<i64, _>("token_revision"));
            for (to, from) in [
                ("expiresAt", "expires_at"),
                ("lastVerifiedAt", "last_verified_at"),
                ("lastRefreshAt", "last_refresh_at"),
            ] {
                item[to] = json!(r.get::<Option<DateTime<Utc>>, _>(from));
            }
        }
        result.push(item);
    }
    Ok(json!({"items":result}))
}
async fn write_lock(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    p: Provider,
) -> Result<(), ApiError> {
    let locked =
        sqlx::query_scalar::<_, bool>("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0))")
            .bind(format!("pansou:cloud-write:{}", p.name()))
            .fetch_one(&mut **tx)
            .await?;
    if !locked {
        return Err(ApiError::Unavailable(
            "网盘正在执行写操作，请稍后更新账号".into(),
        ));
    }
    Ok(())
}
async fn ensure_row(state: &AppState, p: Provider) -> Result<(), ApiError> {
    sqlx::query("INSERT INTO cloud_account_settings(provider) VALUES($1) ON CONFLICT DO NOTHING")
        .bind(p.name())
        .execute(&state.pool)
        .await?;
    Ok(())
}

/// Validation is read-only except for the provider's device authentication
/// registration. Never retry transfers/deletions after a credential refresh.
async fn verify(state: &AppState, p: Provider, raw: &str) -> Result<providers::Identity, ApiError> {
    let mut identity = providers::identity(state, p, raw)
        .await
        .map_err(AuthFailure::api)?;
    let drive = Drive::from_state(state, p, identity.raw.clone());
    drive.list(p.root()).await.map_err(|e| e.api())?;
    identity.raw = drive.wire.snapshot().await;
    Ok(identity)
}
pub async fn import(
    state: &AppState,
    p: Provider,
    raw: &str,
    intent: &str,
    epoch: i64,
) -> Result<(), ApiError> {
    if raw.len() > 32768
        || raw.trim().is_empty()
        || raw.chars().any(|c| c == '\r' || c == '\n') && !p.token_auth()
    {
        return Err(ApiError::BadRequest("凭证为空、过长或含非法换行".into()));
    }
    ensure_row(state, p).await?;
    validate_intent(intent)?;
    let old = stored(state, p).await?.unwrap();
    if old.binding_epoch != epoch {
        return Err(ApiError::Conflict("账号状态已变化，请刷新后重试".into()));
    }
    let mut raw = raw.trim().to_owned();
    if p.token_auth() {
        let value: Value = serde_json::from_str(&raw)
            .map_err(|_| ApiError::BadRequest("请输入登录凭证 JSON".into()))?;
        if cloud_drive::scalar(&value["access_token"]).is_empty()
            && cloud_drive::scalar(&value["authorization"]).is_empty()
            && providers::refreshable(p, &raw)
        {
            raw = providers::refresh(state, p, &raw)
                .await
                .map_err(AuthFailure::api)?;
        }
    }
    let identity = verify(state, p, &raw).await?;
    commit(state, p, &old, identity, intent, "import", None, None)
        .await
        .map_err(CommitError::api)
}
fn validate_intent(intent: &str) -> Result<(), ApiError> {
    if !matches!(intent, "connect" | "reauthorize" | "replace") {
        return Err(ApiError::BadRequest("连接模式不正确".into()));
    }
    Ok(())
}

/// Why a credential could not be committed. The two mismatch causes need
/// different guidance: a still-verifiable old credential really does belong to
/// another account, while an unverifiable one only means sameness is unknown.
enum CommitError {
    Auth(AuthFailure),
    Api(ApiError),
}
impl From<ApiError> for CommitError {
    fn from(value: ApiError) -> Self {
        Self::Api(value)
    }
}
impl From<sqlx::Error> for CommitError {
    fn from(value: sqlx::Error) -> Self {
        Self::Api(value.into())
    }
}
impl CommitError {
    fn api(self) -> ApiError {
        match self {
            Self::Auth(failure) => failure.api(),
            Self::Api(error) => error,
        }
    }
}

async fn commit(
    state: &AppState,
    p: Provider,
    old: &Stored,
    identity: providers::Identity,
    intent: &str,
    source: &str,
    session: Option<(Uuid, Uuid)>,
    lease: Option<Uuid>,
) -> Result<(), CommitError> {
    let key = providers::stable_key(p, &identity.subject, &identity.scope);
    let oldraw = old.credential.clone();
    let oldkey = if let Some(k) = &old.account_key {
        Some(k.clone())
    } else if !oldraw.is_empty() {
        // An unverified supplied user_id is never enough to adopt old ownership.
        match providers::identity(state, p, &oldraw).await {
            Ok(i) => Some(providers::stable_key(p, &i.subject, &i.scope)),
            Err(_) => None,
        }
    } else {
        None
    };
    let same = oldkey.as_ref() == Some(&key);
    if old.configured() && !same && intent != "replace" {
        return Err(if oldkey.is_some() {
            // The stored credential still resolves to a verified account, and it
            // is not the one that was just scanned.
            CommitError::Auth(AuthFailure::AccountMismatch)
        } else {
            // The stored credential can no longer be verified, so whether this is
            // the same account is simply unknown. Adopting its ownership without
            // the user saying so is never allowed, but the reason is not a switch.
            CommitError::Auth(AuthFailure::AccountUnverified)
        });
    }
    let epoch = old.binding_epoch + if same { 0 } else { 1 };
    let revision = old.token_revision + 1;
    let expires = providers::expires_at(&identity.raw);
    let refreshable = providers::refreshable(p, &identity.raw);
    let next = next_check(expires, refreshable);
    let mut tx = state.pool.begin().await?;
    write_lock(&mut tx, p).await?;
    let current=sqlx::query("SELECT binding_epoch,token_revision,refresh_lease FROM cloud_account_settings WHERE provider=$1 FOR UPDATE").bind(p.name()).fetch_one(&mut *tx).await?;
    if current.get::<i64, _>("binding_epoch") != old.binding_epoch
        || current.get::<i64, _>("token_revision") != old.token_revision
        || lease.is_some_and(|l| current.get::<Option<Uuid>, _>("refresh_lease") != Some(l))
    {
        return Err(ApiError::Conflict("账号状态已变化，未保存旧凭证".into()).into());
    }
    if let Some((id, token)) = session {
        let active=sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM cloud_login_sessions WHERE id=$1 AND provider=$2 AND status='verifying' AND expected_epoch=$3 AND poll_lease=$4 AND poll_lease_until>now() AND expires_at>now() FOR UPDATE)").bind(id).bind(p.name()).bind(old.binding_epoch).bind(token).fetch_one(&mut *tx).await?;
        if !active {
            return Err(ApiError::Conflict("扫码会话已取消、过期或被替代".into()).into());
        }
    }
    if same && old.account_key.is_none() {
        let legacy = cloud_drive::credential_fingerprint(p, &oldraw);
        sqlx::query("UPDATE link_share_cache SET target_account_key=$2,ownership_manifest_json=jsonb_set(ownership_manifest_json,'{account}',to_jsonb($2::text)) WHERE target_account_key=$1").bind(&legacy).bind(&key).execute(&mut *tx).await?;
    }
    sqlx::query("UPDATE cloud_account_settings SET credential=$2,account_key=$3,subject_id=$4,display_name=$5,storage_scope=$6,auth_status='ready',auth_source=$7,refreshable=$8,token_revision=$9,binding_epoch=$10,expires_at=$11,next_check_at=$12,last_verified_at=now(),last_refresh_at=CASE WHEN $13 THEN now() ELSE last_refresh_at END,last_error_code=NULL,refresh_lease=NULL,refresh_lease_until=NULL,pending_refresh_credential=NULL,refresh_started_at=NULL,updated_at=now() WHERE provider=$1")
        .bind(p.name()).bind(&identity.raw).bind(&key).bind(&identity.subject).bind(&identity.name).bind(&identity.scope).bind(if matches!(source,"maintenance"|"check"){old.auth_source.as_str()}else{source}).bind(refreshable).bind(revision).bind(epoch).bind(expires).bind(next).bind(lease.is_some()&&old.refreshable).execute(&mut *tx).await?;
    if same || !old.configured() {
        sqlx::query("UPDATE link_cleanup_jobs j SET status='queued',run_after=now(),last_error_code=NULL,updated_at=now() FROM link_share_cache c WHERE j.share_cache_id=c.id AND c.target_account_key=$1 AND j.status='blocked' AND j.last_error_code='waiting_auth'").bind(&key).execute(&mut *tx).await?;
    }
    if let Some((id, token)) = session {
        sqlx::query("UPDATE cloud_login_sessions SET status='connected',context_json=NULL,qr_image=NULL,error_code=NULL,poll_lease=NULL,poll_lease_until=NULL,updated_at=now() WHERE id=$1 AND poll_lease=$2").bind(id).bind(token).execute(&mut *tx).await?;
    } else if lease.is_none() {
        sqlx::query("UPDATE cloud_login_sessions SET status='cancelled',context_json=NULL,qr_image=NULL,poll_lease=NULL,poll_lease_until=NULL WHERE provider=$1 AND status IN('starting','waiting','scanned','verifying')").bind(p.name()).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}
fn next_check(expires: Option<DateTime<Utc>>, refreshable: bool) -> DateTime<Utc> {
    if refreshable {
        expires
            .map(|t| (t - Duration::minutes(5)).max(Utc::now() + Duration::seconds(30)))
            .unwrap_or(Utc::now() + Duration::hours(1))
    } else {
        Utc::now() + Duration::hours(6)
    }
}
pub async fn disconnect(state: &AppState, p: Provider, epoch: i64) -> Result<(), ApiError> {
    ensure_row(state, p).await?;
    let mut tx = state.pool.begin().await?;
    write_lock(&mut tx, p).await?;
    let changed=sqlx::query("UPDATE cloud_account_settings SET credential='',pending_refresh_credential=NULL,refresh_started_at=NULL,account_key=NULL,subject_id=NULL,display_name=NULL,storage_scope='',auth_status='disconnected',refreshable=false,binding_epoch=binding_epoch+1,token_revision=token_revision+1,expires_at=NULL,last_error_code=NULL,refresh_lease=NULL,refresh_lease_until=NULL,updated_at=now() WHERE provider=$1 AND binding_epoch=$2").bind(p.name()).bind(epoch).execute(&mut *tx).await?.rows_affected();
    if changed == 0 {
        return Err(ApiError::Conflict("账号状态已变化，请刷新后重试".into()));
    }
    sqlx::query("UPDATE cloud_login_sessions SET status='cancelled',context_json=NULL,qr_image=NULL,poll_lease=NULL,poll_lease_until=NULL WHERE provider=$1 AND status IN('starting','waiting','scanned','verifying')").bind(p.name()).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

pub async fn check(state: &AppState, p: Provider) -> Result<(), ApiError> {
    let old = stored(state, p)
        .await?
        .ok_or_else(|| ApiError::BadRequest("尚未连接此网盘".into()))?;
    if !old.configured() {
        return Err(ApiError::BadRequest("尚未连接此网盘".into()));
    }
    if old.refresh_lease_until.is_some_and(|t| t > Utc::now()) {
        return Err(ApiError::Unavailable("网盘凭证正在维护，请稍后检查".into()));
    }
    if old.refreshable || old.pending_refresh_credential.is_some() {
        // Explicit checks may request maintenance early, but a check that raced
        // a completed rotation must not schedule another refresh of the new token.
        sqlx::query("UPDATE cloud_account_settings SET next_check_at=now() WHERE provider=$1 AND binding_epoch=$2 AND token_revision=$3")
            .bind(p.name()).bind(old.binding_epoch).bind(old.token_revision).execute(&state.pool).await?;
        maintain(state, p).await?;
        let fresh = stored(state, p).await?.unwrap();
        if fresh.auth_status != "ready" {
            return Err(AuthFailure::Reauthorize.api());
        }
        return Ok(());
    }
    let identity = match verify(state, p, &old.credential).await {
        Ok(i) => i,
        Err(error) => {
            let transient = matches!(
                error,
                ApiError::Upstream(_) | ApiError::Unavailable(_) | ApiError::TooManyRequests(_)
            );
            mark_failure(
                state,
                p,
                &old,
                if transient {
                    "network_error"
                } else {
                    "reauthorization_required"
                },
                transient,
                None,
            )
            .await?;
            return Err(error);
        }
    };
    commit(state, p, &old, identity, "reauthorize", "check", None, None)
        .await
        .map_err(CommitError::api)
}
async fn mark_failure(
    state: &AppState,
    p: Provider,
    old: &Stored,
    code: &str,
    temporary: bool,
    lease: Option<Uuid>,
) -> Result<(), ApiError> {
    sqlx::query("UPDATE cloud_account_settings SET auth_status=$4,last_error_code=$5,next_check_at=now()+interval '5 minutes',refresh_lease=NULL,refresh_lease_until=NULL WHERE provider=$1 AND binding_epoch=$2 AND token_revision=$3 AND ($6::uuid IS NULL OR refresh_lease=$6)")
        .bind(p.name()).bind(old.binding_epoch).bind(old.token_revision).bind(if temporary{"degraded"}else{"reauthorization_required"}).bind(code).bind(lease).execute(&state.pool).await?;
    Ok(())
}
/// Called before cloud operations. A refresh is serialized across all processes;
/// a timed-out rotation is not replayed blindly with the old refresh token.
pub async fn credentials(state: &AppState, p: Provider) -> Result<Option<Stored>, ApiError> {
    let Some(old) = stored(state, p).await? else {
        return Ok(None);
    };
    if !old.configured() {
        return Ok(None);
    }
    if old.auth_status == "reauthorization_required" {
        return Err(AuthFailure::Reauthorize.api());
    }
    if old.pending_refresh_credential.is_some() || old.refresh_started_at.is_some() {
        maintain(state, p).await?;
        let fresh = stored(state, p).await?.unwrap();
        if fresh.auth_status == "reauthorization_required" {
            return Err(AuthFailure::Reauthorize.api());
        }
        if fresh.pending_refresh_credential.is_some() || fresh.refresh_started_at.is_some() {
            return Err(ApiError::Unavailable(
                "网盘凭证正在更新或验证，请稍后重试".into(),
            ));
        }
        return Ok(Some(fresh));
    }
    if old.refreshable
        && old
            .expires_at
            .is_some_and(|t| t <= Utc::now() + Duration::minutes(3))
    {
        maintain(state, p).await?;
        let fresh = stored(state, p).await?.unwrap();
        if fresh.auth_status == "reauthorization_required" {
            return Err(AuthFailure::Reauthorize.api());
        }
        if fresh
            .expires_at
            .is_some_and(|t| t <= Utc::now() + Duration::seconds(30))
        {
            return Err(ApiError::Unavailable("网盘凭证正在更新，请稍后重试".into()));
        }
        return Ok(Some(fresh));
    }
    Ok(Some(old))
}
async fn maintain(state: &AppState, p: Provider) -> Result<(), ApiError> {
    let token = Uuid::new_v4();
    let row=sqlx::query_as::<_,Stored>("UPDATE cloud_account_settings SET refresh_lease=$2,refresh_lease_until=now()+interval '180 seconds' WHERE provider=$1 AND credential<>'' AND auth_status IN('ready','degraded','reauthorization_required') AND (next_check_at<=now() OR pending_refresh_credential IS NOT NULL OR refresh_started_at IS NOT NULL) AND (refresh_lease IS NULL OR refresh_lease_until<now()) RETURNING *").bind(p.name()).bind(token).fetch_optional(&state.pool).await?;
    let Some(old) = row else { return Ok(()) };
    if old.refresh_started_at.is_some() && old.pending_refresh_credential.is_none() {
        mark_failure(state, p, &old, "refresh_uncertain", false, Some(token)).await?;
        return Ok(());
    }
    let pending = old.pending_refresh_credential.is_some();
    let raw = old
        .pending_refresh_credential
        .clone()
        .unwrap_or_else(|| old.credential.clone());
    if old.refreshable && !pending {
        sqlx::query("UPDATE cloud_account_settings SET refresh_started_at=now() WHERE provider=$1 AND refresh_lease=$2").bind(p.name()).bind(token).execute(&state.pool).await?;
    }
    let result = if old.refreshable && !pending {
        providers::refresh(state, p, &raw).await
    } else {
        Ok(raw)
    };
    match result {
        Ok(raw) => {
            if old.refreshable && !pending {
                let staged=sqlx::query("UPDATE cloud_account_settings SET pending_refresh_credential=$3,refresh_started_at=NULL WHERE provider=$1 AND refresh_lease=$2 AND token_revision=$4 AND binding_epoch=$5").bind(p.name()).bind(token).bind(&raw).bind(old.token_revision).bind(old.binding_epoch).execute(&state.pool).await?.rows_affected();
                if staged == 0 {
                    return Ok(());
                }
            }
            match verify(state, p, &raw).await {
                Ok(identity) => {
                    // Persist refreshed tokens before relying on their old value again.
                    // A failed commit after rotation requires a new authorization.
                    if let Err(e) = commit(
                        state,
                        p,
                        &old,
                        identity,
                        "reauthorize",
                        "maintenance",
                        None,
                        Some(token),
                    )
                    .await
                    {
                        let e = e.api();
                        let temporary =
                            matches!(e, ApiError::Unavailable(_) | ApiError::Internal(_));
                        mark_failure(
                            state,
                            p,
                            &old,
                            "refresh_commit_failed",
                            temporary,
                            Some(token),
                        )
                        .await?;
                        return Err(e);
                    }
                }
                Err(e) => {
                    let temporary = matches!(
                        e,
                        ApiError::Upstream(_)
                            | ApiError::Unavailable(_)
                            | ApiError::TooManyRequests(_)
                    );
                    mark_failure(
                        state,
                        p,
                        &old,
                        "verification_failed",
                        temporary,
                        Some(token),
                    )
                    .await?;
                    return Err(e);
                }
            }
        }
        Err(error) => {
            let temporary = matches!(
                error,
                AuthFailure::RateLimited | AuthFailure::RateLimitedAfter(_)
            ) || !old.refreshable
                && matches!(error, AuthFailure::Network | AuthFailure::Protocol);
            if temporary {
                sqlx::query("UPDATE cloud_account_settings SET refresh_started_at=NULL WHERE provider=$1 AND refresh_lease=$2").bind(p.name()).bind(token).execute(&state.pool).await?;
            }
            mark_failure(
                state,
                p,
                &old,
                if old.refreshable && matches!(error, AuthFailure::Network) {
                    "refresh_uncertain"
                } else {
                    error.code()
                },
                temporary,
                Some(token),
            )
            .await?;
            if p == Provider::Xunlei
                && let AuthFailure::RateLimitedAfter(seconds) = error
            {
                sqlx::query("UPDATE cloud_account_settings SET next_check_at=GREATEST(next_check_at,now()+make_interval(secs=>$4)) WHERE provider=$1 AND binding_epoch=$2 AND token_revision=$3 AND last_error_code='rate_limited'")
                        .bind(p.name()).bind(old.binding_epoch).bind(old.token_revision).bind(seconds as f64).execute(&state.pool).await?;
            }
        }
    }
    Ok(())
}

pub async fn start_login(
    state: &AppState,
    p: Provider,
    actor: i64,
    intent: &str,
    epoch: i64,
) -> Result<Value, ApiError> {
    validate_intent(intent)?;
    if !providers::qr_supported(state, p).await? {
        return Err(AuthFailure::Unsupported.api());
    }
    ensure_row(state, p).await?;
    let id = Uuid::new_v4();
    let mut tx = state.pool.begin().await?;
    let current = sqlx::query_scalar::<_, i64>(
        "SELECT binding_epoch FROM cloud_account_settings WHERE provider=$1 FOR UPDATE",
    )
    .bind(p.name())
    .fetch_one(&mut *tx)
    .await?;
    if p == Provider::Xunlei {
        let enabled: bool = sqlx::query_scalar(
            "SELECT qr_enabled FROM cloud_account_settings WHERE provider='xunlei'",
        )
        .fetch_one(&mut *tx)
        .await?;
        if !enabled {
            return Err(AuthFailure::Unsupported.api());
        }
    }
    if current != epoch {
        return Err(ApiError::Conflict("账号状态已变化，请刷新后重试".into()));
    }
    // Rate limit per provider: retrying one platform (expired QR, wrong app
    // scanned) must not lock the admin out of the other four.
    let recent=sqlx::query_scalar::<_,i64>("SELECT count(*) FROM cloud_login_sessions WHERE actor_id=$1 AND provider=$2 AND created_at>now()-interval '1 minute'").bind(actor).bind(p.name()).fetch_one(&mut *tx).await?;
    if recent >= 6 {
        return Err(ApiError::TooManyRequests(
            "扫码创建过于频繁，请稍后再试".into(),
        ));
    }
    sqlx::query("UPDATE cloud_login_sessions SET status='cancelled',context_json=NULL,qr_image=NULL,poll_lease=NULL,poll_lease_until=NULL WHERE provider=$1 AND status IN('starting','waiting','scanned','verifying')").bind(p.name()).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO cloud_login_sessions(id,actor_id,provider,intent,expected_epoch,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '60 seconds')").bind(id).bind(actor).bind(p.name()).bind(intent).bind(epoch).execute(&mut *tx).await?;
    tx.commit().await?;
    let started = async {
        let login = providers::start(state, p).await.map_err(AuthFailure::api)?;
        let image = providers::qr_image(state, p, &login.qr_url)
            .await
            .map_err(AuthFailure::api)?;
        let context_json =
            serde_json::to_string(&login.context).map_err(|_| AuthFailure::Protocol.api())?;
        sqlx::query("UPDATE cloud_login_sessions SET status='waiting',context_json=$2,qr_image=$3,expires_at=$4,interval_seconds=$5,next_poll_at=now()+make_interval(secs=>$6),updated_at=now() WHERE id=$1 AND status='starting'")
            .bind(id).bind(context_json).bind(image).bind(Utc::now()+Duration::seconds(login.expires)).bind(login.interval as i32).bind(if p==Provider::Xunlei {login.interval as f64}else{0.0}).execute(&state.pool).await?;
        Ok::<_, ApiError>(())
    };
    let started = tokio::time::timeout(std::time::Duration::from_secs(35), started)
        .await
        .unwrap_or_else(|_| Err(ApiError::Upstream("二维码生成超时，请稍后重试".into())));
    if let Err(e) = started {
        sqlx::query("UPDATE cloud_login_sessions SET status='failed',error_code='qr_start_failed',context_json=NULL,qr_image=NULL WHERE id=$1 AND status='starting'").bind(id).execute(&state.pool).await?;
        return Err(e);
    }
    session(state, p, id, actor).await
}
pub async fn session(
    state: &AppState,
    p: Provider,
    id: Uuid,
    actor: i64,
) -> Result<Value, ApiError> {
    let r=sqlx::query("SELECT id,status,qr_image,expires_at,error_code,interval_seconds FROM cloud_login_sessions WHERE id=$1 AND provider=$2 AND actor_id=$3").bind(id).bind(p.name()).bind(actor).fetch_optional(&state.pool).await?.ok_or_else(||ApiError::NotFound("扫码会话不存在或不属于当前管理员".into()))?;
    let expires = r.get::<DateTime<Utc>, _>("expires_at");
    let mut status = r.get::<String, _>("status");
    if expires <= Utc::now()
        && matches!(
            status.as_str(),
            "starting" | "waiting" | "scanned" | "verifying"
        )
    {
        status = "expired".into();
    }
    Ok(
        json!({"id":id,"provider":p,"status":status,"qrImage":if matches!(status.as_str(),"waiting"|"scanned"){r.get::<Option<String>,_>("qr_image")}else{None},"expiresAt":expires,"errorCode":r.get::<Option<String>,_>("error_code"),"intervalSeconds":r.get::<i32,_>("interval_seconds")}),
    )
}
pub async fn cancel(state: &AppState, p: Provider, id: Uuid, actor: i64) -> Result<(), ApiError> {
    sqlx::query("UPDATE cloud_login_sessions SET status='cancelled',context_json=NULL,qr_image=NULL,poll_lease=NULL,poll_lease_until=NULL WHERE id=$1 AND provider=$2 AND actor_id=$3 AND status IN('starting','waiting','scanned','verifying')").bind(id).bind(p.name()).bind(actor).execute(&state.pool).await?;
    Ok(())
}
#[cfg(test)]
async fn poll_once(state: &AppState) -> Result<(), ApiError> {
    poll_provider_once(state, None).await
}
async fn login_session_active(state: &AppState, id: Uuid, lease: Uuid) -> Result<bool, ApiError> {
    if state.shutdown.is_cancelled() {
        return Ok(false);
    }
    Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM cloud_login_sessions WHERE id=$1 AND poll_lease=$2 AND poll_lease_until>now() AND expires_at>now() AND status='verifying')").bind(id).bind(lease).fetch_one(&state.pool).await?)
}
async fn poll_provider_once(state: &AppState, provider: Option<Provider>) -> Result<(), ApiError> {
    sqlx::query("UPDATE cloud_login_sessions SET status='expired',context_json=NULL,qr_image=NULL,poll_lease=NULL,poll_lease_until=NULL WHERE expires_at<=now() AND status IN('starting','waiting','scanned','verifying')").execute(&state.pool).await?;
    if provider == Some(Provider::Xunlei) && !qr_settings::enabled(state).await? {
        sqlx::query("UPDATE cloud_login_sessions SET status='cancelled',context_json=NULL,qr_image=NULL,poll_lease=NULL,poll_lease_until=NULL WHERE provider='xunlei' AND status IN('starting','waiting','scanned','verifying') AND NOT EXISTS(SELECT 1 FROM cloud_account_settings WHERE provider='xunlei' AND qr_enabled)").execute(&state.pool).await?;
        return Ok(());
    }
    let lease = Uuid::new_v4();
    let Some(row)=sqlx::query("UPDATE cloud_login_sessions SET poll_lease=$1,poll_lease_until=now()+interval '90 seconds' WHERE id=(SELECT id FROM cloud_login_sessions WHERE ($2::text IS NULL OR provider=$2) AND status IN('waiting','scanned','verifying') AND next_poll_at<=now() AND expires_at>now() AND (poll_lease IS NULL OR poll_lease_until<now()) ORDER BY next_poll_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *").bind(lease).bind(provider.map(Provider::name)).fetch_optional(&state.pool).await? else{return Ok(())};
    let p = Provider::from_name(&row.get::<String, _>("provider"))?;
    let id = row.get::<Uuid, _>("id");
    let mut stage = "session_context";
    let mut auth_failure = None;
    let outcome=async {
        let mut context:providers::Context=serde_json::from_str(&row.get::<String,_>("context_json")).map_err(|_|AuthFailure::Protocol.api())?;
        let verifying=row.get::<String,_>("status")=="verifying";
        stage="token_exchange";
        if p == Provider::Xunlei && !verifying {
            if !providers::qr_supported(state, p).await? { auth_failure=Some(AuthFailure::Unsupported);return Err(AuthFailure::Unsupported.api()); }
            providers::xunlei::begin_exchange(&mut context).map_err(|failure| {auth_failure=Some(failure);failure.api()})?;
            // Fenced intent is durable before the one-use ticket is sent. If this
            // process dies before the response is saved, recovery requires a new QR.
            let saved = sqlx::query("UPDATE cloud_login_sessions SET context_json=$3,updated_at=now() WHERE id=$1 AND poll_lease=$2 AND poll_lease_until>now() AND expires_at>now() AND status IN('waiting','scanned')")
                .bind(id).bind(lease).bind(serde_json::to_string(&context).map_err(|_|AuthFailure::Protocol.api())?).execute(&state.pool).await?.rows_affected();
            if saved == 0 { return Ok(()); }
        }
        let mut next_delay: Option<i64> = None;
        let mut next_interval: Option<i32> = None;
        let polled=if verifying {providers::Poll::Ready(cloud_drive::scalar(&context.data["pending_credential"]))}else{providers::poll(state,p,&mut context).await.map_err(|failure|{auth_failure=Some(failure);failure.api()})?};
        let(status,error)=match polled {
            providers::Poll::Ready(raw)=>{
                // Store the exchange result before validation; a network retry must
                // not exchange a one-use QR ticket again.
                context.data=json!({"pending_credential":raw});
                let context_json=serde_json::to_string(&context).map_err(|_|AuthFailure::Protocol.api())?;
                let updated=sqlx::query("UPDATE cloud_login_sessions SET status='verifying',context_json=$3,qr_image=NULL,expires_at=CASE WHEN status='verifying' THEN expires_at ELSE GREATEST(expires_at,now()+interval '120 seconds') END,updated_at=now() WHERE id=$1 AND poll_lease=$2 AND poll_lease_until>now() AND expires_at>now() AND status IN('waiting','scanned','verifying')").bind(id).bind(lease).bind(context_json).execute(&state.pool).await?.rows_affected();
                if updated==0{return Ok(())}
                let old=stored(state,p).await?.ok_or_else(||ApiError::Conflict("账号已被修改".into()))?;
                if old.binding_epoch!=row.get::<i64,_>("expected_epoch"){return Err(ApiError::Conflict("账号已被修改".into()));}
                if p==Provider::Xunlei && !login_session_active(state,id,lease).await? {return Ok(());}
                stage="account_identity";
                let mut identity=providers::identity(state,p,&raw).await.map_err(|failure|{auth_failure=Some(failure);failure.api()})?;
                if p==Provider::Xunlei && !login_session_active(state,id,lease).await? {return Ok(());}
                stage="root_access";
                let drive=Drive::from_state(state,p,identity.raw.clone());
                let listed=if p==Provider::Xunlei {
                    tokio::time::timeout(std::time::Duration::from_secs(45),drive.list(p.root())).await.map_err(|_|ApiError::Upstream("迅雷根目录只读验证超时，请稍后重试".into()))?
                } else {drive.list(p.root()).await};
                listed.map_err(|e|{
                    if p==Provider::Xunlei {
                        if e.kind==cloud_drive::ErrorKind::Verification {auth_failure=Some(AuthFailure::Verification);}
                        if e.kind==cloud_drive::ErrorKind::RateLimit {auth_failure=Some(AuthFailure::RateLimitedAfter(e.retry_after_seconds.unwrap_or(10)));}
                    }
                    e.api()
                })?;
                if p==Provider::Xunlei && !login_session_active(state,id,lease).await? {return Ok(());}
                identity.raw=drive.wire.snapshot().await;
                stage="credential_save";
                commit(state,p,&old,identity,&row.get::<String,_>("intent"),"qr",Some((id,lease)),None).await.map_err(|error|match error{
                    // Report the exact reason instead of collapsing every save
                    // failure into a generic conflict code.
                    CommitError::Auth(failure)=>{auth_failure=Some(failure);failure.api()},
                    CommitError::Api(error)=>error,
                })?;
                return Ok(());
            },
            providers::Poll::Expired=>("expired",Some("qr_expired")),providers::Poll::Denied=>("denied",Some("authorization_denied")),
            providers::Poll::Waiting=>("waiting",None),providers::Poll::Scanned=>("scanned",None),
            providers::Poll::Scheduled { scanned, delay, interval }=>{
                next_delay=Some(delay);
                next_interval=Some(interval as i32);
                (if scanned {"scanned"} else {"waiting"},None)
            },
            providers::Poll::Slower=>{sqlx::query("UPDATE cloud_login_sessions SET interval_seconds=LEAST(interval_seconds+5,30) WHERE id=$1 AND poll_lease=$2").bind(id).bind(lease).execute(&state.pool).await?;("waiting",None)},
        };
        let terminal=matches!(status,"expired"|"denied");
        let context_json=if terminal{None}else{Some(serde_json::to_string(&context).map_err(|_|AuthFailure::Protocol.api())?)};
        sqlx::query("UPDATE cloud_login_sessions SET status=$3,error_code=$4,context_json=$5,interval_seconds=COALESCE($8::integer,interval_seconds),qr_image=CASE WHEN $6 THEN NULL ELSE qr_image END,next_poll_at=now()+make_interval(secs=>COALESCE($7::double precision,interval_seconds::double precision)),poll_lease=NULL,poll_lease_until=NULL,updated_at=now() WHERE id=$1 AND poll_lease=$2 AND poll_lease_until>now() AND expires_at>now() AND status IN('waiting','scanned','verifying')").bind(id).bind(lease).bind(status).bind(error).bind(context_json).bind(terminal).bind(next_delay.map(|v|v as f64)).bind(next_interval).execute(&state.pool).await?;
        Ok::<_,ApiError>(())
    }.await;
    if let Err(e) = outcome {
        let (transient, code) = login_failure(stage, auth_failure, &e);
        let delay = match auth_failure {
            Some(AuthFailure::RateLimitedAfter(seconds)) => seconds.max(10),
            _ => 10,
        };
        // Only fixed stage/error codes are logged; never upstream bodies, tokens,
        // user identifiers or QR tickets.
        tracing::warn!(provider=%p.name(),stage,error_code=%code,http_status=e.status().as_u16(),"cloud login step failed");
        sqlx::query("UPDATE cloud_login_sessions SET status=CASE WHEN $3 THEN status ELSE 'failed' END,error_code=$4,context_json=CASE WHEN $3 THEN context_json ELSE NULL END,qr_image=CASE WHEN $3 THEN qr_image ELSE NULL END,next_poll_at=now()+make_interval(secs=>CASE WHEN provider='xunlei' THEN GREATEST(interval_seconds,$5::integer) ELSE 10 END),poll_lease=NULL,poll_lease_until=NULL,updated_at=now() WHERE id=$1 AND poll_lease=$2 AND poll_lease_until>now() AND expires_at>now() AND status IN('waiting','scanned','verifying')")
            .bind(id).bind(lease).bind(transient).bind(code).bind(delay as i32).execute(&state.pool).await?;
    }
    Ok(())
}
fn login_failure(stage: &str, auth: Option<AuthFailure>, error: &ApiError) -> (bool, String) {
    let (retry, reason) = if let Some(failure) = auth {
        (
            matches!(
                failure,
                AuthFailure::Network | AuthFailure::RateLimited | AuthFailure::RateLimitedAfter(_)
            ),
            failure.code(),
        )
    } else {
        match error {
            // A real mismatch arrives through `auth` above, carrying its own code.
            // A bare conflict here means the account row or the scan session moved
            // while the QR was being processed, so it must not be reported as
            // "you scanned another account" — that sends the admin hunting for a
            // button that has nothing to do with the failure.
            ApiError::Conflict(_) => (false, "state_changed"),
            ApiError::CloudAuthRequired(_) => (false, "reauthorization_required"),
            ApiError::Forbidden(_) => (false, "permission_denied"),
            ApiError::TooManyRequests(_) => (true, "rate_limited"),
            ApiError::Upstream(_) | ApiError::Unavailable(_) => (true, "network_error"),
            _ => (false, "verification_failed"),
        }
    };
    (retry, format!("{stage}:{reason}"))
}
pub async fn worker(state: Arc<AppState>) -> Result<(), ApiError> {
    // Independent provider loops: a Baidu long poll must not hold the next
    // Quark/Ali/Guangya poll or credential maintenance behind a join-all batch.
    let polling = futures::future::join_all(Provider::ALL.into_iter().map(|p| {
        let state = state.clone();
        async move {
            loop {
                tokio::select! {
                    _ = state.shutdown.cancelled() => return,
                    result = poll_provider_once(&state, Some(p)) => {
                        if result.is_err() { tracing::warn!(provider=%p.name(), "cloud authentication polling failed; retrying with leases"); }
                    }
                }
                tokio::select! { _ = state.shutdown.cancelled() => return, _ = tokio::time::sleep(std::time::Duration::from_secs(2)) => {} }
            }
        }
    }));
    tokio::select! {
        _ = polling => Ok(()),
        result = maintenance_worker(&state) => result,
    }
}
async fn maintenance_worker(state: &AppState) -> Result<(), ApiError> {
    loop {
        if state.shutdown.is_cancelled() {
            return Ok(());
        }
        let due=sqlx::query_scalar::<_,String>("SELECT provider FROM cloud_account_settings WHERE credential<>'' AND auth_status IN('ready','degraded') AND next_check_at<=now() AND (refresh_lease IS NULL OR refresh_lease_until<now()) ORDER BY next_check_at LIMIT 1").fetch_optional(&state.pool).await?;
        if let Some(provider) = due {
            if let Ok(p) = Provider::from_name(&provider) {
                if let Err(error) = maintain(&state, p).await {
                    // The error is an internal classification (stage + fixed
                    // code), never a credential or upstream payload.
                    tracing::warn!(provider=%p.name(), error=%error, "cloud credential maintenance failed");
                }
            }
        }
        sqlx::query("DELETE FROM cloud_login_sessions WHERE expires_at<now()-interval '1 day' AND status NOT IN('starting','waiting','scanned','verifying')").execute(&state.pool).await?;
        tokio::select! {_ = state.shutdown.cancelled()=>return Ok(()),_ = tokio::time::sleep(std::time::Duration::from_secs(2))=>{}}
    }
}

#[cfg(test)]
mod failure_tests {
    use super::*;
    #[test]
    fn an_unverifiable_stored_credential_is_not_reported_as_an_account_switch() {
        assert_eq!(AuthFailure::AccountMismatch.code(), "account_mismatch");
        assert_eq!(AuthFailure::AccountUnverified.code(), "account_unverified");
        // Both stay a conflict for the client, but they must not share a code:
        // one means "you scanned another account", the other means "the stored
        // credential can no longer be verified, so sameness is unknown".
        for failure in [AuthFailure::AccountMismatch, AuthFailure::AccountUnverified] {
            assert!(matches!(failure.api(), ApiError::Conflict(_)));
        }
        let ApiError::Conflict(message) = CommitError::Auth(AuthFailure::AccountUnverified).api()
        else {
            panic!("expected a conflict");
        };
        assert!(message.contains("更换账号") && message.contains("断开连接"));
        // A plain ApiError passes through untouched.
        assert!(matches!(
            CommitError::Api(ApiError::BadRequest("x".into())).api(),
            ApiError::BadRequest(_)
        ));
    }
}
