//! Token credential validation and provider request headers.
use super::{Provider, text, valid_id};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::Value;

pub fn validate_credential(provider: Provider, raw: &str) -> Result<(), crate::error::ApiError> {
    if !provider.token_auth() {
        return Ok(());
    }
    let value: Value = serde_json::from_str(raw).map_err(|_| {
        crate::error::ApiError::BadRequest(
            "凭据必须是 JSON，包含 access_token（或 authorization）及设备字段".into(),
        )
    })?;
    if ["base_url", "apiHost", "baseUrl", "headers", "url"]
        .iter()
        .any(|k| value.get(*k).is_some())
    {
        return Err(crate::error::ApiError::BadRequest(
            "不允许配置自定义 API 地址或任意请求头".into(),
        ));
    }
    if !value.is_object()
        || text(&value, &["access_token", "accessToken", "authorization"]).is_empty()
    {
        return Err(crate::error::ApiError::BadRequest(
            "缺少 access_token / authorization，refresh_token 不能直接用于网盘操作".into(),
        ));
    }
    if !valid_id(&text(&value, &["user_id", "userId", "sub"]), false) {
        return Err(crate::error::ApiError::BadRequest(
            "凭据需要 user_id（账号接口返回的 ID），用于更新令牌后仍安全清理同一账号产物".into(),
        ));
    }
    if provider == Provider::Aliyun && !valid_id(&text(&value, &["drive_id", "driveId"]), false) {
        return Err(crate::error::ApiError::BadRequest(
            "阿里云盘凭据还需要 drive_id".into(),
        ));
    }
    if provider == Provider::Xunlei
        && text(
            &value,
            &["captcha_token", "captchaToken", "x-captcha-token"],
        )
        .is_empty()
    {
        return Err(crate::error::ApiError::BadRequest(
            "迅雷凭据还需要 x-captcha-token（网页请求头）".into(),
        ));
    }
    credential_headers(provider, raw)
        .map(|_| ())
        .map_err(|_| crate::error::ApiError::BadRequest("凭据包含无效请求头或控制字符".into()))
}
pub(in crate::cloud_drive) fn credential_headers(
    provider: Provider,
    raw: &str,
) -> Result<HeaderMap, ()> {
    let value: Value = serde_json::from_str(raw).map_err(|_| ())?;
    let mut headers = HeaderMap::new();
    let token = text(&value, &["authorization", "access_token", "accessToken"]);
    if !token.is_empty() {
        let auth = if token.to_ascii_lowercase().starts_with("bearer ") {
            token
        } else {
            format!("Bearer {token}")
        };
        headers.insert(
            "authorization",
            HeaderValue::from_str(&auth).map_err(|_| ())?,
        );
    }
    for (name, aliases, default) in [
        (
            "x-device-id",
            &["x-device-id", "device_id", "deviceId"][..],
            "",
        ),
        (
            "x-client-id",
            &["x-client-id", "client_id", "clientId"][..],
            if provider == Provider::Xunlei {
                "ZUBzD9J_XPXfn7f7"
            } else if provider == Provider::Guangya {
                "aMe-8VSlkrbQXpUR"
            } else {
                ""
            },
        ),
        (
            "x-captcha-token",
            &["x-captcha-token", "captcha_token", "captchaToken"][..],
            "",
        ),
        ("x-signature", &["x-signature", "signature"][..], ""),
        (
            "x-device-sign",
            &["x-device-sign", "device_sign", "deviceSign"][..],
            "",
        ),
        ("did", &["did", "device_id", "deviceId"][..], ""),
        (
            "dt",
            &["dt"][..],
            if provider == Provider::Guangya {
                "4"
            } else {
                ""
            },
        ),
    ] {
        let supplied = text(&value, aliases);
        let supplied = if supplied.is_empty() {
            default.to_string()
        } else {
            supplied
        };
        if !supplied.is_empty() {
            headers.insert(
                HeaderName::from_bytes(name.as_bytes()).map_err(|_| ())?,
                HeaderValue::from_str(&supplied).map_err(|_| ())?,
            );
        }
    }
    if provider == Provider::Aliyun {
        headers.insert(
            "x-canary",
            HeaderValue::from_static("client=web,app=adrive,version=v6.0.0"),
        );
    }
    Ok(headers)
}
pub(crate) fn guangya_auth_headers(raw: &str) -> Result<HeaderMap, ()> {
    let mut headers = credential_headers(Provider::Guangya, raw)?;
    // Match the Windows Chrome 131 UA used by both authentication and storage
    // transports. Account SDK metadata is distinct from business root headers.
    for (name, value) in [
        ("x-client-version", "0.0.1"),
        ("x-device-name", "PC-Chrome"),
        ("x-device-model", "chrome%2F131.0.0.0"),
        ("x-net-work-type", "NONE"),
        ("x-os-version", "Win32"),
        ("x-platform-version", "1"),
        ("x-protocol-version", "301"),
        ("x-provider-name", "NONE"),
        ("x-sdk-version", "9.1.3"),
    ] {
        headers.insert(
            HeaderName::from_static(name),
            HeaderValue::from_static(value),
        );
    }
    Ok(headers)
}
