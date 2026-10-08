//! Native cloud-drive operations. No Node subprocess or caller-controlled upstream.
mod baidu;
mod extended;
mod quark;
pub(crate) use extended::guangya_auth_headers;
pub use extended::validate_credential;
pub(crate) fn extended_headers(
    provider: Provider,
    raw: &str,
) -> Result<reqwest::header::HeaderMap, ApiError> {
    extended::credential_headers(provider, raw)
        .map_err(|_| ApiError::BadRequest("凭证请求头格式不正确".into()))
}
#[cfg(test)]
mod tests;
#[cfg(test)]
#[derive(Clone)]
pub struct TestBases {
    pub baidu: url::Url,
    pub quark_pc: url::Url,
    pub quark_share: url::Url,
}
pub mod transport;
use crate::{app::AppState, error::ApiError};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, sync::atomic::Ordering, time::Duration};
use transport::Wire;
use url::Url;
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Baidu,
    Quark,
    Aliyun,
    Xunlei,
    Guangya,
}
impl Provider {
    pub fn name(self) -> &'static str {
        match self {
            Self::Baidu => "baidu",
            Self::Quark => "quark",
            Self::Aliyun => "aliyun",
            Self::Xunlei => "xunlei",
            Self::Guangya => "guangya",
        }
    }
    pub const ALL: [Self; 5] = [
        Self::Baidu,
        Self::Quark,
        Self::Aliyun,
        Self::Xunlei,
        Self::Guangya,
    ];
    pub fn from_name(name: &str) -> Result<Self, ApiError> {
        Self::ALL
            .into_iter()
            .find(|p| p.name() == name)
            .ok_or_else(|| ApiError::BadRequest("不支持的网盘类型".into()))
    }
    pub fn root(self) -> &'static str {
        match self {
            Self::Baidu => "/",
            Self::Aliyun => "root",
            _ => "0",
        }
    }
    pub fn token_auth(self) -> bool {
        !matches!(self, Self::Baidu | Self::Quark)
    }
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    InvalidLink,
    Password,
    Login,
    Verification,
    RateLimit,
    Upstream,
    Network,
    Ownership,
    Limit,
    Input,
}
#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct DriveError {
    pub provider: Provider,
    pub kind: ErrorKind,
    pub message: String,
    pub code: Option<i64>,
    #[serde(skip)]
    pub(crate) retry_after_seconds: Option<i64>,
}
impl DriveError {
    pub fn new(provider: Provider, kind: ErrorKind, message: &str) -> Self {
        Self {
            provider,
            kind,
            message: message.into(),
            code: None,
            retry_after_seconds: None,
        }
    }
    pub fn from_code(provider: Provider, code: i64) -> Self {
        let (kind, message) = match (provider, code) {
            // 41012 arrives on HTTP 404 with a JSON body ("好友已取消了分享");
            // 41011 is the same 404 family for expired share addresses
            // ("分享地址已失效"), live-verified 2026-10-05.
            (Provider::Quark, 41008 | 41011 | 41012) => {
                (ErrorKind::InvalidLink, "夸克分享已失效或被取消")
            }
            // 41010 is the removal notice for content that failed platform
            // review ("文件涉及违规内容"), live-verified 2026-10-05.
            (Provider::Quark, 41010) => (ErrorKind::InvalidLink, "夸克分享因内容违规被取消"),
            (Provider::Quark, 41002 | 41003) => (ErrorKind::Password, "夸克提取码错误或缺失"),
            (Provider::Quark, 31001) => (ErrorKind::Login, "夸克 Cookie 已失效，请重新配置"),
            (Provider::Quark, 31024) => (ErrorKind::RateLimit, "夸克操作过于频繁，请稍后再试"),
            (Provider::Quark, 41017) => (
                ErrorKind::Input,
                "这是当前账号自己的分享，不能再次转存；可使用检测已有资源",
            ),
            // Live-verified 2026-10-03: the share task itself is rejected with
            // 41026 regardless of expiry settings — Quark's content review
            // blocked the files, which no retry or parameter change can lift.
            (Provider::Quark, 41026) => (
                ErrorKind::InvalidLink,
                "夸克拒绝分享：文件未通过平台审核或账号分享受限，请换用其他资源或账号",
            ),
            (Provider::Baidu, -7 | 105) => (ErrorKind::InvalidLink, "百度分享资源已删除或不存在"),
            // Live-verified 2026-10-05: a cancelled share still passes verify
            // and then answers the file list with -21 ("来晚啦，该分享已被取消").
            (Provider::Baidu, -21) => (ErrorKind::InvalidLink, "百度分享已被取消、删除或已过期"),
            (Provider::Baidu, -9 | -1) => {
                (ErrorKind::Password, "百度链接无法验证，请检查链接及提取码")
            }
            (Provider::Baidu, -6) => (ErrorKind::Login, "百度 Cookie 无效或不完整"),
            (Provider::Baidu, -62) => (ErrorKind::RateLimit, "百度操作过于频繁，请稍后再试"),
            (Provider::Baidu, -10) => (ErrorKind::Input, "百度网盘容量不足"),
            (Provider::Baidu, 2) => (ErrorKind::Input, "百度目标目录不存在"),
            (Provider::Baidu, 4) => (ErrorKind::Input, "百度目标目录存在同名文件"),
            _ => (
                ErrorKind::Upstream,
                "网盘返回未识别的业务错误，请检查账号和链接",
            ),
        };
        Self {
            provider,
            kind,
            message: message.into(),
            code: Some(code),
            retry_after_seconds: None,
        }
    }
    /// String business codes from the token providers (Aliyun/Guangya `code`,
    /// Xunlei `error_code`). Live-verified 2026-10-05: a cancelled Aliyun share
    /// answers HTTP 400 with `ShareLink.Cancelled`. Unknown codes stay upstream
    /// so an unmodeled rejection can never mark a link invalid.
    pub fn from_business_code(provider: Provider, code: &str) -> Self {
        let (kind, message) = match code {
            "AccessTokenInvalid"
            | "AccessTokenExpired"
            | "InvalidAccessToken"
            | "Unauthorized"
            | "401"
            | "DeviceSessionSignatureInvalid"
            | "DeviceSessionSignatureOffline"
            | "DeviceSessionNotFound" => (ErrorKind::Login, "网盘授权已失效，请重新连接账号"),
            "ShareLinkNotFound"
            | "ShareLinkExpired"
            | "ShareLinkCancelled"
            | "ShareLink.NotFound"
            | "ShareLink.Expired"
            | "ShareLink.Cancelled" => (ErrorKind::InvalidLink, "分享链接已失效或被取消"),
            "ShareLinkPasswordMismatch" | "InvalidSharePwd" => {
                (ErrorKind::Password, "提取码错误或缺失")
            }
            "TooManyRequests" | "429" => (ErrorKind::RateLimit, "网盘操作过于频繁，请稍后再试"),
            _ => (
                ErrorKind::Upstream,
                "网盘返回未识别的业务错误，请检查账号和链接",
            ),
        };
        Self {
            provider,
            kind,
            message: message.into(),
            code: None,
            retry_after_seconds: None,
        }
    }
    pub fn api(self) -> ApiError {
        match self.kind {
            ErrorKind::Input | ErrorKind::Password | ErrorKind::InvalidLink => {
                ApiError::BadRequest(self.message)
            }
            ErrorKind::Ownership => ApiError::Forbidden(self.message),
            ErrorKind::Login => ApiError::CloudAuthRequired(self.message),
            ErrorKind::Verification => ApiError::CloudAuthRequired(self.message),
            ErrorKind::Limit => ApiError::Unavailable(self.message),
            _ => ApiError::Upstream(self.message),
        }
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareInput {
    pub url: String,
    pub provider: Option<Provider>,
    pub password: Option<String>,
}
#[derive(Clone)]
pub struct Reference {
    pub provider: Provider,
    pub key: String,
    pub password: String,
    pub url: String,
}
impl Reference {
    /// Guangya's web client reads the extraction code from the query string.
    pub fn browser_url(&self) -> String {
        if self.provider != Provider::Guangya {
            return self.url.clone();
        }
        let mut url = Url::parse(&self.url).expect("validated share URL");
        if !self.password.is_empty() {
            url.query_pairs_mut().append_pair("code", &self.password);
        }
        url.set_fragment(Some("/share"));
        url.to_string()
    }
}
impl ShareInput {
    pub fn parse(&self) -> Result<Reference, ApiError> {
        if self.url.len() > 4096 {
            return Err(ApiError::BadRequest("分享链接过长".into()));
        }
        let url = Url::parse(self.url.trim())
            .map_err(|_| ApiError::BadRequest("请输入支持网盘的完整分享链接".into()))?;
        if !matches!(url.scheme(), "https" | "http")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
        {
            return Err(ApiError::BadRequest(
                "不允许链接带账号、端口或非 HTTP 协议".into(),
            ));
        }
        let provider = match url.host_str() {
            Some("pan.baidu.com") => Provider::Baidu,
            Some("pan.quark.cn") => Provider::Quark,
            Some("alipan.com" | "www.alipan.com" | "aliyundrive.com" | "www.aliyundrive.com") => {
                Provider::Aliyun
            }
            Some("pan.xunlei.com") => Provider::Xunlei,
            Some("guangyapan.com" | "www.guangyapan.com") => Provider::Guangya,
            _ => {
                return Err(ApiError::BadRequest(
                    "仅支持百度、夸克、阿里、迅雷和光鸭的官方分享链接".into(),
                ));
            }
        };
        if self.provider.is_some_and(|p| p != provider) {
            return Err(ApiError::BadRequest("网盘类型与分享域名不一致".into()));
        }
        let path = url.path().trim_end_matches('/');
        let mut key = if let Some(key) = path.strip_prefix("/s/") {
            key.to_owned()
        } else if provider == Provider::Baidu && path == "/share/init" {
            url.query_pairs()
                .find(|(k, _)| k == "surl")
                .map(|(_, v)| v.into_owned())
                .unwrap_or_default()
        } else {
            String::new()
        };
        if provider == Provider::Baidu && path.starts_with("/s/") {
            key = key.strip_prefix('1').unwrap_or(&key).to_owned();
        }
        if key.is_empty()
            || key.len() > 128
            || !key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err(ApiError::BadRequest("分享标识格式不正确".into()));
        }
        let password = self
            .password
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim().to_owned())
            .or_else(|| {
                url.query_pairs()
                    .find(|(k, _)| k == "pwd" || k == "passcode" || k == "code" || k == "password")
                    .map(|(_, v)| v.into_owned())
            })
            .unwrap_or_default();
        if password.len() > 64 || password.chars().any(char::is_control) {
            return Err(ApiError::BadRequest("提取码格式不正确".into()));
        }
        let canonical = match provider {
            Provider::Baidu => format!("https://pan.baidu.com/s/1{key}"),
            Provider::Quark => format!("https://pan.quark.cn/s/{key}"),
            Provider::Aliyun => format!("https://www.alipan.com/s/{key}"),
            Provider::Xunlei => format!("https://pan.xunlei.com/s/{key}"),
            Provider::Guangya => format!("https://www.guangyapan.com/s/{key}"),
        };
        Ok(Reference {
            provider,
            key,
            password,
            url: canonical,
        })
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct File {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub is_dir: bool,
    #[serde(default)]
    pub md5: String,
    #[serde(default)]
    pub path: String,
    #[serde(skip)]
    pub token: String,
}
#[derive(Clone)]
pub struct Context {
    pub reference: Reference,
    pub title: String,
    pub files: Vec<File>,
    pub token: String,
    pub owner: String,
    pub share_id: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveInput {
    #[serde(flatten)]
    pub link: ShareInput,
    pub to_dir: Option<String>,
    #[serde(default = "yes")]
    pub auto_share: bool,
    #[serde(default)]
    pub dedup: bool,
    pub request_key: String,
}
fn yes() -> bool {
    true
}
#[derive(Clone)]
pub struct Drive {
    pub wire: Wire,
    baidu: baidu::Baidu,
    quark: quark::Quark,
    extended: extended::Extended,
    pub account: String,
    managed: Option<(AppState, i64, i64)>,
}
impl Drive {
    pub async fn load(state: &AppState, provider: Provider) -> Result<Self, ApiError> {
        let Some(account) = crate::cloud_auth::credentials(state, provider).await? else {
            return Ok(Self::from_state(state, provider, String::new()));
        };
        let mut drive = Self::from_state(state, provider, account.credential.clone());
        if let Some(key) = account.account_key {
            drive.account = key;
            drive.managed = Some((state.clone(), account.binding_epoch, account.token_revision));
            drive.wire.bind_cookies(
                state.pool.clone(),
                account.binding_epoch,
                account.token_revision,
            );
        }
        Ok(drive)
    }
    /// Call under the provider advisory lock, before any mutating upstream request.
    pub async fn ensure_current_account(
        &self,
        connection: &mut sqlx::PgConnection,
    ) -> Result<(), ApiError> {
        use sqlx::Row;
        let row=sqlx::query("SELECT credential,account_key,binding_epoch,token_revision,auth_status FROM cloud_account_settings WHERE provider=$1").bind(self.wire.provider.name()).fetch_optional(connection).await?;
        // Mirror `cloud_auth::credentials`: an unconfigured row (empty
        // credential) serves the anonymous drive no matter what account_key a
        // previous connection left behind. Comparing against that stale key
        // made every anonymous delivery conflict until its deadline expired.
        let current = row.as_ref().map(|r| {
            if r.get::<String, _>("credential").trim().is_empty() {
                return credential_fingerprint(self.wire.provider, "");
            }
            r.get::<Option<String>, _>("account_key")
                .unwrap_or_else(|| {
                    credential_fingerprint(self.wire.provider, &r.get::<String, _>("credential"))
                })
        });
        if current.as_ref() != Some(&self.account)
            || self.managed.as_ref().is_some_and(|(_, epoch, _)| {
                row.as_ref()
                    .is_none_or(|r| r.get::<i64, _>("binding_epoch") != *epoch)
            })
        {
            return Err(ApiError::Conflict(
                "等待期间网盘登录态已变化，未执行写操作；请重新检测或预检".into(),
            ));
        }
        if self.managed.as_ref().is_some_and(|(_, _, revision)| {
            self.wire.provider.token_auth()
                && row
                    .as_ref()
                    .is_some_and(|r| r.get::<i64, _>("token_revision") != *revision)
        }) {
            return Err(ApiError::Unavailable(
                "网盘凭证已更新，稍后重试当前任务".into(),
            ));
        }
        if row
            .as_ref()
            .is_some_and(|r| r.get::<String, _>("auth_status") == "reauthorization_required")
        {
            return Err(ApiError::CloudAuthRequired(
                "网盘需要重新授权，未执行写操作".into(),
            ));
        }
        if let Some((state, _, _)) = &self.managed {
            if !self.wire.provider.token_auth() {
                crate::cloud_auth::verify_binding_identity(
                    state,
                    self.wire.provider,
                    &self.wire.snapshot().await,
                    &self.account,
                )
                .await?;
            }
        }
        // Identity verification fences cloud writes. An anonymous drive never
        // writes (require_login rejects it at the write call), so refusing it
        // here would only block the read-only validity check that runs first.
        if self.managed.is_some() && self.wire.provider.token_auth() {
            self.extended.verify_account().await.map_err(|error| {
                if error.kind == ErrorKind::Ownership {
                    ApiError::Conflict(error.message)
                } else {
                    error.api()
                }
            })?;
        }
        Ok(())
    }
    pub fn from_state(state: &AppState, provider: Provider, cookie: String) -> Self {
        let drive = Self::new(state.cloud_http.clone(), provider, cookie);
        #[cfg(test)]
        let drive = {
            let mut drive = drive;
            if let Some(bases) = &state.cloud_test_bases {
                drive.baidu.base = bases.baidu.clone();
                drive.quark.pc_base = bases.quark_pc.clone();
                drive.quark.share_base = bases.quark_share.clone();
                drive.extended.base = bases.baidu.clone();
                drive.extended.account_base = bases.baidu.clone();
            }
            drive
        };
        drive
    }
    pub fn new(http: reqwest::Client, provider: Provider, cookie: String) -> Self {
        let account = credential_fingerprint(provider, &cookie);
        let wire = Wire::new(http, provider, cookie.clone());
        Self {
            baidu: baidu::Baidu::new(wire.clone()),
            quark: quark::Quark::new(wire.clone()),
            extended: extended::Extended::new(wire.clone(), &cookie),
            wire,
            account,
            managed: None,
        }
    }
    pub async fn resolve(&self, reference: &Reference) -> Result<Context, DriveError> {
        let context = match reference.provider {
            Provider::Baidu => self.baidu.resolve(reference).await?,
            Provider::Quark => self.quark.resolve(reference).await?,
            _ => self.extended.resolve(reference).await?,
        };
        self.validate_context(context)
    }
    fn validate_context(&self, context: Context) -> Result<Context, DriveError> {
        if context
            .files
            .iter()
            .map(|f| &f.id)
            .collect::<HashSet<_>>()
            .len()
            != context.files.len()
        {
            return Err(self.wire.error(
                ErrorKind::Upstream,
                "分享列表包含重复 ID，拒绝不完整或重复操作",
            ));
        }
        Ok(context)
    }
    /// Reuse only Baidu's public share identity. Read the current file list and
    /// validate it on every attempt so changed membership cannot be transferred
    /// from an old snapshot. No share/session tokens are cached.
    pub async fn resolve_cached(
        &self,
        reference: &Reference,
        cached: Option<&Value>,
    ) -> Result<Context, DriveError> {
        if self.wire.provider == Provider::Baidu {
            if let Some(cached) = cached {
                let share_id = scalar(&cached["shareId"]);
                let owner = scalar(&cached["owner"]);
                let numeric =
                    |value: &str| !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit());
                if numeric(&share_id) && numeric(&owner) {
                    let sekey = self.baidu.verify_share(reference).await?;
                    let context = self
                        .baidu
                        .resolve_identity(reference, sekey, share_id, owner)
                        .await?;
                    return self.validate_context(context);
                }
            }
        }
        self.resolve(reference).await
    }
    pub async fn list(&self, dir: &str) -> Result<Vec<File>, DriveError> {
        match self.wire.provider {
            Provider::Baidu => self.baidu.list(dir).await,
            Provider::Quark => self.quark.list(dir).await,
            _ => self.extended.list(dir).await,
        }
    }
    pub async fn share(&self, files: &[File]) -> Result<Value, DriveError> {
        match self.wire.provider {
            Provider::Baidu => self.baidu.share(files).await,
            Provider::Quark => self.quark.share(files).await,
            _ => self.extended.share(files, 7).await,
        }
    }
    pub async fn begin_temporary_share(
        &self,
        files: &[File],
        days: u32,
    ) -> Result<Value, DriveError> {
        match self.wire.provider {
            Provider::Baidu => self.baidu.share_days(files, days).await,
            Provider::Quark => self.quark.begin_share(files, days).await,
            _ => self.extended.share(files, days).await,
        }
    }
    pub async fn finish_temporary_share(&self, share: &Value) -> Result<Value, DriveError> {
        match self.wire.provider {
            Provider::Baidu | Provider::Aliyun | Provider::Xunlei | Provider::Guangya => {
                Ok(share.clone())
            }
            Provider::Quark => {
                self.quark
                    .finish_share(share["shareId"].as_str().unwrap_or(""))
                    .await
            }
        }
    }
    pub async fn create_directory(&self, parent: &str, name: &str) -> Result<File, DriveError> {
        if !name.starts_with("pansou-")
            || name
                .chars()
                .any(|c| !(c.is_ascii_alphanumeric() || c == '-'))
        {
            return Err(self.wire.error(ErrorKind::Input, "非法工作目录名称"));
        }
        match self.wire.provider {
            Provider::Baidu => self.baidu.create_directory(parent, name).await,
            Provider::Quark => self.quark.create_directory(parent, name).await,
            _ => self.extended.create_directory(parent, name).await,
        }
    }
    pub async fn revoke_share(&self, id: &str) -> Result<(), DriveError> {
        if !valid_id(id, false) {
            return Err(self.wire.error(ErrorKind::Input, "分享ID无效"));
        }
        match self.wire.provider {
            Provider::Baidu => self.baidu.revoke_share(id).await,
            Provider::Quark => self.quark.revoke_share(id).await,
            _ => self.extended.revoke_share(id).await,
        }
    }
    pub async fn transfer(&self, context: &Context, dir: &str) -> Result<Vec<String>, DriveError> {
        match self.wire.provider {
            Provider::Baidu => self.baidu.save(context, &context.files, dir).await,
            Provider::Quark => self.quark.save(context, &context.files, dir).await,
            _ => self.extended.transfer(context, dir).await,
        }
    }
    /// Reuse the listing already checked by providers that confirm transfers via list.
    pub async fn transfer_with_listing(
        &self,
        context: &Context,
        dir: &str,
    ) -> Result<(Vec<String>, Option<Vec<File>>), DriveError> {
        match self.wire.provider {
            Provider::Baidu | Provider::Quark => {
                self.transfer(context, dir).await.map(|ids| (ids, None))
            }
            _ => self.extended.transfer_with_listing(context, dir).await,
        }
    }
    pub async fn owned(&self, context: &Context) -> Result<(), DriveError> {
        match self.wire.provider {
            Provider::Baidu => self.baidu.owned(context).await,
            Provider::Quark => self.quark.owned(context).await,
            _ => Err(self.wire.error(
                ErrorKind::Ownership,
                "该平台的公开分享不作为删除归属证明；仅清理本流程创建的产物",
            )),
        }
    }
    pub async fn delete_files(&self, files: &[File]) -> Result<(), DriveError> {
        match self.wire.provider {
            Provider::Baidu => self.baidu.delete(files).await,
            Provider::Quark => self.quark.delete(files).await,
            _ => self.extended.delete(files).await,
        }
    }
    pub async fn check(&self, reference: &Reference) -> Value {
        match tokio::time::timeout(Duration::from_secs(45), self.resolve(reference)).await {
            Ok(Ok(ctx)) if ctx.files.is_empty() => {
                json!({"provider":reference.provider,"valid":false,"status":"invalid","reason":"分享中已无可用资源","reasonCode":"resource_missing","fileCount":0,"files":[]})
            }
            Ok(Ok(ctx)) => {
                json!({"provider":reference.provider,"valid":true,"status":"valid","title":ctx.title,"fileCount":ctx.files.len(),"files":ctx.files,"timings":self.wire.trace.lock().await.clone()})
            }
            other => {
                let error = match other {
                    Ok(Err(e)) => e,
                    _ => self
                        .wire
                        .error(ErrorKind::Network, "检测超时，未判定链接失效"),
                };
                json!({"provider":reference.provider,"valid":false,"status":if error.kind==ErrorKind::InvalidLink{"invalid"}else{"unknown"},"reason":error.message,"errorKind":error.kind,"code":error.code,"fileCount":0,"files":[],"timings":self.wire.trace.lock().await.clone()})
            }
        }
    }
    pub async fn save(
        &self,
        input: &SaveInput,
        reference: &Reference,
    ) -> Result<Value, DriveError> {
        self.wire.require_login().await?;
        let dir = validate_dir(reference.provider, input.to_dir.as_deref())
            .map_err(|_| self.wire.error(ErrorKind::Input, "目标目录格式不正确"))?;
        let context = self.resolve(reference).await?;
        if context.files.is_empty() {
            return Err(self.wire.error(ErrorKind::Input, "分享目录为空"));
        }
        let mine = if input.dedup || input.auto_share {
            self.list(&dir).await?
        } else {
            vec![]
        };
        let (matched, missing) = if input.dedup {
            match_existing(reference.provider, &context.files, &mine)
        } else {
            (vec![], context.files.clone())
        };
        let mut saved_ids = vec![];
        if !missing.is_empty() {
            saved_ids = match reference.provider {
                Provider::Baidu => self.baidu.save(&context, &missing, &dir).await?,
                Provider::Quark => self.quark.save(&context, &missing, &dir).await?,
                _ => {
                    let mut partial = context.clone();
                    partial.files = missing.clone();
                    self.extended.transfer(&partial, &dir).await?
                }
            };
        }
        let mut share = Value::Null;
        let mut share_error = None;
        if input.auto_share {
            let result = async {
                let mut targets = matched.clone();
                if !missing.is_empty() {
                    let after = self.list(&dir).await?;
                    let previous: HashSet<_> = mine.iter().map(|f| &f.id).collect();
                    for wanted in &missing {
                        let candidates = after
                            .iter()
                            .filter(|f| {
                                !previous.contains(&f.id)
                                    && (saved_ids.contains(&f.id) || f.name == wanted.name)
                                    && f.is_dir == wanted.is_dir
                                    && f.size == wanted.size
                            })
                            .collect::<Vec<_>>();
                        if candidates.len() != 1 {
                            return Err(self.wire.error(
                                ErrorKind::Upstream,
                                "转存已完成，但新文件身份无法唯一确认，未自动创建分享",
                            ));
                        }
                        targets.push(candidates[0].clone());
                    }
                }
                if targets.iter().map(|f| &f.id).collect::<HashSet<_>>().len() != targets.len() {
                    return Err(self.wire.error(
                        ErrorKind::Upstream,
                        "新文件映射重复，转存已完成但未自动创建分享",
                    ));
                }
                self.share(&targets).await
            }
            .await;
            match result {
                Ok(v) => share = v,
                Err(e) => share_error = Some(e.message),
            }
        }
        Ok(
            json!({"provider":reference.provider,"mode":if missing.is_empty(){"reused"}else{"saved"},"saved":!missing.is_empty(),"count":missing.len(),"files":missing.len(),"target":dir,"names":context.files.iter().map(|f|&f.name).collect::<Vec<_>>(),"alreadyExists":!matched.is_empty(),"matchedCount":matched.len(),"missingCount":missing.len(),"share":share,"shareError":share_error,"timings":self.wire.trace.lock().await.clone()}),
        )
    }
    pub fn wrote(&self) -> bool {
        self.wire.wrote.load(Ordering::SeqCst)
    }
}
pub fn credential_fingerprint(provider: Provider, cookie: &str) -> String {
    if provider.token_auth()
        && let Ok(value) = serde_json::from_str::<Value>(cookie)
        && let Some(user) = ["user_id", "userId", "sub"]
            .iter()
            .map(|key| scalar(&value[*key]))
            .find(|id| valid_id(id, false))
    {
        let drive = if provider == Provider::Aliyun {
            scalar(&value["drive_id"])
        } else {
            String::new()
        };
        let drive = if provider == Provider::Aliyun && drive.is_empty() {
            scalar(&value["driveId"])
        } else {
            drive
        };
        return format!(
            "{:x}",
            Sha256::digest(format!("{}:account:{user}:drive:{drive}", provider.name()))
        );
    }
    format!(
        "{:x}",
        Sha256::digest(format!("{}:{cookie}", provider.name()))
    )
}
pub fn validate_dir(provider: Provider, dir: Option<&str>) -> Result<String, ApiError> {
    let dir = dir.filter(|s| !s.is_empty()).unwrap_or(provider.root());
    if provider != Provider::Baidu {
        if !valid_id(dir, true) {
            return Err(ApiError::BadRequest("目标目录必须是文件夹 ID".into()));
        }
    } else if !dir.starts_with('/')
        || dir.len() > 1024
        || dir.split('/').any(|s| s == ".." || s == ".")
        || dir.contains('\\')
        || dir.chars().any(char::is_control)
    {
        return Err(ApiError::BadRequest("百度目标目录必须为绝对路径".into()));
    }
    Ok(dir.into())
}
pub fn valid_id(id: &str, root: bool) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && (root || id != "0")
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
pub fn scalar(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}
pub fn list_field<'a>(
    payload: &'a Value,
    path: &str,
    wire: &Wire,
) -> Result<&'a Vec<Value>, DriveError> {
    payload
        .pointer(path)
        .and_then(Value::as_array)
        .ok_or_else(|| wire.error(ErrorKind::Upstream, "网盘未返回预期文件列表"))
}
pub fn match_existing(provider: Provider, files: &[File], mine: &[File]) -> (Vec<File>, Vec<File>) {
    let mut matched = vec![];
    let mut missing = vec![];
    for file in files {
        let hash_hits = if provider == Provider::Baidu && !file.md5.is_empty() {
            mine.iter()
                .filter(|own| !file.is_dir && !own.is_dir && file.md5 == own.md5)
                .collect::<Vec<_>>()
        } else {
            vec![]
        };
        let candidates = if !hash_hits.is_empty() {
            hash_hits
        } else {
            mine.iter()
                .filter(|own| {
                    !file.is_dir
                        && !own.is_dir
                        && file.name.trim() == own.name.trim()
                        && file.size == own.size
                        && (provider != Provider::Baidu
                            || file.md5.is_empty()
                            || own.md5.is_empty())
                })
                .collect::<Vec<_>>()
        };
        if candidates.len() == 1 {
            matched.push(candidates[0].clone());
        } else {
            missing.push(file.clone());
        }
    }
    (matched, missing)
}
