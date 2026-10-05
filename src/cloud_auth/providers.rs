//! Authentication contracts: aligo/core/Auth.py, guangyapan/client.py and official
//! web sessions. Credentials and upstream responses must never be logged.
use super::AuthFailure;
use crate::{
    app::AppState,
    cloud_drive::{Provider, scalar, valid_id},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{DateTime, Duration, Utc};
use reqwest::{
    Method,
    header::{HeaderMap, HeaderValue, SET_COOKIE},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use url::Url;

#[derive(Clone, Serialize, Deserialize, Default)]
pub struct Context {
    pub cookies: BTreeMap<String, String>,
    pub data: Value,
}
pub struct LoginStart {
    pub context: Context,
    pub qr_url: String,
    pub expires: i64,
    pub interval: i64,
}
pub enum Poll {
    Waiting,
    Scanned,
    Slower,
    Ready(String),
    Expired,
    Denied,
}
pub struct Identity {
    pub subject: String,
    pub name: String,
    pub scope: String,
    pub raw: String,
}

pub fn qr_supported(provider: Provider) -> bool {
    provider != Provider::Xunlei
}
pub fn official_url(provider: Provider) -> &'static str {
    match provider {
        Provider::Quark => "https://pan.quark.cn/",
        Provider::Baidu => "https://pan.baidu.com/",
        Provider::Aliyun => "https://www.alipan.com/",
        Provider::Xunlei => "https://pan.xunlei.com/",
        Provider::Guangya => "https://www.guangyapan.com/",
    }
}
/// Only domains owned by the five supported providers may be contacted, including
/// every hop their own login flows redirect through. Matching the registrable
/// domain instead of a fixed host list keeps the check meaningful while still
/// covering hosts the providers rotate between (for example Quark hands the scan
/// off to `b.quark.cn`, and Baidu's passport chain can hop via `wappass.baidu.com`).
fn allowed_host(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    [
        "quark.cn",
        "baidu.com",
        "aliyundrive.com",
        "alipan.com",
        "guangyapan.com",
        "xunlei.com",
    ]
    .iter()
    .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
}
fn checked_url(raw: &str) -> Result<Url, AuthFailure> {
    let url = Url::parse(raw).map_err(|_| AuthFailure::Protocol)?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|p| p != 443)
        || !url.host_str().is_some_and(allowed_host)
    {
        return Err(AuthFailure::Protocol);
    }
    Ok(url)
}
pub fn expires_at(raw: &str) -> Option<DateTime<Utc>> {
    let value: Value = serde_json::from_str(raw).ok()?;
    ["expire_time", "expires_at", "expiresAt"]
        .iter()
        .filter_map(|k| value[*k].as_str())
        .find_map(|s| {
            DateTime::parse_from_rfc3339(s)
                .ok()
                .map(|t| t.with_timezone(&Utc))
        })
}
pub fn refreshable(provider: Provider, raw: &str) -> bool {
    provider.token_auth()
        && serde_json::from_str::<Value>(raw).ok().is_some_and(|v| {
            !scalar(&v["refresh_token"]).is_empty()
                && (provider != Provider::Xunlei
                    || !field(&v, &["client_id", "clientId", "x-client-id"], "").is_empty())
        })
}
fn token_update(previous: &Value, response: &Value) -> Result<Value, AuthFailure> {
    if scalar(&response["access_token"]).is_empty() {
        return Err(oauth_failure(response));
    }
    let mut value = previous.clone();
    if !value.is_object() {
        value = json!({});
    }
    for key in [
        "access_token",
        "refresh_token",
        "token_type",
        "user_id",
        "sub",
    ] {
        if !scalar(&response[key]).is_empty() {
            value[key] = response[key].clone();
        }
    }
    // Never retain an Authorization alias that would shadow the new access token.
    value.as_object_mut().unwrap().remove("authorization");
    value.as_object_mut().unwrap().remove("accessToken");
    for key in ["expires_at", "expiresAt"] {
        value.as_object_mut().unwrap().remove(key);
    }
    if let Some(seconds) = response["expires_in"]
        .as_i64()
        .or_else(|| response["expires_in"].as_str().and_then(|s| s.parse().ok()))
    {
        if !(1..=31_536_000).contains(&seconds) {
            return Err(AuthFailure::Protocol);
        }
        value["expire_time"] = json!((Utc::now() + Duration::seconds(seconds)).to_rfc3339());
    } else if response["expire_time"].as_str().is_some() {
        value["expire_time"] = response["expire_time"].clone();
    } else {
        value.as_object_mut().unwrap().remove("expire_time");
    }
    Ok(value)
}
fn oauth_failure(value: &Value) -> AuthFailure {
    match scalar(&value["error"]).as_str() {
        "invalid_grant"
        | "invalid_token"
        | "unauthenticated"
        | "unauthorized_client"
        | "access_denied" => AuthFailure::Reauthorize,
        "review_panel" | "captcha_required" => AuthFailure::Verification,
        _ => match scalar(&value["code"]).as_str() {
            "RefreshTokenExpired"
            | "RefreshTokenInvalid"
            | "AccessTokenExpired"
            | "AccessTokenInvalid" => AuthFailure::Reauthorize,
            "TooManyRequests" => AuthFailure::RateLimited,
            _ => AuthFailure::Protocol,
        },
    }
}

