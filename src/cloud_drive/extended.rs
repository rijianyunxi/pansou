//! Native token-authenticated providers; API hosts are fixed and never caller supplied.
//! Credentials, listings, mutations and protocol tests have separate modules.
use super::{
    Context, DriveError, ErrorKind, File, Provider, Reference, ShareInput, scalar, transport::Wire,
    valid_id,
};
use reqwest::{Method, header::HeaderValue};
use serde_json::{Value, json};
use std::{collections::HashSet, time::Duration};
use url::Url;

fn text(value: &Value, names: &[&str]) -> String {
    names
        .iter()
        .map(|n| scalar(&value[*n]))
        .find(|s| !s.is_empty())
        .unwrap_or_default()
}
fn matches_transferred_files(source: &[File], saved: &[File]) -> bool {
    if source.len() != saved.len() {
        return false;
    }
    let mut remaining: Vec<&File> = source.iter().collect();
    for file in saved {
        let compatible = |s: &&File| {
            s.name == file.name
                && s.is_dir == file.is_dir
                && (s.is_dir || s.size == file.size)
                && (s.md5.is_empty() || file.md5.is_empty() || s.md5 == file.md5)
        };
        // Consume each source once. Prefer exact hashes before weaker metadata.
        let index = remaining
            .iter()
            .position(|s| compatible(s) && !file.md5.is_empty() && s.md5 == file.md5)
            .or_else(|| remaining.iter().position(compatible));
        let Some(index) = index else {
            return false;
        };
        remaining.swap_remove(index);
    }
    remaining.is_empty()
}
#[derive(Clone)]
pub(super) struct Extended {
    pub base: Url,
    pub account_base: Url,
    wire: Wire,
    drive_id: String,
    user_id: String,
}
impl Extended {
    pub fn new(wire: Wire, raw: &str) -> Self {
        let host = match wire.provider {
            Provider::Aliyun => "https://api.aliyundrive.com/",
            Provider::Xunlei => "https://x-api-pan.xunlei.com/",
            _ => "https://api.guangyapan.com/",
        };
        let credential = serde_json::from_str::<Value>(raw).unwrap_or_default();
        let account_host = match wire.provider {
            Provider::Xunlei => "https://xluser-ssl.xunlei.com/",
            Provider::Guangya => "https://account.guangyapan.com/",
            _ => host,
        };
        Self {
            base: Url::parse(host).unwrap(),
            account_base: Url::parse(account_host).unwrap(),
            drive_id: text(&credential, &["drive_id", "driveId"]),
            user_id: text(&credential, &["user_id", "userId", "sub"]),
            wire,
        }
    }
    pub async fn verify_account(&self) -> Result<(), DriveError> {
        self.wire.require_login().await?;
        let mut account = self.clone();
        account.base = self.account_base.clone();
        let value = if self.wire.provider == Provider::Aliyun {
            account.post("v2/user/get", json!({}), None, false).await?
        } else {
            // Account endpoints return identity JSON, not the storage business envelope.
            let mut account_wire = self.wire.clone();
            if self.wire.provider == Provider::Guangya {
                account_wire.headers = guangya_auth_headers(&self.wire.snapshot().await)
                    .map_err(|_| self.wire.error(ErrorKind::Login, "设备字段无效"))?;
                // Follow the client's per-request device marker; prefer a supplied
                // marker from the user's own official session when available.
                if !account_wire.headers.contains_key("x-device-sign") {
                    if let Some(device) = account_wire
                        .headers
                        .get("x-device-id")
                        .and_then(|v| v.to_str().ok())
                    {
                        let sign = format!("wdi10.{device}{}", uuid::Uuid::new_v4().simple());
                        account_wire.headers.insert(
                            "x-device-sign",
                            HeaderValue::from_str(&sign)
                                .map_err(|_| self.wire.error(ErrorKind::Login, "设备字段无效"))?,
                        );
                    }
                }
            }
            let raw = account_wire
                .request(
                    Method::GET,
                    self.account_base.join("v1/user/me").unwrap(),
                    None,
                    None,
                    "核实登录账号",
                    false,
                    false,
                )
                .await?;
            serde_json::from_str::<Value>(&raw)
                .map_err(|_| self.wire.error(ErrorKind::Login, "账号响应格式异常"))?
        };
        let code = scalar(&value["code"]);
        let error = scalar(&value["error"]);
        if matches!(
            code.as_str(),
            "AccessTokenInvalid"
                | "AccessTokenExpired"
                | "InvalidAccessToken"
                | "Unauthorized"
                | "401"
                | "403"
        ) || matches!(
            error.as_str(),
            "invalid_token"
                | "invalid_grant"
                | "unauthorized"
                | "unauthenticated"
                | "captcha_required"
        ) {
            self.wire
                .auth_rejected(code != "403" && error != "captcha_required")
                .await;
            return Err(self
                .wire
                .error(ErrorKind::Login, "账号授权已失效或需要额外验证，请重新连接"));
        }
        let actual = text(self.data(&value), &["user_id", "userId", "sub", "id"]);
        if actual.is_empty() {
            return Err(self
                .wire
                .error(ErrorKind::Upstream, "账号响应缺少身份字段，无法核实账号"));
        }
        if actual != self.user_id {
            return Err(self.wire.error(
                ErrorKind::Ownership,
                "令牌所属账号与配置 user_id 不一致，拒绝云端写入或删除",
            ));
        }
        Ok(())
    }
    async fn call(
        &self,
        method: Method,
        path: &str,
        params: &[(&str, String)],
        body: Option<Value>,
        share_token: Option<&str>,
        write: bool,
    ) -> Result<Value, DriveError> {
        let mut url = self.base.join(path).expect("fixed provider path");
        url.query_pairs_mut()
            .extend_pairs(params.iter().map(|(k, v)| (*k, v.as_str())));
        let mut wire = self.wire.clone();
        if let Some(token) = share_token {
            wire.headers.insert(
                "x-share-token",
                HeaderValue::from_str(token)
                    .map_err(|_| wire.error(ErrorKind::Upstream, "分享令牌格式异常"))?,
            );
        }
        let raw = wire
            .request(method, url, None, body.as_ref(), "网盘接口", write, false)
            .await?;
        let value: Value = serde_json::from_str(&raw)
            .map_err(|_| wire.error(ErrorKind::Upstream, "网盘返回非 JSON，不能确认结果"))?;
        if !value.is_object() {
            return Err(wire.error(ErrorKind::Upstream, "网盘响应格式异常"));
        }
        if let Some(code) = value.get("code") {
            let code = scalar(code);
            if code.is_empty() {
                return Err(wire.error(
                    ErrorKind::Upstream,
                    "网盘业务状态格式异常，不能确认操作结果",
                ));
            }
            if code != "0" && !(wire.provider == Provider::Guangya && code == "200") {
                tracing::warn!(provider=%wire.provider.name(), business_code=%code, "token drive call rejected by business code");
                let error = DriveError::from_business_code(wire.provider, &code);
                if error.kind == ErrorKind::Login {
                    wire.auth_rejected(true).await;
                }
                return Err(error);
            }
            // Live-verified 2026-10-05: a missing Guangya share answers HTTP 200
            // `{"code":200,"msg":"分享链接错误"}` with no payload; the pass-through
            // `code` alone must not read as success.
            if wire.provider == Provider::Guangya
                && code == "200"
                && value.get("data").is_none_or(|data| data.is_null())
                && scalar(&value["msg"]) == "分享链接错误"
            {
                return Err(wire.error(ErrorKind::InvalidLink, "分享链接已失效或不存在"));
            }
        } else if wire.provider == Provider::Guangya {
            // Guangya does not use one uniform envelope. Failures carry a `code`
            // (a bad token answers HTTP 401 with code 117), but successful
            // business replies observed against the live service are
            // `{"data":…,"msg":…}` with no code at all. The reference client
            // never inspects a business code and relies on the HTTP status, so a
            // missing code cannot by itself mean failure; `msg` is not checked
            // here either because successful live replies have said both
            // "success" and "ok". Accept the reply only when it actually
            // carries a business payload; a bare `{"msg":…}` stays a hard
            // failure. Only key names are logged, never values.
            let payload = value.get("data").is_some_and(|data| !data.is_null());
            if payload {
                tracing::debug!(
                    top_keys = ?value.as_object().map(|o| o.keys().collect::<Vec<_>>()),
                    "guangya reply carries no business code"
                );
            } else if scalar(&value["msg"]) == "分享链接错误" {
                return Err(wire.error(ErrorKind::InvalidLink, "分享链接已失效或不存在"));
            } else {
                tracing::warn!(
                    top_keys = ?value.as_object().map(|o| o.keys().collect::<Vec<_>>()),
                    "guangya response has no business status"
                );
                return Err(wire.error(
                    ErrorKind::Upstream,
                    "光鸭响应缺少业务状态，不能确认操作结果",
                ));
            }
        }
        if value
            .get("error")
            .is_some_and(|v| !v.is_null() && v != "" && v != 0)
        {
            return Err(wire.error(ErrorKind::Upstream, "网盘操作失败，未确认写入结果"));
        }
        if value.get("success") == Some(&Value::Bool(false)) {
            return Err(wire.error(ErrorKind::Upstream, "网盘明确返回操作失败"));
        }
        Ok(value)
    }
    async fn post(
        &self,
        path: &str,
        body: Value,
        token: Option<&str>,
        write: bool,
    ) -> Result<Value, DriveError> {
        self.call(Method::POST, path, &[], Some(body), token, write)
            .await
    }
    fn data<'a>(&self, value: &'a Value) -> &'a Value {
        if value["data"].is_object() {
            &value["data"]
        } else {
            value
        }
    }
}

/// Does the share id the platform reported belong to the share link it came
/// with? Aliyun and Xunlei echo the link key verbatim. The live guangya
/// `share_file` response (2026-10-03) reports the numeric id while the URL key
/// is `<numeric id>_<suffix>`, so a guangya link key with that prefix belongs
/// to the reported id; anything else is a mismatch worth pausing on.
fn share_id_matches(provider: Provider, id: &str, link_key: &str) -> bool {
    if id == link_key {
        return true;
    }
    provider == Provider::Guangya
        && link_key
            .strip_prefix(id)
            .is_some_and(|rest| rest.starts_with('_') && rest.len() > 1)
}

mod credentials;
mod listing;
mod operations;

pub(super) use credentials::credential_headers;
pub(crate) use credentials::guangya_auth_headers;
pub use credentials::validate_credential;

#[cfg(test)]
mod tests;
