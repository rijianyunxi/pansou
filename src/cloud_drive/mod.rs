//! Native Baidu/Quark share operations. No Node subprocess, no caller-controlled upstream.
mod baidu;
mod quark;
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
}
impl Provider {
    pub fn name(self) -> &'static str {
        match self {
            Self::Baidu => "baidu",
            Self::Quark => "quark",
        }
    }
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    InvalidLink,
    Password,
    Login,
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
}
impl DriveError {
    pub fn new(provider: Provider, kind: ErrorKind, message: &str) -> Self {
        Self {
            provider,
            kind,
            message: message.into(),
            code: None,
        }
    }
    pub fn from_code(provider: Provider, code: i64) -> Self {
        let (kind, message) = match (provider, code) {
            (Provider::Quark, 41008) => (ErrorKind::InvalidLink, "夸克分享已失效或被取消"),
            (Provider::Quark, 41002 | 41003) => (ErrorKind::Password, "夸克提取码错误或缺失"),
            (Provider::Quark, 31001) => (ErrorKind::Login, "夸克 Cookie 已失效，请重新配置"),
            (Provider::Quark, 31024) => (ErrorKind::RateLimit, "夸克操作过于频繁，请稍后再试"),
            (Provider::Quark, 41017) => (
                ErrorKind::Input,
                "这是当前账号自己的分享，不能再次转存；可使用检测已有资源",
            ),
            (Provider::Baidu, -7 | 105) => (ErrorKind::InvalidLink, "百度分享资源已删除或不存在"),
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
        }
    }
    pub fn api(self) -> ApiError {
        match self.kind {
            ErrorKind::Input | ErrorKind::Password | ErrorKind::InvalidLink => {
                ApiError::BadRequest(self.message)
            }
            ErrorKind::Ownership => ApiError::Forbidden(self.message),
            ErrorKind::Login => ApiError::BadRequest(self.message),
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
impl ShareInput {
    pub fn parse(&self) -> Result<Reference, ApiError> {
        if self.url.len() > 4096 {
            return Err(ApiError::BadRequest("分享链接过长".into()));
        }
        let url = Url::parse(self.url.trim())
            .map_err(|_| ApiError::BadRequest("请输入完整的百度或夸克分享链接".into()))?;
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
            _ => {
                return Err(ApiError::BadRequest(
                    "仅支持 pan.baidu.com 和 pan.quark.cn 的分享链接".into(),
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
                    .find(|(k, _)| k == "pwd" || k == "passcode")
                    .map(|(_, v)| v.into_owned())
            })
            .unwrap_or_default();
        if password.len() > 64 || password.chars().any(char::is_control) {
            return Err(ApiError::BadRequest("提取码格式不正确".into()));
        }
        let canonical = match provider {
            Provider::Baidu => format!("https://pan.baidu.com/s/1{key}"),
            Provider::Quark => format!("https://pan.quark.cn/s/{key}"),
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
    pub account: String,
}
impl Drive {
    pub async fn load(state: &AppState, provider: Provider) -> Result<Self, ApiError> {
        let cookie = sqlx::query_scalar::<_, String>(
            "SELECT credential FROM cloud_account_settings WHERE provider=$1",
        )
        .bind(provider.name())
        .fetch_optional(&state.pool)
        .await?
        .unwrap_or_default();
        Ok(Self::from_state(state, provider, cookie))
    }
    /// Call under the provider advisory lock, before any mutating upstream request.
    pub async fn ensure_current_account(
        &self,
        connection: &mut sqlx::PgConnection,
    ) -> Result<(), ApiError> {
        let cookie = sqlx::query_scalar::<_, String>(
            "SELECT credential FROM cloud_account_settings WHERE provider=$1",
        )
        .bind(self.wire.provider.name())
        .fetch_optional(connection)
        .await?
        .unwrap_or_default();
        if credential_fingerprint(self.wire.provider, &cookie) != self.account {
            return Err(ApiError::Conflict(
                "等待期间网盘登录态已变化，未执行写操作；请重新检测或预检".into(),
            ));
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
            }
            drive
        };
        drive
    }
    pub fn new(http: reqwest::Client, provider: Provider, cookie: String) -> Self {
        let account = credential_fingerprint(provider, &cookie);
        let wire = Wire::new(http, provider, cookie);
        Self {
            baidu: baidu::Baidu::new(wire.clone()),
            quark: quark::Quark::new(wire.clone()),
            wire,
            account,
        }
    }
    pub async fn resolve(&self, reference: &Reference) -> Result<Context, DriveError> {
        let context = match reference.provider {
            Provider::Baidu => self.baidu.resolve(reference).await?,
            Provider::Quark => self.quark.resolve(reference).await?,
        };
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
    pub async fn list(&self, dir: &str) -> Result<Vec<File>, DriveError> {
        match self.wire.provider {
            Provider::Baidu => self.baidu.list(dir).await,
            Provider::Quark => self.quark.list(dir).await,
        }
    }
    pub async fn share(&self, files: &[File]) -> Result<Value, DriveError> {
        match self.wire.provider {
            Provider::Baidu => self.baidu.share(files).await,
            Provider::Quark => self.quark.share(files).await,
        }
    }
    pub async fn owned(&self, context: &Context) -> Result<(), DriveError> {
        match self.wire.provider {
            Provider::Baidu => self.baidu.owned(context).await,
            Provider::Quark => self.quark.owned(context).await,
        }
    }
    pub async fn delete_files(&self, files: &[File]) -> Result<(), DriveError> {
        match self.wire.provider {
            Provider::Baidu => self.baidu.delete(files).await,
            Provider::Quark => self.quark.delete(files).await,
        }
    }
    pub async fn check(&self, reference: &Reference) -> Value {
        match tokio::time::timeout(Duration::from_secs(45), self.resolve(reference)).await {
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
    format!(
        "{:x}",
        Sha256::digest(format!("{}:{cookie}", provider.name()))
    )
}
pub fn validate_dir(provider: Provider, dir: Option<&str>) -> Result<String, ApiError> {
    let dir = dir
        .filter(|s| !s.is_empty())
        .unwrap_or(if provider == Provider::Quark {
            "0"
        } else {
            "/"
        });
    if provider == Provider::Quark {
        if !valid_id(dir, true) {
            return Err(ApiError::BadRequest(
                "夸克目标目录必须是 fid，根目录填 0".into(),
            ));
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