struct Http<'a> {
    state: &'a AppState,
    context: Context,
}
impl<'a> Http<'a> {
    fn new(state: &'a AppState, context: Context) -> Self {
        Self { state, context }
    }
    async fn call(
        &mut self,
        method: Method,
        url: &str,
        body: Option<Value>,
        form: Option<Value>,
        headers: HeaderMap,
    ) -> Result<(Value, Option<String>), AuthFailure> {
        let official = checked_url(url)?;
        let host = official.host_str().unwrap();
        let cookies = self
            .context
            .cookies
            .iter()
            .filter(|(domain, _)| host == domain.as_str() || host.ends_with(&format!(".{domain}")))
            .map(|(_, v)| v.as_str())
            .collect::<Vec<_>>()
            .join("; ");
        #[allow(unused_mut)]
        let mut target = official.clone();
        #[cfg(test)]
        if let Some(base) = &self.state.cloud_auth_test_base {
            target = Url::parse(base)
                .unwrap()
                .join(&format!("{host}{}", official.path()))
                .unwrap();
            target.set_query(official.query());
        }
        let timeout = if official.path() == "/channel/unicast" {
            35
        } else {
            12
        };
        let mut request=self.state.cloud_http.request(method,target).timeout(std::time::Duration::from_secs(timeout))
            .header("User-Agent","Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36")
            .header("Referer",format!("https://{host}/")).headers(headers);
        if !cookies.is_empty() {
            request = request.header("Cookie", cookies);
        }
        if let Some(v) = body {
            request = request.json(&v);
        }
        if let Some(v) = form {
            request = request.form(&v);
        }
        let mut response = request.send().await.map_err(|_| AuthFailure::Network)?;
        let status = response.status();
        for cookie in response
            .headers()
            .get_all(SET_COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
        {
            if cookie
                .split(';')
                .next()
                .and_then(|s| s.split_once('='))
                .is_none()
            {
                continue;
            }
            let domain = cookie
                .split(';')
                .skip(1)
                .find_map(|p| {
                    let (k, v) = p.trim().split_once('=')?;
                    k.eq_ignore_ascii_case("domain")
                        .then(|| v.trim_start_matches('.').to_ascii_lowercase())
                })
                .unwrap_or_else(|| host.to_owned());
            if !domain.contains('.') || (host != domain && !host.ends_with(&format!(".{domain}"))) {
                continue;
            }
            let previous = self.context.cookies.entry(domain).or_default();
            *previous =
                crate::cloud_drive::transport::merge_cookies(previous, &[cookie.to_owned()]);
        }
        let location = response
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        if status.as_u16() == 429 {
            return Err(AuthFailure::RateLimited);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| AuthFailure::Network)? {
            if bytes.len() + chunk.len() > 1024 * 1024 {
                tracing::warn!(host, status=%status.as_u16(), "auth upstream response too large");
                return Err(AuthFailure::Protocol);
            }
            bytes.extend_from_slice(&chunk);
        }
        let text = match String::from_utf8(bytes) {
            Ok(text) => text,
            Err(_) => {
                tracing::warn!(host, status=%status.as_u16(), "auth upstream response is not utf8");
                return Err(AuthFailure::Protocol);
            }
        };
        let parsed = parse_json(&text);
        if parsed.is_none() && official.path() == "/v3/login/main/qrbdusslogin" {
            // Shape and parser offsets only: the body may contain credentials.
            let body = text
                .find('(')
                .zip(text.rfind(')'))
                .filter(|(left, right)| left < right)
                .map(|(left, right)| &text[left + 1..right]);
            let repaired = body.and_then(repair_quasi_json);
            let error = repaired.as_deref().or(body).unwrap_or(&text);
            let error = serde_json::from_str::<Value>(error).err();
            tracing::warn!(bytes=text.len(), jsonp=body.is_some(), repairable=repaired.is_some(),
                line=error.as_ref().map(serde_json::Error::line),
                column=error.as_ref().map(serde_json::Error::column),
                category=?error.as_ref().map(serde_json::Error::classify),
                invalid_escape=error.as_ref().is_some_and(|e| e.to_string().starts_with("invalid escape")),
                expected_value=error.as_ref().is_some_and(|e| e.to_string().starts_with("expected value")),
                expected_separator=error.as_ref().is_some_and(|e| e.to_string().starts_with("expected `,`")),
                hex_escapes=text.matches(r"\x").count(),
                content_type=response.headers().get("content-type").and_then(|v| v.to_str().ok()),
                "baidu exchange response parse failed");
        }
        let value = parsed.unwrap_or(Value::Null);
        if status.as_u16() == 501 {
            tracing::warn!(host, status = 501, "auth upstream returned 501");
            return Err(AuthFailure::Protocol);
        }
        if status.is_server_error() {
            return Err(AuthFailure::Network);
        }
        if !status.is_success() && !status.is_redirection() && !value.is_object() {
            tracing::warn!(host, status=%status.as_u16(), json=value.is_object(), "auth upstream unexpected response shape");
            return Err(if status.as_u16() == 401 {
                AuthFailure::Reauthorize
            } else {
                AuthFailure::Protocol
            });
        }
        Ok((value, location))
    }
    async fn get(&mut self, url: &str) -> Result<Value, AuthFailure> {
        self.call(Method::GET, url, None, None, HeaderMap::new())
            .await
            .map(|v| v.0)
    }
    async fn post(&mut self, url: &str, body: Value) -> Result<Value, AuthFailure> {
        self.call(Method::POST, url, Some(body), None, HeaderMap::new())
            .await
            .map(|v| v.0)
    }
    fn cookie(&self, host: &str) -> String {
        self.context
            .cookies
            .iter()
            .filter(|(d, _)| host == d.as_str() || host.ends_with(&format!(".{d}")))
            .map(|(_, v)| v.as_str())
            .collect::<Vec<_>>()
            .join("; ")
    }
    /// Names of the cookies that would be sent to `host`, sorted and deduped.
    /// Diagnostics only: cookie values are credentials and are never logged.
    fn cookie_names(&self, host: &str) -> Vec<&str> {
        let mut names = self
            .context
            .cookies
            .iter()
            .filter(|(d, _)| host == d.as_str() || host.ends_with(&format!(".{d}")))
            .flat_map(|(_, v)| v.split(';'))
            .filter_map(|pair| pair.trim().split_once('=').map(|(k, _)| k))
            .collect::<Vec<_>>();
        names.sort_unstable();
        names.dedup();
        names
    }
}
fn parse_json(text: &str) -> Option<Value> {
    if let Ok(v) = serde_json::from_str(text) {
        return Some(v);
    }
    let left = text.find('(')?;
    let right = text.rfind(')')?;
    if !text[..left]
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.'))
    {
        return None;
    }
    let body = &text[left + 1..right];
    if let Ok(v) = serde_json::from_str(body) {
        return Some(v);
    }
    serde_json::from_str(&repair_quasi_json(body)?).ok()
}
/// Normalize the data-only subset of JavaScript used in JSONP: single-quoted
/// identifier keys and JavaScript string escapes inside double-quoted
/// strings. Never evaluate scripts or change an already valid JSON payload.
/// Expressions, single-quoted values and malformed escapes still fail closed.
fn repair_quasi_json(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len() + 8);
    let mut stack: Vec<u8> = Vec::new();
    let mut in_string = false;
    let mut escaped = false;
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if in_string {
            if !escaped && byte == b'\\' {
                match bytes.get(index + 1) {
                    Some(b'u') if bytes.get(index + 2) == Some(&b'{') => {
                        let start = index + 3;
                        let count = bytes.get(start..)?.iter().position(|b| *b == b'}')?;
                        let hex = bytes.get(start..start + count)?;
                        if hex.is_empty() || !hex.iter().all(u8::is_ascii_hexdigit) {
                            return None;
                        }
                        let value = u32::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?;
                        if value > 0x10ffff {
                            return None;
                        }
                        if value <= 0xffff {
                            out.extend_from_slice(format!("\\u{value:04x}").as_bytes());
                        } else {
                            let high = 0xd800 + ((value - 0x10000) >> 10);
                            let low = 0xdc00 + ((value - 0x10000) & 0x3ff);
                            out.extend_from_slice(format!("\\u{high:04x}\\u{low:04x}").as_bytes());
                        }
                        index = start + count + 1;
                        continue;
                    }
                    Some(b'x') => {
                        let hex = bytes.get(index + 2..index + 4)?;
                        if !hex.iter().all(u8::is_ascii_hexdigit) {
                            return None;
                        }
                        // JS \xHH and JSON \u00HH represent the same code point.
                        out.extend_from_slice(b"\\u00");
                        out.extend_from_slice(hex);
                        index += 4;
                        continue;
                    }
                    Some(b'v') => {
                        out.extend_from_slice(b"\\u000b");
                        index += 2;
                        continue;
                    }
                    Some(first @ b'0'..=b'7') => {
                        // Legacy octal escapes are valid in non-strict JS strings.
                        let limit = if *first <= b'3' { 3 } else { 2 };
                        let mut end = index + 1;
                        let mut value = 0u8;
                        while end < bytes.len()
                            && end < index + 1 + limit
                            && matches!(bytes[end], b'0'..=b'7')
                        {
                            value = value * 8 + (bytes[end] - b'0');
                            end += 1;
                        }
                        out.extend_from_slice(format!("\\u{value:04x}").as_bytes());
                        index = end;
                        continue;
                    }
                    Some(b'\n' | b'\r') => {
                        index += 2;
                        if bytes[index - 1] == b'\r' && bytes.get(index) == Some(&b'\n') {
                            index += 1;
                        }
                        continue;
                    }
                    Some(b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' | b'u') => {}
                    Some(next) if !next.is_ascii_control() => {
                        // JS NonEscapeCharacter: \& -> &, \q -> q, \8 -> 8.
                        // Copy the character on the next iteration, so UTF-8 is
                        // preserved. A quoted delimiter cannot enter this arm.
                        if bytes
                            .get(index + 1..index + 4)
                            .is_some_and(|v| v == b"\xe2\x80\xa8" || v == b"\xe2\x80\xa9")
                        {
                            index += 4;
                        } else {
                            index += 1;
                        }
                        continue;
                    }
                    Some(_) | None => return None,
                }
            }
            out.push(byte);
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        match byte {
            b'"' => {
                in_string = true;
                out.push(byte);
                index += 1;
            }
            b'{' | b'[' => {
                stack.push(byte);
                out.push(byte);
                index += 1;
            }
            b'}' | b']' => {
                if stack.pop() != Some(if byte == b'}' { b'{' } else { b'[' }) {
                    return None;
                }
                out.push(byte);
                index += 1;
            }
            b'\'' => {
                // A repairable quote must open a key: it has to sit where a key
                // can start, name an identifier, and be followed by a colon.
                let previous = out.iter().rev().find(|b| !b.is_ascii_whitespace())?;
                if !matches!(*previous, b'{' | b',') {
                    return None;
                }
                let close = bytes[index + 1..].iter().position(|b| *b == b'\'')?;
                let name = &bytes[index + 1..index + 1 + close];
                if name.is_empty() || !name.iter().all(|b| b.is_ascii_alphanumeric() || *b == b'_')
                {
                    return None;
                }
                if bytes[index + 1 + close + 1..]
                    .iter()
                    .find(|b| !b.is_ascii_whitespace())
                    != Some(&b':')
                {
                    return None;
                }
                out.push(b'"');
                out.extend_from_slice(name);
                out.push(b'"');
                index += close + 2;
            }
            _ => {
                out.push(byte);
                index += 1;
            }
        }
    }
    if in_string || escaped || !stack.is_empty() {
        return None;
    }
    String::from_utf8(out).ok()
}
fn number(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| value.as_str()?.parse().ok())
}
fn baidu_login_url(raw: &str) -> Result<Url, AuthFailure> {
    let url = checked_url(raw)?;
    // The post-login hand-off must stay on Baidu's own hosts. It normally lands
    // on pan.baidu.com, but the chain may hop through wappass.baidu.com, so match
    // the domain rather than two fixed host names.
    if !url
        .host_str()
        .is_some_and(|host| host == "baidu.com" || host.ends_with(".baidu.com"))
    {
        return Err(AuthFailure::Protocol);
    }
    Ok(url)
}
enum BaiduScan {
    Waiting,
    Scanned,
    Denied,
    Ticket(String),
}
fn baidu_scan(value: &Value) -> Result<BaiduScan, AuthFailure> {
    match number(&value["errno"]) {
        Some(1) => return Ok(BaiduScan::Waiting),
        Some(0) => {}
        other => {
            tracing::warn!(errno=?other, "baidu unicast errno rejected");
            return Err(AuthFailure::Protocol);
        }
    }
    let info: Value = if value["channel_v"].is_object() {
        value["channel_v"].clone()
    } else {
        serde_json::from_str(&scalar(&value["channel_v"])).map_err(|_| {
            tracing::warn!("baidu channel_v is not parseable");
            AuthFailure::Protocol
        })?
    };
    let info = if info["msg"].is_object() {
        &info["msg"]
    } else {
        &info
    };
    Ok(match number(&info["status"]) {
        Some(0) => {
            let ticket = scalar(&info["v"]);
            if ticket.is_empty() {
                tracing::warn!("baidu confirm state has no ticket");
                return Err(AuthFailure::Protocol);
            }
            BaiduScan::Ticket(ticket)
        }
        Some(1) => BaiduScan::Scanned,
        Some(2) => BaiduScan::Denied,
        Some(_) => BaiduScan::Waiting,
        None => {
            tracing::warn!("baidu channel_v status missing");
            return Err(AuthFailure::Protocol);
        }
    })
}
fn baidu_exchange_url(value: &Value) -> Result<String, AuthFailure> {
    if number(&value["errInfo"]["no"]) != Some(0) {
        tracing::warn!(no=?number(&value["errInfo"]["no"]),
            json=value.is_object(),
            has_data=value.get("data").is_some(),
            has_code=value.get("code").is_some(),
            "baidu qr exchange rejected");
        return Err(AuthFailure::Protocol);
    }
    let url = scalar(&value["data"]["u"]);
    baidu_login_url(&url)?;
    Ok(url)
}
fn baidu_account_data(value: &Value) -> Result<&Value, AuthFailure> {
    match number(&value["errno"]) {
        Some(0) => {}
        Some(-6) => return Err(AuthFailure::Reauthorize),
        _ => return Err(AuthFailure::Protocol),
    }
    let data = &value["result"];
    if !valid_id(&scalar(&data["uk"]), false) {
        return Err(AuthFailure::Protocol);
    }
    Ok(data)
}
async fn baidu_finish(http: &mut Http<'_>, raw: &str) -> Result<(), AuthFailure> {
    let mut url = baidu_login_url(raw)?;
    for hop in 0..6 {
        let (_, location) = http
            .call(Method::GET, url.as_str(), None, None, HeaderMap::new())
            .await?;
        tracing::info!(
            provider = "baidu",
            hop,
            redirect = location.is_some(),
            "baidu login finish hop"
        );
        let Some(location) = location else {
            return Ok(());
        };
        url = baidu_login_url(
            url.join(&location)
                .map_err(|_| {
                    tracing::warn!("baidu finish location invalid");
                    AuthFailure::Protocol
                })?
                .as_str(),
        )?;
    }
    tracing::warn!("baidu finish exceeded redirect budget");
    Err(AuthFailure::Protocol)
}
fn url_with(base: &str, params: &[(&str, String)]) -> String {
    let mut url = Url::parse(base).unwrap();
    url.query_pairs_mut()
        .extend_pairs(params.iter().map(|(k, v)| (*k, v.as_str())));
    url.into()
}
/// The device-code response advertises the authorisation page on
/// `account.guangyapan.com`, which nginx answers with 404 for this route; the
/// same page is live on the www host the official site serves. Rewrite only that
/// exact host so a later server-side fix is still respected.
fn guangya_verification_url(value: &Value) -> String {
    let advertised = scalar(&value["verification_uri_complete"]);
    let Ok(mut url) = Url::parse(&advertised) else {
        return String::new();
    };
    if url.scheme() != "https" {
        return String::new();
    }
    if url.host_str() == Some("account.guangyapan.com")
        && url.set_host(Some("www.guangyapan.com")).is_err()
    {
        return String::new();
    }
    url.into()
}

