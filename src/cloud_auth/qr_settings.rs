//! Write-only experimental QR context and live database capability settings.
use super::{AuthFailure, providers::xunlei::Config};
use crate::{app::AppState, cloud_drive::Provider, error::ApiError};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Update {
    pub enabled: bool,
    pub expected_revision: i64,
    #[serde(default, deserialize_with = "provided_context")]
    pub context: Option<Value>,
    #[serde(default)]
    pub clear_context: bool,
}
// Missing means preserve; explicit null is a supplied invalid context, not clear.
fn provided_context<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}
fn provider(p: Provider) -> Result<(), ApiError> {
    if p != Provider::Xunlei {
        return Err(ApiError::BadRequest("此网盘不需要实验扫码设置".into()));
    }
    Ok(())
}
pub async fn enabled(state: &AppState) -> Result<bool, ApiError> {
    Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM cloud_account_settings WHERE provider='xunlei' AND qr_enabled AND qr_context IS NOT NULL)").fetch_one(&state.pool).await?)
}
pub(super) async fn config(state: &AppState) -> Result<Option<Config>, AuthFailure> {
    let raw: Option<Option<String>> = sqlx::query_scalar(
        "SELECT qr_context FROM cloud_account_settings WHERE provider='xunlei' AND qr_enabled",
    )
    .fetch_optional(&state.pool)
    .await
    .map_err(|_| AuthFailure::Network)?;
    raw.flatten()
        .map(|s| Config::from_bytes(s.as_bytes()))
        .transpose()
}
pub async fn get(state: &AppState, p: Provider) -> Result<Value, ApiError> {
    provider(p)?;
    let row=sqlx::query("SELECT qr_enabled,qr_context IS NOT NULL AS configured,qr_revision FROM cloud_account_settings WHERE provider='xunlei'").fetch_optional(&state.pool).await?;
    Ok(match row {
        Some(row) => {
            json!({"enabled":row.get::<bool,_>("qr_enabled"),"configured":row.get::<bool,_>("configured"),"revision":row.get::<i64,_>("qr_revision"),"experimental":true})
        }
        None => json!({"enabled":false,"configured":false,"revision":0,"experimental":true}),
    })
}
fn context(previous: Option<String>, update: &Update) -> Result<Option<String>, ApiError> {
    if update.clear_context && (update.enabled || update.context.is_some()) {
        return Err(ApiError::BadRequest(
            "清除客户端上下文时必须关闭实验扫码，且不能同时提供新上下文".into(),
        ));
    }
    let raw = if update.clear_context {
        None
    } else if let Some(value) = &update.context {
        let raw = value.to_string();
        Config::from_bytes(raw.as_bytes()).map_err(AuthFailure::api)?;
        Some(raw)
    } else {
        previous
    };
    if update.enabled {
        let value = raw.as_ref().ok_or_else(|| {
            ApiError::BadRequest("启用实验扫码前需要保存同一官方客户端的设备与验证上下文".into())
        })?;
        Config::from_bytes(value.as_bytes()).map_err(AuthFailure::api)?;
    }
    Ok(raw)
}
pub async fn update(state: &AppState, p: Provider, input: Update) -> Result<Value, ApiError> {
    provider(p)?;
    if input.expected_revision < 0 {
        return Err(ApiError::BadRequest("设置版本无效".into()));
    }
    super::ensure_row(state, p).await?;
    let mut tx = state.pool.begin().await?;
    let row=sqlx::query("SELECT qr_revision,qr_context FROM cloud_account_settings WHERE provider='xunlei' FOR UPDATE").fetch_one(&mut *tx).await?;
    if row.get::<i64, _>("qr_revision") != input.expected_revision {
        return Err(ApiError::Conflict(
            "扫码设置已被修改，请重新打开设置后再保存".into(),
        ));
    }
    let raw = context(row.get("qr_context"), &input)?;
    sqlx::query("UPDATE cloud_account_settings SET qr_enabled=$1,qr_context=$2,qr_revision=qr_revision+1,updated_at=now() WHERE provider='xunlei'").bind(input.enabled).bind(raw).execute(&mut *tx).await?;
    // Same account-row lock as session creation: a setting change cannot leave
    // an old active session committed with a new client's context.
    sqlx::query("UPDATE cloud_login_sessions SET status='cancelled',context_json=NULL,qr_image=NULL,poll_lease=NULL,poll_lease_until=NULL,updated_at=now() WHERE provider='xunlei' AND status IN('starting','waiting','scanned','verifying')").execute(&mut *tx).await?;
    tx.commit().await?;
    get(state, p).await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserve_replace_and_clear_are_explicit_and_do_not_mix_contexts() {
        let raw=json!({"client_id":"fixture-client","device_id":"fixture-device","captcha_token":"fixture-secret"}).to_string();
        let input = |enabled, clear_context, context| Update {
            enabled,
            expected_revision: 0,
            context,
            clear_context,
        };
        assert_eq!(
            context(Some(raw.clone()), &input(true, false, None)).unwrap(),
            Some(raw.clone())
        );
        assert!(context(None, &input(true, false, None)).is_err());
        assert_eq!(
            context(Some(raw.clone()), &input(false, true, None)).unwrap(),
            None
        );
        assert!(context(Some(raw.clone()), &input(true, true, None)).is_err());
        assert!(context(Some(raw.clone()), &input(false, true, Some(json!({})))).is_err());
        assert!(
            context(
                Some(raw),
                &input(true, false, Some(json!({"captcha_token":"other"})))
            )
            .is_err()
        );
        let null: Update =
            serde_json::from_value(json!({"enabled":false,"expectedRevision":0,"context":null}))
                .unwrap();
        assert!(context(Some("previous".into()), &null).is_err());
        assert!(provider(Provider::Baidu).is_err());
    }
}
