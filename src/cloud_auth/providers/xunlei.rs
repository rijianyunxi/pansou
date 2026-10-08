//! Experimental Device Code adapter based on the public official login SDK.
//! No password/captcha bypass, implicit client identity, or automatic SSO fallback.
use super::{AuthFailure, Context, LoginStart, Poll, token_update};
use crate::{app::AppState, cloud_drive::Provider};
use chrono::{DateTime, Utc};
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use url::Url;

const ORIGIN: &str = "https://xluser-ssl.xunlei.com";
const MAX_BODY: usize = 1024 * 1024;
const MAX_CONFIG: u64 = 64 * 1024;
const FLOW: &str = "xunlei_device_code_v1";

/// Intentionally not Debug: this configuration includes captcha and optional secret.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Config {
    pub client_id: String,
    pub device_id: String,
    pub captcha_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_sign: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui_client_key: Option<String>,
}
impl Config {
    pub(crate) fn from_bytes(bytes: &[u8]) -> Result<Self, AuthFailure> {
        if bytes.len() as u64 > MAX_CONFIG {
            return Err(AuthFailure::ClientConfiguration);
        }
        let config: Self =
            serde_json::from_slice(bytes).map_err(|_| AuthFailure::ClientConfiguration)?;
        config.validate()?;
        Ok(config)
    }
    fn validate(&self) -> Result<(), AuthFailure> {
        for (value, limit) in [
            (&self.client_id, 256),
            (&self.device_id, 256),
            (&self.captcha_token, 16384),
        ] {
            if !safe_value(value, limit) {
                return Err(AuthFailure::ClientConfiguration);
            }
        }
        for value in [
            &self.client_secret,
            &self.signature,
            &self.device_sign,
            &self.ui_client_key,
        ]
        .into_iter()
        .flatten()
        {
            if !safe_value(value, 4096) {
                return Err(AuthFailure::ClientConfiguration);
            }
        }
        Ok(())
    }
    fn credential(&self) -> Value {
        let mut value = serde_json::to_value(self).expect("string-only config");
        value.as_object_mut().unwrap().remove("ui_client_key");
        value["auth_flow"] = json!(FLOW);
        value
    }
}
pub(super) fn safe_value(value: &str, limit: usize) -> bool {
    !value.is_empty() && value.len() <= limit && value.bytes().all(|c| (0x21..=0x7e).contains(&c))
}

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Phase {
    Awaiting,
    Exchanging,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Session {
    schema_version: u8,
    config: Config,
    device_code: String,
    initial_interval: i64,
    current_interval: i64,
    scanned: bool,
    phase: Phase,
}
impl Session {
    fn parse(context: &Context) -> Result<Self, AuthFailure> {
        let session: Self =
            serde_json::from_value(context.data.clone()).map_err(|_| AuthFailure::Protocol)?;
        session.config.validate()?;
        if session.schema_version != 1
            || !safe_value(&session.device_code, 4096)
            || !(1..=3600).contains(&session.initial_interval)
            || !(session.initial_interval..=i32::MAX as i64).contains(&session.current_interval)
        {
            return Err(AuthFailure::Protocol);
        }
        Ok(session)
    }
    fn save(&self, context: &mut Context) {
        context.data = serde_json::to_value(self).expect("string-only session");
    }
    fn scheduled(&mut self, delay: i64, context: &mut Context) -> Poll {
        self.phase = Phase::Awaiting;
        self.save(context);
        Poll::Scheduled {
            scanned: self.scanned,
            delay: delay.max(self.current_interval),
            interval: self.current_interval,
        }
    }
}

/// Persist this transition under the DB lease before making the HTTP request.
/// A recovered Exchanging session is deliberately not replayed.
pub(crate) fn begin_exchange(context: &mut Context) -> Result<(), AuthFailure> {
    let mut session = Session::parse(context)?;
    if session.phase == Phase::Exchanging {
        return Err(AuthFailure::ExchangeUncertain);
    }
    session.phase = Phase::Exchanging;
    session.save(context);
    Ok(())
}

struct Reply {
    status: StatusCode,
    retry_after: Option<i64>,
    body: Value,
}
pub(crate) fn retry_after(raw: Option<&str>, now: DateTime<Utc>) -> Option<i64> {
    let raw = raw?.trim();
    if let Ok(seconds) = raw.parse::<u64>() {
        // Longer than any supported QR lifetime; clamping cannot advance a poll
        // within a live session, and keeps PostgreSQL interval_seconds in range.
        return Some(seconds.min(i32::MAX as u64) as i64);
    }
    DateTime::parse_from_rfc2822(raw).ok().map(|date| {
        (date.with_timezone(&Utc) - now)
            .num_seconds()
            .clamp(0, i32::MAX as i64 - 1)
            + 1
    })
}
async fn request(
    client: &Client,
    target: Url,
    config: &Config,
    body: Value,
    exchange: bool,
) -> Result<Reply, AuthFailure> {
    config.validate()?;
    let headers =
        crate::cloud_drive::extended_headers(Provider::Xunlei, &config.credential().to_string())
            .map_err(|_| AuthFailure::ClientConfiguration)?;
    let mut response = client.post(target).headers(headers)
        .header("User-Agent","Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36")
        .header("Referer","https://pan.xunlei.com/")
        .timeout(std::time::Duration::from_secs(12)).json(&body).send().await
        .map_err(|_|if exchange {AuthFailure::ExchangeUncertain}else{AuthFailure::Network})?;
    let status = response.status();
    let retry = retry_after(
        response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok()),
        Utc::now(),
    );
    if status == StatusCode::TOO_MANY_REQUESTS {
        return Ok(Reply {
            status,
            retry_after: retry,
            body: Value::Null,
        });
    }
    if status.is_server_error() {
        return Err(if exchange {
            AuthFailure::ExchangeUncertain
        } else {
            AuthFailure::Network
        });
    }
    // This adapter never follows a redirect or changes auth hosts.
    if status.is_redirection() {
        return Err(AuthFailure::Protocol);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| {
        if exchange {
            AuthFailure::ExchangeUncertain
        } else {
            AuthFailure::Network
        }
    })? {
        if bytes.len() + chunk.len() > MAX_BODY {
            return Err(if exchange {
                AuthFailure::ExchangeUncertain
            } else {
                AuthFailure::Protocol
            });
        }
        bytes.extend_from_slice(&chunk);
    }
    let body: Value = serde_json::from_slice(&bytes).map_err(|_| {
        if exchange {
            AuthFailure::ExchangeUncertain
        } else {
            AuthFailure::Protocol
        }
    })?;
    if !body.is_object() {
        return Err(if exchange {
            AuthFailure::ExchangeUncertain
        } else {
            AuthFailure::Protocol
        });
    }
    Ok(Reply {
        status,
        retry_after: retry,
        body,
    })
}
fn target(state: &AppState, path: &str) -> Result<Url, AuthFailure> {
    let official = Url::parse(&format!("{ORIGIN}{path}")).map_err(|_| AuthFailure::Protocol)?;
    #[cfg(test)]
    if let Some(base) = &state.cloud_auth_test_base {
        return Url::parse(base)
            .and_then(|base| base.join(&format!("xluser-ssl.xunlei.com{path}")))
            .map_err(|_| AuthFailure::Protocol);
    }
    let _ = state;
    Ok(official)
}
fn number(body: &Value, key: &str, min: i64, max: i64) -> Result<i64, AuthFailure> {
    body[key]
        .as_i64()
        .filter(|v| (min..=max).contains(v))
        .ok_or(AuthFailure::Protocol)
}
fn qr_url(raw: &str) -> Result<String, AuthFailure> {
    if raw.len() > 8192 {
        return Err(AuthFailure::Protocol);
    }
    let source = Url::parse(raw).map_err(|_| AuthFailure::Protocol)?;
    if source.scheme() != "https"
        || !source.username().is_empty()
        || source.password().is_some()
        || source.port().is_some_and(|port| port != 443)
        || source.fragment().is_some()
        || !matches!(
            source.host_str(),
            Some("i.xunlei.com" | "xluser-ssl.xunlei.com")
        )
        || !matches!(source.path(), "/device" | "/device/")
        || source.query().is_none_or(str::is_empty)
    {
        return Err(AuthFailure::Protocol);
    }
    if source
        .query_pairs()
        .any(|(key, _)| matches!(key.as_ref(), "redirect_uri" | "redirect" | "url"))
    {
        return Err(AuthFailure::Protocol);
    }
    let mut device = Url::parse("https://i.xunlei.com/device/").unwrap();
    device.set_query(source.query());
    let mut qr = Url::parse("https://xluser-ssl.xunlei.com/xluser.core.login/v3/qrlogin").unwrap();
    qr.query_pairs_mut()
        .append_pair("redirect_uri", device.as_str());
    Ok(qr.into())
}
fn start_response(config: Config, reply: Reply) -> Result<LoginStart, AuthFailure> {
    if reply.status == StatusCode::TOO_MANY_REQUESTS {
        return Err(AuthFailure::RateLimited);
    }
    if !reply.status.is_success() || reply.body.get("error").is_some() {
        return Err(classify_error(&reply.body));
    }
    let expires = number(&reply.body, "expires_in", 1, 3600)?;
    let interval = number(&reply.body, "interval", 1, expires)?;
    let code = reply.body["device_code"]
        .as_str()
        .filter(|s| safe_value(s, 4096))
        .ok_or(AuthFailure::Protocol)?;
    let url = qr_url(
        reply.body["verification_uri_complete"]
            .as_str()
            .ok_or(AuthFailure::Protocol)?,
    )?;
    let session = Session {
        schema_version: 1,
        config,
        device_code: code.to_owned(),
        initial_interval: interval,
        current_interval: interval,
        scanned: false,
        phase: Phase::Awaiting,
    };
    let mut context = Context::default();
    session.save(&mut context);
    Ok(LoginStart {
        context,
        qr_url: url,
        expires,
        interval,
    })
}
fn classify_error(body: &Value) -> AuthFailure {
    match body["error"].as_str().unwrap_or("") {
        "captcha_invalid" | "captcha_required" | "verification_required" => {
            AuthFailure::Verification
        }
        "invalid_client" | "unauthorized_client" => AuthFailure::ClientConfiguration,
        "invalid_grant" => AuthFailure::Reauthorize,
        _ => AuthFailure::Protocol,
    }
}
fn poll_response(context: &mut Context, reply: Reply) -> Result<Poll, AuthFailure> {
    let mut session = Session::parse(context)?;
    if session.phase != Phase::Exchanging {
        return Err(AuthFailure::Protocol);
    }
    if reply.status == StatusCode::TOO_MANY_REQUESTS {
        session.current_interval = session
            .current_interval
            .saturating_mul(2)
            .max(10)
            .min(i32::MAX as i64);
        let delay = reply
            .retry_after
            .unwrap_or(0)
            .max(session.current_interval)
            .saturating_add(rand::random_range(0..=3))
            .min(i32::MAX as i64);
        return Ok(session.scheduled(delay, context));
    }
    match reply.body["error"].as_str() {
        Some("authorization_pending") => {
            if reply.body["details"]
                .as_array()
                .is_some_and(|details| details.iter().any(|v| v["state"] == "WAITING_CONSENT"))
            {
                session.scanned = true;
            }
            Ok(session.scheduled(reply.retry_after.unwrap_or(0), context))
        }
        Some("slow_down") => {
            session.current_interval = (session.current_interval + 5)
                .max(session.initial_interval * 2)
                .min(i32::MAX as i64);
            Ok(session.scheduled(reply.retry_after.unwrap_or(0), context))
        }
        Some("expired_token") => Ok(Poll::Expired),
        Some("access_denied") => Ok(Poll::Denied),
        Some(_) => Err(classify_error(&reply.body)),
        None => {
            if !reply.status.is_success() {
                return Err(AuthFailure::Protocol);
            }
            if reply.body["access_token"]
                .as_str()
                .is_none_or(|v| !safe_value(v, 16384))
            {
                return Err(AuthFailure::Protocol);
            }
            for (key, expected) in [
                ("client_id", session.config.client_id.as_str()),
                ("device_id", session.config.device_id.as_str()),
            ] {
                if reply
                    .body
                    .get(key)
                    .is_some_and(|v| v.as_str() != Some(expected))
                {
                    return Err(AuthFailure::ClientConfiguration);
                }
            }
            if reply
                .body
                .get("refresh_token")
                .is_some_and(|v| v.as_str().is_none_or(|v| !safe_value(v, 16384)))
            {
                return Err(AuthFailure::Protocol);
            }
            if reply
                .body
                .get("token_type")
                .is_some_and(|v| v.as_str().is_none_or(|v| !v.eq_ignore_ascii_case("bearer")))
            {
                return Err(AuthFailure::Protocol);
            }
            let credential = token_update(&session.config.credential(), &reply.body)?;
            // Identity and root access still gate the actual binding commit.
            Ok(Poll::Ready(credential.to_string()))
        }
    }
}
pub(super) async fn start(state: &AppState) -> Result<LoginStart, AuthFailure> {
    let config = super::super::qr_settings::config(state)
        .await?
        .ok_or(AuthFailure::Unsupported)?;
    config.validate()?;
    let mut body = json!({"client_id":config.client_id,"scope":""});
    if let Some(key) = &config.ui_client_key {
        body["meta"] = json!({"ui_client_key":key});
    }
    let reply = request(
        &state.cloud_http,
        target(state, "/v1/auth/device/code")?,
        &config,
        body,
        false,
    )
    .await?;
    start_response(config, reply)
}
pub(super) async fn poll(state: &AppState, context: &mut Context) -> Result<Poll, AuthFailure> {
    if !super::super::qr_settings::enabled(state)
        .await
        .map_err(|_| AuthFailure::Network)?
    {
        return Err(AuthFailure::Unsupported);
    }
    let session = Session::parse(context)?;
    if session.phase != Phase::Exchanging {
        return Err(AuthFailure::Protocol);
    }
    let mut body = json!({"client_id":session.config.client_id,"device_code":session.device_code,"grant_type":"urn:ietf:params:oauth:grant-type:device_code"});
    if let Some(secret) = &session.config.client_secret {
        body["client_secret"] = json!(secret);
    }
    let reply = request(
        &state.cloud_http,
        target(state, "/v1/auth/token")?,
        &session.config,
        body,
        true,
    )
    .await?;
    poll_response(context, reply)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Config {
        serde_json::from_value(json!({"client_id":"fixture-client","device_id":"fixture-device","captcha_token":"fixture-captcha"})).unwrap()
    }
    fn reply(status: u16, body: Value) -> Reply {
        Reply {
            status: StatusCode::from_u16(status).unwrap(),
            retry_after: None,
            body,
        }
    }
    fn start() -> LoginStart {
        start_response(config(),reply(200,json!({"device_code":"fixture-code","interval":3,"expires_in":300,"verification_uri_complete":"https://i.xunlei.com/device/?device_code=fixture-code&client_id=fixture-client"}))).unwrap()
    }
    fn exchange(context: &mut Context, reply: Reply) -> Result<Poll, AuthFailure> {
        begin_exchange(context)?;
        poll_response(context, reply)
    }
    #[test]
    fn config_rejects_missing_fields_aliases_urls_and_header_injection() {
        for value in [
            json!({}),
            json!({"client_id":"c","device_id":"d","captcha_token":"t","base_url":"https://evil.test"}),
            json!({"client_id":"c","device_id":"d","captcha_token":"t","access_token":"t"}),
        ] {
            assert!(serde_json::from_value::<Config>(value).is_err());
        }
        let mut c = config();
        c.device_id = "x\r\nAuthorization: other".into();
        assert!(c.validate().is_err());
        let mut c = config();
        c.client_id.clear();
        assert!(c.validate().is_err());
        let c = config();
        assert!(c.credential().get("ui_client_key").is_none());
    }
    #[test]
    fn config_context_is_bounded_and_errors_never_contain_input() {
        let good = serde_json::to_vec(&config()).unwrap();
        assert!(Config::from_bytes(&good).is_ok());
        let secret = "NEVER_PRINT_CAPTCHA_OR_SECRET";
        for bytes in [
            secret.as_bytes().to_vec(),
            vec![b' '; MAX_CONFIG as usize + 1],
            br#"{"client_id":"c","device_id":"d","captcha_token":"x\r\nInjected"}"#.to_vec(),
        ] {
            let failure = match Config::from_bytes(&bytes) {
                Err(e) => e,
                Ok(_) => panic!("invalid config accepted"),
            };
            assert!(!failure.api().to_string().contains(secret));
        }
    }
    #[test]
    fn qr_rotation_never_changes_clients_or_discards_same_device_context() {
        let previous = json!({"auth_flow":FLOW,"client_id":"fixture-client","device_id":"fixture-device","access_token":"old","refresh_token":"old-refresh","captcha_token":"fixture-captcha"});
        let rotated = token_update(
            &previous,
            &json!({"access_token":"new","refresh_token":"new-refresh","expires_in":300}),
        )
        .unwrap();
        assert_eq!(rotated["refresh_token"], "new-refresh");
        assert_eq!(rotated["captcha_token"], "fixture-captcha");
        assert_eq!(rotated["device_id"], "fixture-device");
        let without_refresh =
            token_update(&rotated, &json!({"access_token":"newest","expires_in":300})).unwrap();
        assert_eq!(without_refresh["refresh_token"], "new-refresh");
        for (field, value) in [
            ("client_id", json!("other")),
            ("device_id", json!("other")),
            ("access_token", json!(123)),
            ("refresh_token", json!(123)),
        ] {
            let mut response = json!({"access_token":"new"});
            response[field] = value;
            assert!(token_update(&previous, &response).is_err());
        }
    }
    #[test]
    fn qr_wrapper_is_official_and_rejects_redirects_and_lookalikes() {
        let qr = Url::parse(&start().qr_url).unwrap();
        assert_eq!(qr.host_str(), Some("xluser-ssl.xunlei.com"));
        let redirect = qr.query_pairs().next().unwrap().1.to_string();
        assert_eq!(
            redirect,
            "https://i.xunlei.com/device/?device_code=fixture-code&client_id=fixture-client"
        );
        for raw in [
            "http://i.xunlei.com/device/?x=y",
            "https://evil.xunlei.com/device/?x=y",
            "https://i.xunlei.com.evil.test/device/?x=y",
            "https://u:p@i.xunlei.com/device/?x=y",
            "https://i.xunlei.com:444/device/?x=y",
            "https://i.xunlei.com/device/?redirect_uri=https%3A%2F%2Fevil.test",
            "https://i.xunlei.com/device/",
            "https://i.xunlei.com/device/?x=y#fragment",
            "https://i.xunlei.com/other?x=y",
        ] {
            assert!(qr_url(raw).is_err(), "{raw}");
        }
    }
    #[test]
    fn create_requires_typed_lifetime_interval_and_code() {
        let good = json!({"device_code":"fixture","interval":3,"expires_in":300,"verification_uri_complete":"https://i.xunlei.com/device/?x=y"});
        for (field, value) in [
            ("interval", json!(0)),
            ("interval", json!(301)),
            ("interval", json!("3")),
            ("expires_in", json!(86400)),
            ("device_code", json!("")),
            ("device_code", json!(5)),
        ] {
            let mut body = good.clone();
            body[field] = value;
            assert!(start_response(config(), reply(200, body)).is_err());
        }
        assert!(matches!(
            start_response(config(), reply(429, Value::Null)),
            Err(AuthFailure::RateLimited)
        ));
        assert!(matches!(
            start_response(config(), reply(400, json!({"error":"captcha_invalid"}))),
            Err(AuthFailure::Verification)
        ));
    }
    #[test]
    fn scanned_stays_scanned_and_slow_down_never_shortens_delay() {
        let mut context = start().context;
        let result = exchange(
            &mut context,
            reply(
                400,
                json!({"error":"authorization_pending","details":[{"state":"WAITING_CONSENT"}]}),
            ),
        )
        .unwrap();
        assert!(matches!(
            result,
            Poll::Scheduled {
                scanned: true,
                delay: 3,
                interval: 3
            }
        ));
        let result = exchange(
            &mut context,
            reply(400, json!({"error":"authorization_pending"})),
        )
        .unwrap();
        assert!(matches!(result, Poll::Scheduled { scanned: true, .. }));
        let result = exchange(&mut context, reply(400, json!({"error":"slow_down"}))).unwrap();
        assert!(matches!(
            result,
            Poll::Scheduled {
                scanned: true,
                delay: 8,
                interval: 8
            }
        ));
        let result = exchange(&mut context, reply(400, json!({"error":"slow_down"}))).unwrap();
        assert!(matches!(
            result,
            Poll::Scheduled {
                delay: 13,
                interval: 13,
                ..
            }
        ));
        let mut limited = reply(429, Value::Null);
        limited.retry_after = Some(120);
        assert!(matches!(
            exchange(&mut context, limited).unwrap(),
            Poll::Scheduled {
                scanned: true,
                delay: 120..=123,
                ..
            }
        ));
    }
    #[test]
    fn uncertain_exchange_is_not_replayed_after_restart() {
        let mut context = start().context;
        begin_exchange(&mut context).unwrap();
        let json = serde_json::to_string(&context).unwrap();
        let mut recovered: Context = serde_json::from_str(&json).unwrap();
        assert!(matches!(
            begin_exchange(&mut recovered),
            Err(AuthFailure::ExchangeUncertain)
        ));
        recovered.data["schema_version"] = json!(2);
        assert!(Session::parse(&recovered).is_err());
    }
    #[test]
    fn terminal_errors_and_token_context_are_strict() {
        for (error, expected) in [("expired_token", "expired"), ("access_denied", "denied")] {
            let result =
                exchange(&mut start().context, reply(400, json!({"error":error}))).unwrap();
            assert!(matches!(
                (result, expected),
                (Poll::Expired, "expired") | (Poll::Denied, "denied")
            ));
        }
        for body in [
            json!({"error":"unknown"}),
            json!({"access_token":"a","client_id":"other"}),
            json!({"access_token":"a","device_id":"other"}),
            json!({"access_token":"a","token_type":"basic"}),
            json!({"access_token":"a","refresh_token":123}),
            json!({"access_token":123}),
        ] {
            assert!(exchange(&mut start().context, reply(200, body)).is_err());
        }
        let Poll::Ready(raw)=exchange(&mut start().context,reply(200,json!({"access_token":"fixture-token","refresh_token":"fixture-refresh","expires_in":300}))).unwrap() else {panic!("expected pending credential");};
        let v: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["client_id"], "fixture-client");
        assert_eq!(v["device_id"], "fixture-device");
        assert_eq!(v["captcha_token"], "fixture-captcha");
        assert_eq!(v["auth_flow"], FLOW);
        assert!(v.get("device_code").is_none());
        assert!(v.get("user_id").is_none());
    }
    #[test]
    fn retry_after_supports_seconds_http_dates_and_invalid_values() {
        let now = DateTime::parse_from_rfc3339("2026-10-08T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(retry_after(Some("120"), now), Some(120));
        assert_eq!(
            retry_after(Some("Thu, 08 Oct 2026 00:02:00 GMT"), now),
            Some(121)
        );
        assert_eq!(retry_after(Some("invalid"), now), None);
        assert_eq!(retry_after(Some("-2"), now), None);
        assert_eq!(retry_after(Some("99999999999"), now), Some(i32::MAX as i64));
    }
    #[tokio::test]
    async fn http_mock_preserves_oauth_4xx_rate_limits_and_safe_headers() {
        use axum::{Router, extract::State, response::IntoResponse, routing::post};
        use std::sync::Arc;
        let bodies = Arc::new(tokio::sync::Mutex::new(Vec::<Value>::new()));
        async fn upstream(
            State(bodies): State<Arc<tokio::sync::Mutex<Vec<Value>>>>,
            headers: axum::http::HeaderMap,
            axum::Json(body): axum::Json<Value>,
        ) -> axum::response::Response {
            assert_eq!(headers["x-client-id"], "fixture-client");
            assert_eq!(headers["x-device-id"], "fixture-device");
            assert_eq!(headers["x-captcha-token"], "fixture-captcha");
            assert!(!headers.contains_key("authorization"));
            let action = body["fixture_action"].as_str().unwrap_or("").to_owned();
            bodies.lock().await.push(body);
            match action.as_str() {
                "limited" => (
                    StatusCode::TOO_MANY_REQUESTS,
                    [("retry-after", "120")],
                    "not-json",
                )
                    .into_response(),
                "failure" => (StatusCode::BAD_GATEWAY, "upstream-secret").into_response(),
                "redirect" => {
                    (StatusCode::FOUND, [("location", "https://evil.test")], "").into_response()
                }
                "malformed" => (StatusCode::OK, "not-json").into_response(),
                "oversized" => (StatusCode::OK, "x".repeat(MAX_BODY + 1)).into_response(),
                _ => (
                    StatusCode::BAD_REQUEST,
                    axum::Json(json!({"error":"authorization_pending"})),
                )
                    .into_response(),
            }
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!("http://{}/token", listener.local_addr().unwrap())).unwrap();
        let router = Router::new()
            .route("/token", post(upstream))
            .with_state(bodies.clone());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let pending=request(&client,url.clone(),&config(),json!({"grant_type":"urn:ietf:params:oauth:grant-type:device_code","device_code":"fixture-code"}),true).await.unwrap();
        assert!(matches!(
            exchange(&mut start().context, pending).unwrap(),
            Poll::Scheduled { .. }
        ));
        let limited = request(
            &client,
            url.clone(),
            &config(),
            json!({"fixture_action":"limited"}),
            true,
        )
        .await
        .unwrap();
        assert_eq!(limited.retry_after, Some(120));
        assert!(matches!(
            request(
                &client,
                url.clone(),
                &config(),
                json!({"fixture_action":"failure"}),
                true
            )
            .await,
            Err(AuthFailure::ExchangeUncertain)
        ));
        assert!(matches!(
            request(
                &client,
                url.clone(),
                &config(),
                json!({"fixture_action":"redirect"}),
                true
            )
            .await,
            Err(AuthFailure::Protocol)
        ));
        assert!(matches!(
            request(
                &client,
                url.clone(),
                &config(),
                json!({"fixture_action":"malformed"}),
                true
            )
            .await,
            Err(AuthFailure::ExchangeUncertain)
        ));
        assert!(matches!(
            request(
                &client,
                url.clone(),
                &config(),
                json!({"fixture_action":"oversized"}),
                true
            )
            .await,
            Err(AuthFailure::ExchangeUncertain)
        ));
        assert_eq!(bodies.lock().await.len(), 6);
        server.abort();
    }
}