pub async fn start(state: &AppState, provider: Provider) -> Result<LoginStart, AuthFailure> {
    let mut http = Http::new(state, Context::default());
    let (qr_url, expires, interval) = match provider {
        Provider::Quark => {
            let value = http
                .get(&url_with(
                    "https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin",
                    &[
                        ("client_id", "532".into()),
                        ("v", "1.2".into()),
                        ("request_id", uuid::Uuid::new_v4().to_string()),
                    ],
                ))
                .await?;
            let token = scalar(&value["data"]["members"]["token"]);
            if value["status"] != 2000000 || token.is_empty() {
                return Err(AuthFailure::Protocol);
            }
            http.context.data = json!({"token":token});
            (
                url_with(
                    "https://su.quark.cn/4_eMHBJ",
                    &[
                        ("token", token),
                        ("client_id", "532".into()),
                        ("ssb", "weblogin".into()),
                        ("uc_param_str", "".into()),
                        (
                            "uc_biz_str",
                            "S:custom|OPT:SAREA@0|OPT:IMMERSIVE@1|OPT:BACK_BTN_STYLE@0".into(),
                        ),
                    ],
                ),
                300,
                3,
            )
        }
        Provider::Aliyun => {
            let mut next = Some(url_with(
                "https://auth.aliyundrive.com/v2/oauth/authorize",
                &[
                    ("login_type", "custom".into()),
                    ("response_type", "code".into()),
                    (
                        "redirect_uri",
                        "https://www.aliyundrive.com/sign/callback".into(),
                    ),
                    ("client_id", "25dzX3vbYqktVxyX".into()),
                    (
                        "state",
                        json!({"origin":"https://www.alipan.com"}).to_string(),
                    ),
                ],
            ));
            for _ in 0..4 {
                let Some(url) = next.take() else { break };
                let (_, location) = http
                    .call(Method::GET, &url, None, None, HeaderMap::new())
                    .await?;
                next = location
                    .map(|s| Url::parse(&url).unwrap().join(&s).map(String::from))
                    .transpose()
                    .map_err(|_| AuthFailure::Protocol)?;
            }
            let value=http.get("https://passport.aliyundrive.com/newlogin/qrcode/generate.do?appName=aliyun_drive").await?;
            let data = &value["content"]["data"];
            let qr = scalar(&data["codeContent"]);
            if qr.is_empty() || scalar(&data["ck"]).is_empty() || scalar(&data["t"]).is_empty() {
                return Err(AuthFailure::Protocol);
            }
            http.context.data = data.clone();
            (qr, 180, 3)
        }
        Provider::Guangya => {
            let device = uuid::Uuid::new_v4().simple().to_string();
            let device_sign = format!("wdi10.{device}{}", uuid::Uuid::new_v4().simple());
            let previous = json!({"device_id":device,"device_sign":device_sign,"client_id":"aMe-8VSlkrbQXpUR"});
            let value = http
                .call(
                    Method::POST,
                    "https://account.guangyapan.com/v1/auth/device/code",
                    Some(json!({"client_id":"aMe-8VSlkrbQXpUR","scope":"user"})),
                    None,
                    crate::cloud_drive::guangya_auth_headers(&previous.to_string())
                        .map_err(|_| AuthFailure::Protocol)?,
                )
                .await?
                .0;
            let code = scalar(&value["device_code"]);
            let qr = guangya_verification_url(&value);
            if code.is_empty() || qr.is_empty() {
                return Err(oauth_failure(&value));
            }
            http.context.data = previous;
            http.context.data["device_code"] = json!(code);
            (
                qr,
                value["expires_in"].as_i64().unwrap_or(300).clamp(30, 600),
                value["interval"].as_i64().unwrap_or(3).clamp(2, 30),
            )
        }
        Provider::Baidu => {
            http.get("https://pan.baidu.com/").await?;
            let gid = uuid::Uuid::new_v4().to_string();
            let callback = format!("pansou_{}", Utc::now().timestamp_millis());
            let value = http
                .get(&url_with(
                    "https://passport.baidu.com/v2/api/getqrcode",
                    &[
                        ("lp", "pc".into()),
                        ("qrloginfrom", "pc".into()),
                        ("tpl", "netdisk".into()),
                        ("gid", gid.clone()),
                        ("callback", callback.clone()),
                        ("apiver", "v3".into()),
                        ("tt", Utc::now().timestamp_millis().to_string()),
                    ],
                ))
                .await?;
            let sign = scalar(&value["sign"]);
            let qr = scalar(&value["imgurl"]);
            if sign.is_empty() || qr.is_empty() {
                return Err(AuthFailure::Protocol);
            }
            http.context.data = json!({"sign":sign,"gid":gid,"callback":callback});
            // imgurl is an image URL, converted to an inline image by the caller.
            (
                if qr.starts_with("//") {
                    format!("https:{qr}")
                } else if !qr.starts_with("https://") {
                    format!("https://{qr}")
                } else {
                    qr
                },
                180,
                3,
            )
        }
        Provider::Xunlei => return Err(AuthFailure::Unsupported),
    };
    checked_url(&qr_url)?;
    Ok(LoginStart {
        context: http.context,
        qr_url,
        expires,
        interval,
    })
}

