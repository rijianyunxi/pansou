use super::{DriveError, ErrorKind, Provider};
use reqwest::{
    Client, Method,
    header::{COOKIE, SET_COOKIE},
};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicI64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use url::Url;

const MAX_BODY: usize = 8 * 1024 * 1024;
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
#[derive(Clone, Serialize)]
pub struct Timing {
    pub step: String,
    pub ms: u128,
}
#[derive(Clone)]
pub struct Wire {
    pub client: Client,
    pub provider: Provider,
    cookie: Arc<Mutex<String>>,
    pub trace: Arc<Mutex<Vec<Timing>>>,
    pub wrote: Arc<AtomicBool>,
    pub headers: reqwest::header::HeaderMap,
    pub write_deadline_ms: Arc<AtomicI64>,
    pub confirmed_file_ids: Arc<Mutex<Vec<String>>>,
    binding: Arc<std::sync::OnceLock<CookieBinding>>,
}
struct CookieBinding { pool:sqlx::PgPool, epoch:i64, revision:AtomicI64 }
impl Wire {
    pub fn new(client: Client, provider: Provider, cookie: String) -> Self {
        let headers = if provider.token_auth() { super::extended::credential_headers(provider, &cookie).unwrap_or_default() } else { Default::default() };
        Self {
            client,
            provider,
            cookie: Arc::new(Mutex::new(cookie)),
            trace: Arc::new(Mutex::new(vec![])),
            wrote: Arc::new(AtomicBool::new(false)),
            headers,
            write_deadline_ms: Arc::new(AtomicI64::new(0)),
            confirmed_file_ids: Arc::new(Mutex::new(vec![])),
            binding:Arc::new(std::sync::OnceLock::new()),
        }
    }
    pub fn bind_cookies(&self,pool:sqlx::PgPool,epoch:i64,revision:i64){let _=self.binding.set(CookieBinding{pool,epoch,revision:AtomicI64::new(revision)});}
    pub async fn snapshot(&self)->String{self.cookie.lock().await.clone()}
    pub async fn auth_rejected(&self,can_refresh:bool){
        if let Some(b)=self.binding.get(){
            let _=sqlx::query("UPDATE cloud_account_settings SET auth_status=CASE WHEN refreshable AND $4 THEN 'degraded' ELSE 'reauthorization_required' END,last_error_code=CASE WHEN refreshable AND $4 THEN 'access_rejected' ELSE 'reauthorization_required' END,expires_at=CASE WHEN refreshable AND $4 THEN now() ELSE expires_at END,next_check_at=now() WHERE provider=$1 AND binding_epoch=$2 AND token_revision=$3 AND refresh_lease IS NULL").bind(self.provider.name()).bind(b.epoch).bind(b.revision.load(Ordering::SeqCst)).bind(can_refresh).execute(&b.pool).await;
        }
    }
    pub async fn cookie_value(&self, key: &str) -> String {
        cookie_value(&*self.cookie.lock().await, key)
    }
    pub async fn require_login(&self) -> Result<(), DriveError> {
        let cookie = self.cookie.lock().await;
        if cookie.trim().is_empty() {
            return Err(self.error(ErrorKind::Login, "请先在后台“网盘账号”菜单连接账号"));
        }
        if self.provider.token_auth() {
            super::validate_credential(self.provider, &cookie)
                .map_err(|_| self.error(ErrorKind::Login, "请配置有效的访问令牌和设备凭据"))?;
        }
        if self.provider == Provider::Baidu
            && ((cookie_value(&cookie, "BDUSS").is_empty()
                && cookie_value(&cookie, "BDUSS_BFESS").is_empty())
                || cookie_value(&cookie, "BAIDUID").is_empty())
        {
            return Err(self.error(
                ErrorKind::Login,
                "百度 Cookie 缺少 BDUSS/BDUSS_BFESS 或 BAIDUID",
            ));
        }
        Ok(())
    }
    pub fn error(&self, kind: ErrorKind, message: &str) -> DriveError {
        DriveError::new(self.provider, kind, message)
    }
    pub async fn request(
        &self,
        method: Method,
        url: Url,
        form: Option<&[(String, String)]>,
        json: Option<&Value>,
        step: &str,
        write: bool,
        text: bool,
    ) -> Result<String, DriveError> {
        let start = Instant::now();
        let result = self
            .request_inner(method, url, form, json, write, text)
            .await;
        self.trace.lock().await.push(Timing {
            step: step.into(),
            ms: start.elapsed().as_millis(),
        });
        result
    }
    async fn request_inner(
        &self,
        method: Method,
        url: Url,
        form: Option<&[(String, String)]>,
        json: Option<&Value>,
        write: bool,
        text: bool,
    ) -> Result<String, DriveError> {
        let referer = match self.provider {
            Provider::Quark => "https://pan.quark.cn/",
            Provider::Baidu => "https://pan.baidu.com/disk/main",
            Provider::Aliyun => "https://www.alipan.com/",
            Provider::Xunlei => "https://pan.xunlei.com/",
            Provider::Guangya => "https://www.guangyapan.com/",
        };
        let mut request = self
            .client
            .request(method, url)
            .header("User-Agent", UA)
            .header("Referer", referer)
            .header(
                "Accept",
                if text {
                    "text/html"
                } else {
                    "application/json"
                },
            )
            .header("X-Requested-With", "XMLHttpRequest");
        request = request.headers(self.headers.clone());
        let cookie = self.cookie.lock().await.clone();
        if !cookie.is_empty() && !self.provider.token_auth() {
            request = request.header(COOKIE, cookie);
        }
        if self.provider == Provider::Quark {
            request = request.header("Origin", "https://pan.quark.cn");
        } else if self.provider == Provider::Guangya {
            request = request.header("Origin", "https://www.guangyapan.com");
        }
        if let Some(form) = form {
            request = request.form(form);
        }
        if let Some(json) = json {
            request = request.json(json);
        }
        if write {
            let deadline = self.write_deadline_ms.load(Ordering::SeqCst);
            if deadline > 0 && chrono::Utc::now().timestamp_millis() >= deadline {
                return Err(self.error(ErrorKind::Limit, "取链已超时，未继续执行新的网盘写操作"));
            }
            self.wrote.store(true, Ordering::SeqCst);
        }
        let mut response = request.send().await.map_err(|e| {
            // without_url strips paths and query strings; only the failure class
            // (timeout/connect/body) is logged, never credentials or URLs.
            tracing::warn!(provider=%self.provider.name(), error=%e.without_url(), "cloud drive request failed");
            self.error(
                ErrorKind::Network,
                "网盘请求超时或连接失败；写操作结果可能未确认，请勿重复提交",
            )
        })?;
        let status = response.status();
        if status.is_redirection() {
            return Err(self.error(
                ErrorKind::Login,
                "网盘返回跳转，请检查登录态；为保护 Cookie 不跟随重定向",
            ));
        }
        let values = response
            .headers()
            .get_all(SET_COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        // Token providers keep JSON credentials, not a mutable Cookie jar.
        if !self.provider.token_auth() && !values.is_empty() {
            let mut cookie = self.cookie.lock().await;
            *cookie = merge_cookies(&cookie, &values);
            if let Some(binding)=self.binding.get(){
                let updates=values.iter().filter(|v|!v.split(';').next().unwrap_or("").trim_start().starts_with("BDCLND=")).cloned().collect::<Vec<_>>();
                if !updates.is_empty(){
                    if let Ok(Some(revision))=crate::cloud_auth::persist_cookies(&binding.pool,self.provider,binding.epoch,binding.revision.load(Ordering::SeqCst),&updates).await {binding.revision.store(revision,Ordering::SeqCst);}
                }
            }
        }
        if response
            .content_length()
            .is_some_and(|n| n > MAX_BODY as u64)
        {
            return Err(self.error(ErrorKind::Upstream, "网盘响应超过大小限制"));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| {
            tracing::warn!(provider=%self.provider.name(), error=%e.without_url(), "cloud drive response interrupted");
            self.error(
                ErrorKind::Network,
                "读取网盘响应超时或连接中断；请勿重复写操作",
            )
        })? {
            if bytes.len() + chunk.len() > MAX_BODY {
                return Err(self.error(ErrorKind::Upstream, "网盘响应超过大小限制"));
            }
            bytes.extend_from_slice(&chunk);
        }
        if status.as_u16() == 429 {
            return Err(self.error(ErrorKind::RateLimit, "网盘限制操作频率，请稍后再试"));
        }
        if status.as_u16() == 401 || status.as_u16() == 403 {
            self.auth_rejected(status.as_u16()==401).await;
            return Err(self.error(ErrorKind::Login, "网盘拒绝访问，请检查登录凭据或账号权限"));
        }
        if !status.is_success() {
            // Only the status is logged; never the body or the URL. Without this
            // the caller sees a generic upstream failure with no way to tell a
            // rejected request from a provider-side outage.
            tracing::warn!(provider=%self.provider.name(), http_status=status.as_u16(), "cloud drive rejected the request");
            return Err(self.error(
                ErrorKind::Upstream,
                &format!("网盘上游服务异常（HTTP {}）", status.as_u16()),
            ));
        }
        String::from_utf8(bytes)
            .map_err(|_| self.error(ErrorKind::Upstream, "网盘返回了无效的 UTF-8 响应"))
    }
    pub async fn json(
        &self,
        method: Method,
        url: Url,
        form: Option<&[(String, String)]>,
        body: Option<&Value>,
        step: &str,
        write: bool,
    ) -> Result<Value, DriveError> {
        let raw = self
            .request(method, url, form, body, step, write, false)
            .await?;
        let payload: Value = serde_json::from_str(&raw).map_err(|_| {
            self.error(
                ErrorKind::Upstream,
                "网盘返回非 JSON，请检查登录态或稍后再试",
            )
        })?;
        let field = if self.provider == Provider::Quark {
            "code"
        } else {
            "errno"
        };
        let code = match payload.get(field) {
            None => {
                return Err(self.error(
                    ErrorKind::Upstream,
                    "网盘响应缺少业务状态码，无法确认操作结果",
                ));
            }
            Some(v) => v
                .as_i64()
                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
                .ok_or_else(|| self.error(ErrorKind::Upstream, "网盘返回无法识别的状态码"))?,
        };
        if code != 0 {
            let error=DriveError::from_code(self.provider,code);
            if error.kind==ErrorKind::Login{self.auth_rejected(true).await;}
            return Err(error);
        }
        if payload["status"] == "error" {
            return Err(self.error(ErrorKind::Upstream, "网盘操作失败"));
        }
        Ok(payload)
    }
}
pub fn cookie_value(cookie: &str, key: &str) -> String {
    cookie
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .find(|(k, _)| *k == key)
        .map(|(_, v)| v.to_owned())
        .unwrap_or_default()
}
/// Servers delete cookies with an expired `expires` or non-positive `max-age`;
/// keeping the stale value would replay a dead session alongside the live one.
fn cookie_deleted(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    if lower.contains("max-age=0") || lower.contains("max-age=-") {
        return true;
    }
    let Some(raw) = value.split(';').find_map(|p| {
        let (k, v) = p.trim().split_once('=')?;
        k.eq_ignore_ascii_case("expires").then(|| v.to_owned())
    }) else {
        return false;
    };
    // Cookie dates come in RFC 1123 ("21 Oct 2015") and legacy hyphenated
    // ("21-Oct-2015") shapes; normalize both into an RFC 2822 parse.
    let normalized = raw.trim().trim_end_matches("GMT").trim().replace('-', " ");
    chrono::DateTime::parse_from_rfc2822(&format!("{normalized} +0000"))
        .map(|t| t.with_timezone(&chrono::Utc) <= chrono::Utc::now())
        .unwrap_or(false)
}
pub(crate) fn merge_cookies(cookie: &str, values: &[String]) -> String {
    let mut jar: BTreeMap<String, String> = cookie
        .split(';')
        .filter_map(|s| s.trim().split_once('='))
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect();
    for value in values {
        if let Some((k, v)) = value
            .split(';')
            .next()
            .and_then(|s| s.trim().split_once('='))
        {
            if v.is_empty() || cookie_deleted(value) {
                jar.remove(k);
            } else {
                jar.insert(k.into(), v.into());
            }
        }
    }
    jar.into_iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("; ")
}
pub fn http_client() -> Client {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(20))
        .pool_idle_timeout(Duration::from_secs(90))
        .pool_max_idle_per_host(8)
        .build()
        .expect("cloud drive HTTP client")
}

#[cfg(test)]
mod cookie_tests {
    use super::*;

    #[test]
    fn merge_cookies_replays_updates_and_honors_deletions() {
        assert_eq!(merge_cookies("a=1; b=2", &["b=3".into()]), "a=1; b=3");
        assert_eq!(merge_cookies("a=1", &["a=".into()]), "");
        assert_eq!(merge_cookies("a=1", &["a=; max-age=0".into()]), "");
        assert_eq!(merge_cookies("a=1", &["a=; max-age=-1".into()]), "");
        // Servers mark deletion with an already-past expires timestamp.
        assert_eq!(
            merge_cookies(
                "PASSID=keep",
                &["PASSID=c9IKyH; expires=Thu, 02-Oct-2025 14:00:51 GMT; path=/".into()]
            ),
            ""
        );
        assert_eq!(
            merge_cookies(
                "PASSID=old",
                &["PASSID=new; expires=Wed, 21 Oct 2099 07:28:00 GMT".into()]
            ),
            "PASSID=new"
        );
        // Unparseable dates never delete; conservative by design.
        assert_eq!(
            merge_cookies("a=1", &["a=2; expires=not-a-date".into()]),
            "a=2"
        );
    }
}