pub async fn poll(
    state: &AppState,
    provider: Provider,
    context: &mut Context,
) -> Result<Poll, AuthFailure> {
    let mut http = Http::new(state, context.clone());
    let result = match provider {
        Provider::Quark => {
            let value = http
                .get(&url_with(
                    "https://uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken",
                    &[
                        ("client_id", "532".into()),
                        ("v", "1.2".into()),
                        ("token", scalar(&context.data["token"])),
                        ("request_id", uuid::Uuid::new_v4().to_string()),
                    ],
                ))
                .await?;
            let ticket = scalar(&value["data"]["members"]["service_ticket"]);
            if !ticket.is_empty() {
                // The pan session is established across the whole login redirect
                // chain, exactly like a browser: Set-Cookie may arrive on any hop,
                // not only on the first response. Redirects are never followed
                // automatically, so walk the chain explicitly; checked_url
                // re-validates every hop target before the request is sent.
                let mut url = url_with(
                    "https://pan.quark.cn/account/info",
                    &[("st", ticket), ("lw", "scan".into())],
                );
                for hop in 0..6 {
                    let (value, location) = http
                        .call(Method::GET, &url, None, None, HeaderMap::new())
                        .await
                        .map_err(exchange_failure)?;
                    // Envelope metadata only: key names and the status token are
                    // safe to log, the payload itself never is.
                    tracing::info!(
                        provider="quark",
                        hop,
                        json=value.is_object(),
                        redirect=location.is_some(),
                        keys=?value.as_object().map(|o|o.keys().collect::<Vec<_>>()),
                        success=value["success"].as_bool(),
                        code=%truncate(&scalar(&value["code"]),32),
                        "qr ticket exchange hop"
                    );
                    let Some(next) = location else { break };
                    url = Url::parse(&url)
                        .map_err(|_| AuthFailure::Protocol)?
                        .join(&next)
                        .map_err(|_| AuthFailure::Protocol)?
                        .into();
                }
                // Cookie *names* only, never values: this shows whether the hop
                // actually handed out a pan session cookie (__puus/__pus/__kps).
                tracing::info!(
                    provider="quark",
                    cookie_names=?http.cookie_names("pan.quark.cn"),
                    "qr ticket exchange captured cookies"
                );
                // The exchange response itself may be an intermediate hop, so a
                // fresh request must prove the captured cookies hold the session
                // before they are stored as the credential.
                let account = http
                    .get("https://pan.quark.cn/account/info?fr=pc&platform=pc")
                    .await
                    .map_err(exchange_failure)?;
                quark_account_data(&account)?;
                Poll::Ready(http.cookie("pan.quark.cn"))
            } else {
                match value["status"].as_i64() {
                    Some(50004002) => Poll::Expired,
                    Some(50004003 | 50004004) => Poll::Denied,
                    Some(50004001 | 2000000) => Poll::Waiting,
                    _ => return Err(AuthFailure::Protocol),
                }
            }
        }
        Provider::Aliyun => {
            let value=http.call(Method::POST,"https://passport.aliyundrive.com/newlogin/qrcode/query.do?appName=aliyun_drive",None,Some(context.data.clone()),HeaderMap::new()).await?.0;
            let data = &value["content"]["data"];
            match scalar(&data["qrCodeStatus"]).as_str() {
                "NEW" => Poll::Waiting,
                "SCANED" | "SCANNED" => Poll::Scanned,
                "EXPIRED" => Poll::Expired,
                "CANCELED" => Poll::Denied,
                "CONFIRMED" => {
                    let bytes = STANDARD
                        .decode(scalar(&data["bizExt"]))
                        .map_err(|_| AuthFailure::Protocol)?;
                    let info: Value = decode_biz_ext(&bytes)?;
                    let token = scalar(&info["pds_login_result"]["refreshToken"]);
                    if token.is_empty() {
                        return Err(AuthFailure::Protocol);
                    }
                    let previous = json!({"refresh_token":token,"device_id":uuid::Uuid::new_v4().simple().to_string()});
                    Poll::Ready(
                        refresh(state, provider, &previous.to_string())
                            .await
                            .map_err(exchange_failure)?,
                    )
                }
                _ => return Err(AuthFailure::Protocol),
            }
        }
        Provider::Guangya => {
            let value=http.call(Method::POST,"https://account.guangyapan.com/v1/auth/token",Some(json!({"client_id":context.data["client_id"],"device_code":context.data["device_code"],"grant_type":"urn:ietf:params:oauth:grant-type:device_code"})),None,crate::cloud_drive::guangya_auth_headers(&context.data.to_string()).map_err(|_|AuthFailure::Protocol)?).await.map_err(exchange_failure)?.0;
            match scalar(&value["error"]).as_str() {
                "authorization_pending" => Poll::Waiting,
                "slow_down" => Poll::Slower,
                "expired_token" => Poll::Expired,
                "access_denied" => Poll::Denied,
                "" => {
                    let mut previous = context.data.clone();
                    previous.as_object_mut().unwrap().remove("device_code");
                    Poll::Ready(token_update(&previous, &value)?.to_string())
                }
                _ => return Err(oauth_failure(&value)),
            }
        }
        Provider::Baidu => {
            let value = http
                .get(&url_with(
                    "https://passport.baidu.com/channel/unicast",
                    &[
                        ("channel_id", scalar(&context.data["sign"])),
                        ("tpl", "netdisk".into()),
                        ("gid", scalar(&context.data["gid"])),
                        ("apiver", "v3".into()),
                        ("callback", scalar(&context.data["callback"])),
                        ("tt", Utc::now().timestamp_millis().to_string()),
                    ],
                ))
                .await?;
            match baidu_scan(&value)? {
                BaiduScan::Waiting => Poll::Waiting,
                BaiduScan::Scanned => Poll::Scanned,
                BaiduScan::Denied => Poll::Denied,
                BaiduScan::Ticket(ticket) => {
                    let exchanged = http
                        .get(&url_with(
                            "https://passport.baidu.com/v3/login/main/qrbdusslogin",
                            &[
                                ("bduss", ticket),
                                ("u", "https://pan.baidu.com/disk/main".into()),
                                ("alg", "v3".into()),
                                ("apiver", "v3".into()),
                                ("time", Utc::now().timestamp().to_string()),
                                ("tt", Utc::now().timestamp_millis().to_string()),
                                ("v", Utc::now().timestamp_millis().to_string()),
                                ("callback", scalar(&context.data["callback"])),
                                ("loginVersion", "v4".into()),
                                ("qrcode", "1".into()),
                                ("tpl", "netdisk".into()),
                            ],
                        ))
                        .await
                        .map_err(exchange_failure)?;
                    // The bdusslogin body is the argument of a JSONP script a
                    // browser evaluates as JavaScript, not JSON: any JS-only
                    // syntax (trailing commas, quoted keys, JS string escapes)
                    // may appear, so parsing stays best-effort and never gates
                    // the login. The outcome is decided by the session cookie
                    // handed out with the response; the identity check rejects
                    // an anonymous jar before anything is stored.
                    match baidu_exchange_url(&exchanged) {
                        Ok(finish) => baidu_finish(&mut http, &finish)
                            .await
                            .map_err(exchange_failure)?,
                        Err(error) => {
                            let jar = http.cookie("pan.baidu.com");
                            let has_session =
                                !crate::cloud_drive::transport::cookie_value(&jar, "BDUSS")
                                    .is_empty()
                                    || !crate::cloud_drive::transport::cookie_value(
                                        &jar,
                                        "BDUSS_BFESS",
                                    )
                                    .is_empty();
                            if !has_session {
                                // A parsed rejection (no != 0) is a declined
                                // login; an unparseable body without a session
                                // cookie is indistinguishable from one here.
                                return Err(
                                    if number(&exchanged["errInfo"]["no"]).is_some_and(|no| no != 0)
                                    {
                                        AuthFailure::Reauthorize
                                    } else {
                                        error
                                    },
                                );
                            }
                            // Land on the pan origin once, like the browser's
                            // post-login redirect, so pan-only cookies are not
                            // missing later.
                            baidu_finish(&mut http, "https://pan.baidu.com/")
                                .await
                                .map_err(exchange_failure)?;
                        }
                    }
                    let cookie = http.cookie("pan.baidu.com");
                    if crate::cloud_drive::transport::cookie_value(&cookie, "BDUSS").is_empty()
                        && crate::cloud_drive::transport::cookie_value(&cookie, "BDUSS_BFESS")
                            .is_empty()
                    {
                        tracing::warn!(
                            bduss = false,
                            bfess = false,
                            cookies = !cookie.is_empty(),
                            "baidu finish produced no login cookie"
                        );
                        return Err(AuthFailure::Protocol);
                    }
                    Poll::Ready(cookie)
                }
            }
        }
        Provider::Xunlei => return Err(AuthFailure::Unsupported),
    };
    *context = http.context;
    Ok(result)
}

pub async fn refresh(
    state: &AppState,
    provider: Provider,
    raw: &str,
) -> Result<String, AuthFailure> {
    let value: Value = serde_json::from_str(raw).map_err(|_| AuthFailure::Protocol)?;
    let refresh_token = scalar(&value["refresh_token"]);
    if refresh_token.is_empty() {
        return Err(AuthFailure::Reauthorize);
    }
    let mut http = Http::new(state, Context::default());
    let response = match provider {
        Provider::Aliyun => {
            http.post(
                "https://api.aliyundrive.com/v2/account/token",
                json!({"refresh_token":refresh_token,"grant_type":"refresh_token"}),
            )
            .await?
        }
        Provider::Guangya => {
            let mut headers =
                crate::cloud_drive::guangya_auth_headers(raw).map_err(|_| AuthFailure::Protocol)?;
            // The official client marks refresh calls with x-action: 401 so the
            // account service rotates the token instead of answering with an
            // interactive re-authorisation challenge.
            headers.insert("x-action", HeaderValue::from_static("401"));
            http.call(Method::POST,"https://account.guangyapan.com/v1/auth/token",Some(json!({"refresh_token":refresh_token,"grant_type":"refresh_token","client_id":field(&value,&["client_id","clientId","x-client-id"],"aMe-8VSlkrbQXpUR")})),None,headers).await?.0
        }
        Provider::Xunlei => {
            let client = field(&value, &["client_id", "clientId", "x-client-id"], "");
            if client.is_empty() {
                return Err(AuthFailure::ClientConfiguration);
            }
            let mut body = json!({"refresh_token":refresh_token,"grant_type":"refresh_token","client_id":client});
            // Client secret is an optional public-client field supplied by the
            // same official session; never borrow a different client's identity.
            let secret = field(&value, &["client_secret", "clientSecret"], "");
            if !secret.is_empty() {
                body["client_secret"] = json!(secret);
            }
            http.call(
                Method::POST,
                "https://xluser-ssl.xunlei.com/v1/auth/token",
                Some(body),
                None,
                crate::cloud_drive::extended_headers(provider, raw)
                    .map_err(|_| AuthFailure::Protocol)?,
            )
            .await?
            .0
        }
        _ => return Err(AuthFailure::Unsupported),
    };
    Ok(token_update(&value, &response)?.to_string())
}
fn field(v: &Value, keys: &[&str], default: &str) -> String {
    keys.iter()
        .map(|k| scalar(&v[*k]))
        .find(|s| !s.is_empty())
        .unwrap_or_else(|| default.into())
}
async fn ali_storage_scope(
    http: &mut Http<'_>,
    credential: &Value,
    user: &Value,
) -> Result<String, AuthFailure> {
    // A stored/imported drive is part of the account binding and ownership key.
    // Keep it during renewal, even if another space would be a better default.
    let selected = field(credential, &["drive_id", "driveId"], "");
    if !selected.is_empty() {
        return Ok(selected);
    }
    let resource = field(user, &["resource_drive_id"], "");
    if !resource.is_empty() {
        return Ok(resource);
    }
    // The live /v2/user/get response only supplies default_drive_id, which can
    // be the backup space. Discover the resource library before falling back.
    let headers = crate::cloud_drive::extended_headers(Provider::Aliyun, &credential.to_string())
        .map_err(|_| AuthFailure::Protocol)?;
    let mut marker = String::new();
    let mut seen = std::collections::HashSet::new();
    for _ in 0..50 {
        let response = http
            .call(
                Method::POST,
                "https://api.aliyundrive.com/v2/drive/list_my_drives",
                Some(json!({"limit":100,"marker":marker})),
                None,
                headers.clone(),
            )
            .await?
            .0;
        if !scalar(&response["code"]).is_empty() && response["code"] != 0 {
            return Err(oauth_failure(&response));
        }
        let drives = response["items"].as_array().ok_or(AuthFailure::Protocol)?;
        if let Some(drive) = drives
            .iter()
            .find(|d| d["category"] == "resource" && d["status"] == "enabled")
        {
            let id = scalar(&drive["drive_id"]);
            return if valid_id(&id, false) {
                Ok(id)
            } else {
                Err(AuthFailure::Protocol)
            };
        }
        marker = scalar(&response["next_marker"]);
        if marker.is_empty() {
            return Ok(field(user, &["default_drive_id"], ""));
        }
        if !seen.insert(marker.clone()) {
            return Err(AuthFailure::Protocol);
        }
    }
    Err(AuthFailure::Protocol)
}
fn exchange_failure(error: AuthFailure) -> AuthFailure {
    // A response timeout can happen after a one-use ticket/refresh token was
    // consumed. Do not retry that exchange as if it were a read-only poll.
    if matches!(error, AuthFailure::Network) {
        AuthFailure::ExchangeUncertain
    } else {
        error
    }
}
pub fn stable_key(provider: Provider, subject: &str, scope: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(json!([provider.name(), subject, scope]).to_string())
    )
}

/// Keep a diagnostic token short; upstream status tokens are tiny, but a
/// malformed reply must not be able to flood the log.
fn truncate(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

/// Field names that identify the Quark account itself, most specific first.
/// `id` is deliberately last: a wrapper object may carry unrelated ids.
const QUARK_IDENTITY_KEYS: [&str; 6] = ["uid", "user_id", "userId", "uk", "sub", "id"];

/// Locate the account id inside a `/account/info` payload. The live service has
/// shipped more than one shape, so the id is looked up under the known names at
/// the top level and one level down inside the usual wrappers. Only a value that
/// passes `valid_id` is accepted.
fn quark_identity(data: &Value) -> Option<String> {
    let lookup = |object: &serde_json::Map<String, Value>| {
        QUARK_IDENTITY_KEYS
            .iter()
            .filter_map(|key| object.get(*key))
            .map(scalar)
            .find(|value| valid_id(value, false))
    };
    data.as_object().and_then(&lookup).or_else(|| {
        ["user", "member", "account", "profile", "info", "data"]
            .iter()
            .filter_map(|key| data[*key].as_object())
            .find_map(&lookup)
    })
}

/// Quark's `/account/info` payload carries display data only — the live response
/// is `{avatarUri, config, mobilekps, nickname}` and has **no id field at all**.
/// The account id lives in the `__uid` cookie that the same exchange hands out
/// alongside `__pus`/`__kp`/`__kps`. Only a value passing `valid_id` counts, so a
/// half-established session (cookies but no account cookie) still fails.
fn quark_cookie_uid_raw(cookies: &str) -> Option<&str> {
    cookies
        .split(';')
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, _)| name.eq_ignore_ascii_case("__uid"))
        .map(|(_, value)| value)
}

fn quark_cookie_uid(cookies: &str) -> Option<String> {
    quark_cookie_uid_raw(cookies)
        .filter(|value| valid_id(value, false))
        .map(str::to_owned)
}

fn quark_account_data(response: &Value) -> Result<&Value, AuthFailure> {
    // CAS QR APIs use status=2000000; pan.quark.cn/account/info does not.
    // Its anonymous response is success=true/code=OK/data={}, so a non-empty
    // payload is what proves the captured cookie holds a session. The account id
    // itself is resolved separately (payload field or `__uid` cookie).
    let code = scalar(&response["code"]);
    if code.starts_with("AUTH_ERROR:") {
        return Err(AuthFailure::Reauthorize);
    }
    if response["success"] != true || code != "OK" {
        tracing::warn!(success=response["success"].as_bool(), code=%code, "quark account envelope rejected");
        return Err(AuthFailure::Protocol);
    }
    let data = &response["data"];
    if data.is_null()
        || data.as_array().is_some_and(|a| a.is_empty())
        || data.as_object().is_some_and(|o| o.is_empty())
    {
        return Err(AuthFailure::Reauthorize);
    }
    Ok(data)
}

pub async fn identity(
    state: &AppState,
    provider: Provider,
    raw: &str,
) -> Result<Identity, AuthFailure> {
    let mut context = Context::default();
    if !provider.token_auth() {
        context.cookies.insert(
            if provider == Provider::Quark {
                "quark.cn"
            } else {
                "baidu.com"
            }
            .into(),
            raw.into(),
        );
    }
    let mut http = Http::new(state, context);
    let mut value = if provider.token_auth() {
        serde_json::from_str::<Value>(raw).map_err(|_| AuthFailure::Protocol)?
    } else {
        Value::Null
    };
    let mut headers = if provider.token_auth() {
        crate::cloud_drive::extended_headers(provider, raw).map_err(|_| AuthFailure::Protocol)?
    } else {
        HeaderMap::new()
    };
    if !provider.token_auth() {
        HeaderValue::from_str(raw).map_err(|_| AuthFailure::Protocol)?;
    }
    let response=match provider {
        Provider::Quark=>http.call(Method::GET,"https://pan.quark.cn/account/info?fr=pc&platform=pc",None,None,headers).await?.0,
        Provider::Baidu=>http.call(Method::GET,"https://pan.baidu.com/api/gettemplatevariable?clienttype=0&app_id=38824127&web=1&fields=%5B%22uk%22%2C%22bdstoken%22%5D",None,None,headers).await?.0,
        Provider::Aliyun=>http.call(Method::POST,"https://api.aliyundrive.com/v2/user/get",Some(json!({})),None,headers).await?.0,
        Provider::Xunlei=>http.call(Method::GET,"https://xluser-ssl.xunlei.com/v1/user/me",None,None,headers).await?.0,
        Provider::Guangya=>{
            if !headers.contains_key("x-device-id"){
                value["device_id"]=json!(uuid::Uuid::new_v4().simple().to_string());
                headers=crate::cloud_drive::extended_headers(provider,&value.to_string()).map_err(|_|AuthFailure::Protocol)?;
            }
            if !headers.contains_key("x-device-sign") {
                value["device_sign"]=json!(format!("wdi10.{}{}",field(&value,&["device_id","deviceId","x-device-id"],""),uuid::Uuid::new_v4().simple()));
                headers.insert("x-device-sign",HeaderValue::from_str(value["device_sign"].as_str().unwrap()).map_err(|_|AuthFailure::Protocol)?);
            }
            headers=crate::cloud_drive::guangya_auth_headers(&value.to_string()).map_err(|_|AuthFailure::Protocol)?;
            http.call(Method::GET,"https://account.guangyapan.com/v1/user/me",None,None,headers).await?.0
        }
    };
    if !scalar(&response["error"]).is_empty() {
        return Err(oauth_failure(&response));
    }
    let data = if provider == Provider::Quark {
        quark_account_data(&response)?
    } else if provider == Provider::Baidu {
        baidu_account_data(&response)?
    } else if response["data"].is_object() {
        &response["data"]
    } else if response["result"].is_object() {
        &response["result"]
    } else {
        &response
    };
    let subject = if provider == Provider::Quark {
        // The id may sit in the payload (older shapes) or only in the `__uid`
        // cookie that came with the session; the live payload has neither a
        // `uid` nor any other id field, so the cookie is the usual source.
        let subject = quark_identity(data).or_else(|| quark_cookie_uid(raw));
        if subject.is_none() {
            // Key names only, never values: this is what keeps the failure
            // diagnosable without leaking account data.
            tracing::warn!(
                data_keys = ?data.as_object().map(|o| o.keys().collect::<Vec<_>>()),
                uid_cookie_present = quark_cookie_uid_raw(raw).is_some(),
                "quark account identity is missing"
            );
        }
        subject.unwrap_or_default()
    } else {
        field(data, &["user_id", "userId", "sub", "id", "uk", "uid"], "")
    };
    if !valid_id(&subject, false) {
        return Err(AuthFailure::Reauthorize);
    }
    if provider == Provider::Aliyun {
        let supplied = field(&value, &["user_id", "userId", "sub"], "");
        if !supplied.is_empty() && supplied != subject {
            return Err(AuthFailure::AccountMismatch);
        }
        value["user_id"] = json!(subject);
        if value["device_private_key"].is_string()
            || (scalar(&value["signature"]).is_empty() && scalar(&value["x-signature"]).is_empty())
        {
            register_ali_device(state, &mut value).await?;
        }
    }
    let name = field(
        data,
        &["nick_name", "nickname", "name", "user_name", "username"],
        "已连接账号",
    );
    let scope = if provider == Provider::Aliyun {
        let scope = ali_storage_scope(&mut http, &value, data).await?;
        if !valid_id(&scope, false) {
            return Err(AuthFailure::Protocol);
        }
        // Check the selected space actually belongs to the verified user.
        let drive = http
            .call(
                Method::POST,
                "https://api.aliyundrive.com/v2/drive/get",
                Some(json!({"drive_id":scope})),
                None,
                crate::cloud_drive::extended_headers(provider, &value.to_string())
                    .map_err(|_| AuthFailure::Protocol)?,
            )
            .await?
            .0;
        if !scalar(&drive["code"]).is_empty() && drive["code"] != 0 {
            return Err(oauth_failure(&drive));
        }
        let owner = if drive["owner"].is_object() {
            field(&drive["owner"], &["user_id", "id"], "")
        } else {
            field(&drive, &["owner", "user_id"], "")
        };
        if owner != subject {
            return Err(AuthFailure::AccountMismatch);
        }
        value["drive_id"] = json!(scope);
        scope
    } else {
        String::new()
    };
    if provider.token_auth() {
        let supplied = field(&value, &["user_id", "userId", "sub"], "");
        if !supplied.is_empty() && supplied != subject {
            return Err(AuthFailure::AccountMismatch);
        }
        value["user_id"] = json!(subject);
        crate::cloud_drive::validate_credential(provider, &value.to_string())
            .map_err(|_| AuthFailure::Protocol)?;
    }
    Ok(Identity {
        subject,
        name,
        scope,
        raw: if provider.token_auth() {
            value.to_string()
        } else {
            http.cookie(if provider == Provider::Quark {
                "pan.quark.cn"
            } else {
                "pan.baidu.com"
            })
        },
    })
}

async fn register_ali_device(state: &AppState, value: &mut Value) -> Result<(), AuthFailure> {
    use k256::ecdsa::SigningKey;
    let key = if let Some(raw) = value["device_private_key"].as_str() {
        let bytes = STANDARD.decode(raw).map_err(|_| AuthFailure::Protocol)?;
        SigningKey::from_slice(&bytes).map_err(|_| AuthFailure::Protocol)?
    } else {
        SigningKey::random(&mut k256::elliptic_curve::rand_core::OsRng)
    };
    let device = field(
        value,
        &["device_id", "deviceId", "x-device-id"],
        &uuid::Uuid::new_v4().simple().to_string(),
    );
    for alias in ["device_id", "deviceId", "x-device-id"] {
        let other = scalar(&value[alias]);
        if !other.is_empty() && other != device {
            return Err(AuthFailure::Protocol);
        }
    }
    let message = format!(
        "5dde4e1bdf9e4966b387ba58f4b3fdc3:{device}:{}:0",
        scalar(&value["user_id"])
    );
    let (sig, recovery) = key
        .sign_digest_recoverable(Sha256::new_with_prefix(message.as_bytes()))
        .map_err(|_| AuthFailure::Protocol)?;
    let mut bytes = sig.to_bytes().to_vec();
    bytes.push(recovery.to_byte());
    value["signature"] = json!(hex(&bytes));
    value["device_id"] = json!(device);
    for alias in ["x-device-id", "deviceId", "x-signature"] {
        value.as_object_mut().unwrap().remove(alias);
    }
    value["device_private_key"] = json!(STANDARD.encode(key.to_bytes()));
    let public = hex(key.verifying_key().to_encoded_point(false).as_bytes());
    let mut http = Http::new(state, Context::default());
    let response=http.call(Method::POST,"https://api.aliyundrive.com/users/v1/users/device/create_session",Some(json!({"deviceName":"PanSou","modelName":"Web","pubKey":public,"nonce":0,"refreshToken":value["refresh_token"]})),None,
        crate::cloud_drive::extended_headers(Provider::Aliyun,&value.to_string()).map_err(|_|AuthFailure::Protocol)?).await?.0;
    if !scalar(&response["code"]).is_empty() && response["code"] != 0 {
        return Err(oauth_failure(&response));
    }
    ali_device_registered(&response)?;
    Ok(())
}
fn ali_device_registered(response: &Value) -> Result<(), AuthFailure> {
    if response["result"] != true {
        return Err(AuthFailure::Protocol);
    }
    Ok(())
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn decode_biz_ext(bytes: &[u8]) -> Result<Value, AuthFailure> {
    if let Ok(value) = serde_json::from_slice(bytes) {
        return Ok(value);
    }
    let encoding = encoding_rs::Encoding::for_label(b"gb18030").ok_or(AuthFailure::Protocol)?;
    let text = encoding
        .decode_without_bom_handling_and_without_replacement(bytes)
        .ok_or(AuthFailure::Protocol)?;
    serde_json::from_str(&text).map_err(|_| AuthFailure::Protocol)
}

pub async fn qr_image(state: &AppState, p: Provider, url: &str) -> Result<String, AuthFailure> {
    checked_url(url)?;
    if p == Provider::Baidu {
        // Baidu supplies a QR image rather than its encoded payload. Proxy only
        // its exact official host, bounded and never follow redirects.
        let checked = checked_url(url)?;
        if checked.host_str() != Some("passport.baidu.com") {
            return Err(AuthFailure::Protocol);
        }
        let mut response = state
            .cloud_http
            .get(checked)
            .timeout(std::time::Duration::from_secs(12))
            .send()
            .await
            .map_err(|_| AuthFailure::Network)?;
        if !response.status().is_success() {
            return Err(AuthFailure::Protocol);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| AuthFailure::Network)? {
            if bytes.len() + chunk.len() > 256 * 1024 {
                return Err(AuthFailure::Protocol);
            }
            bytes.extend_from_slice(&chunk);
        }
        let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            "image/png"
        } else if bytes.starts_with(b"\xff\xd8\xff") {
            "image/jpeg"
        } else {
            return Err(AuthFailure::Protocol);
        };
        return Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)));
    }
    let qr = qrcode::QrCode::new(url.as_bytes()).map_err(|_| AuthFailure::Protocol)?;
    let svg = qr
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(256, 256)
        .build();
    Ok(format!(
        "data:image/svg+xml;base64,{}",
        STANDARD.encode(svg)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn baidu_states_and_exchange_destinations_are_not_guessed() {
        for n in [json!(0), json!("0")] {
            assert!(matches!(
                baidu_scan(&json!({"errno":n,"channel_v":{"status":"1"}})).unwrap(),
                BaiduScan::Scanned
            ));
        }
        assert!(
            matches!(baidu_scan(&json!({"errno":"0","channel_v":"{\"status\":\"0\",\"v\":\"ticket\"}"})).unwrap(),BaiduScan::Ticket(t) if t=="ticket")
        );
        assert!(matches!(
            baidu_scan(&json!({"errno":0,"channel_v":{"status":2}})).unwrap(),
            BaiduScan::Denied
        ));
        assert!(matches!(
            baidu_scan(&json!({"errno":0,"channel_v":{"status":99}})).unwrap(),
            BaiduScan::Waiting
        ));
        for v in [
            json!({}),
            json!({"errno":0,"channel_v":{}}),
            json!({"errno":0,"channel_v":{"status":0}}),
        ] {
            assert!(baidu_scan(&v).is_err());
        }
        assert_eq!(
            baidu_exchange_url(
                &json!({"errInfo":{"no":"0"},"data":{"u":"https://pan.baidu.com/disk/main"}})
            )
            .unwrap(),
            "https://pan.baidu.com/disk/main"
        );
        for u in [
            "http://pan.baidu.com/",
            "https://pan.baidu.com.evil.test/",
            "https://uop.quark.cn/",
            "https://127.0.0.1/",
            "https://pan.baidu.com:8080/",
        ] {
            assert!(baidu_exchange_url(&json!({"errInfo":{"no":0},"data":{"u":u}})).is_err());
        }
        assert!(
            baidu_exchange_url(&json!({"errInfo":{"no":5},"data":{"u":"https://pan.baidu.com/"}}))
                .is_err()
        );
        assert!(matches!(
            baidu_account_data(&json!({"errno":-6})),
            Err(AuthFailure::Reauthorize)
        ));
        assert!(matches!(
            baidu_account_data(&json!({"errno":0,"result":{}})),
            Err(AuthFailure::Protocol)
        ));
    }
    #[test]
    fn device_registration_and_one_use_exchanges_fail_closed() {
        assert!(ali_device_registered(&json!({"result":true})).is_ok());
        for response in [
            Value::Null,
            json!({"result":false}),
            json!({"success":true}),
            json!({}),
        ] {
            assert!(ali_device_registered(&response).is_err());
        }
        assert!(matches!(
            exchange_failure(AuthFailure::Network),
            AuthFailure::ExchangeUncertain
        ));
        assert!(matches!(
            exchange_failure(AuthFailure::RateLimited),
            AuthFailure::RateLimited
        ));
    }
    #[test]
    fn quark_account_envelope_is_not_the_cas_qr_envelope() {
        let logged_in =
            json!({"success":true,"code":"OK","data":{"uid":"verified-uid","nickname":"Test"}});
        assert_eq!(
            quark_account_data(&logged_in).unwrap()["uid"],
            "verified-uid"
        );
        // The live payload carries display data only and no id at all; it still
        // proves the cookie holds a session, so the envelope must accept it.
        let live = json!({"success":true,"code":"OK",
            "data":{"avatarUri":"x","config":{},"mobilekps":"y","nickname":"Test"}});
        assert_eq!(quark_account_data(&live).unwrap()["nickname"], "Test");
        assert!(quark_identity(quark_account_data(&live).unwrap()).is_none());
        for response in [
            json!({"success":true,"code":"OK","data":[]}),
            json!({"success":true,"code":"OK","data":{}}),
            json!({"success":false,"code":"AUTH_ERROR:50051","data":{"uid":"must-not-trust"}}),
        ] {
            assert!(matches!(
                quark_account_data(&response),
                Err(AuthFailure::Reauthorize)
            ));
        }
        for response in [
            json!({"status":2000000,"data":{"uid":"wrong-envelope"}}),
            json!({"success":false,"code":"SERVER_ERROR"}),
        ] {
            assert!(matches!(
                quark_account_data(&response),
                Err(AuthFailure::Protocol)
            ));
        }
    }
    #[test]
    fn quark_account_id_falls_back_to_the_uid_cookie() {
        // Captured from a real scan: __pus/__kp/__kps/__ktd plus __uid.
        let captured = "__kp=a; __kps=b; __ktd=c; __pus=d; __uid=1234567890; ctoken=e";
        assert_eq!(quark_cookie_uid(captured).as_deref(), Some("1234567890"));
        assert_eq!(
            quark_cookie_uid("__uid=1234567890").as_deref(),
            Some("1234567890")
        );
        // A session without an account cookie, or with a placeholder id, must
        // not be mistaken for an identified account.
        for cookies in ["__pus=d", "", "__uid=", "__uid=0", "other=1"] {
            assert!(quark_cookie_uid(cookies).is_none(), "{cookies}");
        }
    }
    #[test]
    fn quark_identity_is_found_under_the_names_the_live_service_has_used() {
        for data in [
            json!({"uid":"1234567890"}),
            json!({"user_id":"1234567890"}),
            json!({"userId":"1234567890"}),
            json!({"uk":"1234567890"}),
            json!({"sub":"1234567890"}),
            json!({"id":"1234567890"}),
            json!({"user":{"uid":"1234567890"},"pass":true}),
            json!({"member":{"user_id":"1234567890"}}),
            json!({"data":{"userId":"1234567890"}}),
        ] {
            assert_eq!(quark_identity(&data).as_deref(), Some("1234567890"));
        }
        // A payload without an account id must never look like a session, and
        // the placeholder root id "0" is not an identity either.
        for data in [
            json!({}),
            json!({"pass":false}),
            json!({"uid":""}),
            json!({"uid":null}),
            json!({"uid":"0"}),
            json!({"user":{"nickname":"anonymous"}}),
        ] {
            assert!(quark_identity(&data).is_none());
        }
    }
    #[test]
    fn baidu_jsonp_single_quoted_key_is_repaired_but_nothing_else_is() {
        // Captured from passport.baidu.com/v3/login/main/qrbdusslogin: the body
        // is valid JSON except for the one single-quoted `data` key.
        let expired = r#"cb({"errInfo":{"no":"310005","msg":"验证信息已过期"},"code":"310005","message":"x",'data':{"u":"","session":{"version":"v3"},"user":{"userId":""}},"traceid":""})"#;
        let value = parse_json(expired).unwrap();
        assert_eq!(number(&value["errInfo"]["no"]), Some(310005));
        assert_eq!(scalar(&value["data"]["session"]["version"]), "v3");
        assert!(matches!(
            baidu_exchange_url(&value),
            Err(AuthFailure::Protocol)
        ));
        // A successful envelope still resolves, and the URL stays validated.
        let ok = r#"cb({"errInfo":{"no":"0"},"data":{"u":"https://pan.baidu.com/disk/main"}})"#;
        assert_eq!(
            baidu_exchange_url(&parse_json(ok).unwrap()).unwrap(),
            "https://pan.baidu.com/disk/main"
        );
        // The repair never turns something that is not JSON into JSON.
        for text in [
            "evil();pansou({\"errno\":0});",
            "cb({oops})",
            "cb({\"a\": 'unquoted value'})",
            "cb({\"a\": 1",
            "cb({'a' 1})",
            // Valid JavaScript a browser evaluates, never JSON: the login must
            // not depend on parsing this, only on the handed-out session cookie.
            "cb({'data':{\"u\":\"https:\\/\\/pan.baidu.com\\/\",}})",
        ] {
            assert!(parse_json(text).is_none(), "{text}");
        }
    }
    #[test]
    fn jsonp_string_escapes_preserve_values_without_evaluating_code() {
        let response = r#"cb({"errInfo":{"no":"0"},'data':{"u":"https:\/\/pan.baidu.com\/disk\/main?from=scan\x26ok=1","name":"O\'Brien","encoded":"\x22\x5c\x00","literal":"\\x26"}})"#;
        let value = parse_json(response).unwrap();
        assert_eq!(value["data"]["name"], "O'Brien");
        assert_eq!(value["data"]["encoded"], "\"\\\0");
        assert_eq!(value["data"]["literal"], r"\x26");
        assert_eq!(
            baidu_exchange_url(&value).unwrap(),
            "https://pan.baidu.com/disk/main?from=scan&ok=1"
        );
        assert_eq!(
            parse_json(r#"{"literal":"\\x26"}"#).unwrap()["literal"],
            r"\x26"
        );
        for response in [
            r#"cb({'data':{"u":"\xG0"}})"#,
            r#"cb({'data':{"u":"\x2"}})"#,
            r#"cb({'data':{"u":"\uGGGG"}})"#,
            r#"cb({'data':{"u":decodeURIComponent("url")}})"#,
            r#"cb({'data':{'u':'https://pan.baidu.com/'}})"#,
            r#"cb({'data':{"u":"\x22},evil()"})"#,
        ] {
            assert!(parse_json(response).is_none(), "{response}");
        }
    }
    #[test]
    fn jsonp_non_json_escapes_follow_javascript_string_rules() {
        let response = r#"cb({'data':{"u":"https:\/\/pan.baidu.com\/disk\/main\?from\=scan\&ok\=1","identity":"\q\8\9\中","control":"\v\0\123\377\400","literal":"\\&\\v\\0"}})"#;
        let value = parse_json(response).unwrap();
        assert_eq!(
            value["data"]["u"],
            "https://pan.baidu.com/disk/main?from=scan&ok=1"
        );
        assert_eq!(value["data"]["identity"], "q89中");
        assert_eq!(value["data"]["control"], "\u{000b}\0Sÿ 0");
        assert_eq!(value["data"]["literal"], r"\&\v\0");
        assert_eq!(
            parse_json(r#"cb({"value":"\u{1f600}\u{d83d}\u{de00}\u{26}"})"#).unwrap()["value"],
            "😀😀&"
        );
        for response in [
            r#"cb({"value":"\u{}"})"#,
            r#"cb({"value":"\u{110000}"})"#,
            r#"cb({"value":"\u{ZZ}"})"#,
        ] {
            assert!(parse_json(response).is_none());
        }
        for continuation in ["\n", "\r", "\r\n", "\u{2028}", "\u{2029}"] {
            let response = format!("cb({{\"value\":\"a\\{continuation}b\"}})");
            assert_eq!(parse_json(&response).unwrap()["value"], "ab");
        }
        // No JS expressions are executed, even next to otherwise valid escapes.
        assert!(parse_json(r#"cb({'data':{"u":"\&"},"code":alert(1)})"#).is_none());
        assert!(parse_json("cb({\"value\":\"a\\\u{0001}b\"})").is_none());
    }
    #[test]
    fn diagnostic_tokens_are_truncated_before_logging() {
        assert_eq!(truncate("OK", 32), "OK");
        assert_eq!(truncate("AUTH_ERROR:50051", 32), "AUTH_ERROR:50051");
        assert_eq!(truncate(&"x".repeat(100), 32).len(), 32);
    }
    #[test]
    fn token_rotation_keeps_device_identity_and_removes_shadow_headers() {
        let old = json!({"access_token":"old","authorization":"Bearer old","refresh_token":"r1","device_id":"d","user_id":"u"});
        let new = token_update(
            &old,
            &json!({"access_token":"new","refresh_token":"r2","expires_in":3600}),
        )
        .unwrap();
        assert_eq!(new["refresh_token"], "r2");
        assert_eq!(new["device_id"], "d");
        assert!(new.get("authorization").is_none());
        assert!(expires_at(&new.to_string()).unwrap() > Utc::now());
        assert!(token_update(&old, &json!({"error":"invalid_grant"})).is_err());
    }
    #[test]
    fn domains_jsonp_and_account_keys_are_strict() {
        for u in [
            "https://pan.quark.cn.evil.test/",
            "https://user@pan.baidu.com/",
            "http://pan.baidu.com/",
            "https://pan.baidu.com:8443/",
        ] {
            assert!(checked_url(u).is_err());
        }
        assert_eq!(parse_json("pansou({\"errno\":0});").unwrap()["errno"], 0);
        assert!(parse_json("evil();pansou({\"errno\":0});").is_none());
        assert_ne!(
            stable_key(Provider::Aliyun, "u", "a"),
            stable_key(Provider::Aliyun, "u", "b")
        );
    }
    #[test]
    fn ali_business_payload_accepts_utf8_and_gb18030_without_lossy_tokens() {
        let utf8 = r#"{"pds_login_result":{"refreshToken":"r"},"nick":"测试"}"#;
        assert_eq!(decode_biz_ext(utf8.as_bytes()).unwrap()["nick"], "测试");
        let (encoded, _, errors) = encoding_rs::Encoding::for_label(b"gb18030")
            .unwrap()
            .encode(utf8);
        assert!(!errors);
        assert_eq!(
            decode_biz_ext(&encoded).unwrap()["pds_login_result"]["refreshToken"],
            "r"
        );
        assert!(decode_biz_ext(b"\xff\xff").is_err());
    }
    #[test]
    fn provider_owned_hosts_are_allowed_but_lookalikes_are_not() {
        // Redirect hops the official login flows actually take, including the
        // ones a fixed host list used to miss.
        for host in [
            "uop.quark.cn",
            "su.quark.cn",
            "b.quark.cn",
            "pan.quark.cn",
            "passport.baidu.com",
            "pan.baidu.com",
            "wappass.baidu.com",
            "passport.aliyundrive.com",
            "api.aliyundrive.com",
            "account.guangyapan.com",
            "api.guangyapan.com",
            "xluser-ssl.xunlei.com",
        ] {
            assert!(allowed_host(host), "{host} must be reachable");
        }
        for host in [
            "quark.cn.evil.test",
            "evilquark.cn",
            "notbaidu.com",
            "baidu.com.evil.test",
            "guangyapan.com.evil.test",
            "127.0.0.1",
            "",
        ] {
            assert!(!allowed_host(host), "{host} must be rejected");
        }
        // checked_url still pins the scheme and the port.
        assert!(checked_url("https://b.quark.cn/account/info").is_ok());
        assert!(checked_url("http://b.quark.cn/").is_err());
        assert!(checked_url("https://b.quark.cn:8443/").is_err());
    }
    #[test]
    fn guangya_device_qr_targets_the_live_authorisation_host() {
        // The advertised account host answers 404 for this route; the same page
        // is served from the www host.
        let value = json!({
            "device_code": "fixture",
            "verification_uri_complete": "https://account.guangyapan.com/__/auth/device/?client_id=aMe-8VSlkrbQXpUR&scope=user%20profile&user_code=ABCD"
        });
        let url = guangya_verification_url(&value);
        assert_eq!(
            url,
            "https://www.guangyapan.com/__/auth/device/?client_id=aMe-8VSlkrbQXpUR&scope=user%20profile&user_code=ABCD"
        );
        assert!(checked_url(&url).is_ok());
        // Any other host the server advertises is left untouched.
        let other =
            json!({"verification_uri_complete":"https://www.guangyapan.com/authorize?code=x"});
        assert_eq!(
            guangya_verification_url(&other),
            "https://www.guangyapan.com/authorize?code=x"
        );
        // A non-https, empty or missing target is refused instead of shown.
        for bad in [
            json!({"verification_uri_complete":"http://account.guangyapan.com/x"}),
            json!({"verification_uri_complete":""}),
            json!({}),
        ] {
            assert!(guangya_verification_url(&bad).is_empty());
        }
    }
}
