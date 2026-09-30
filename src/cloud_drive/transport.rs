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
        atomic::{AtomicBool, Ordering},
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
}
impl Wire {
    pub fn new(client: Client, provider: Provider, cookie: String) -> Self {
        Self {
            client,
            provider,
            cookie: Arc::new(Mutex::new(cookie)),
            trace: Arc::new(Mutex::new(vec![])),
            wrote: Arc::new(AtomicBool::new(false)),
        }
    }
    pub async fn cookie_value(&self, key: &str) -> String {
        cookie_value(&*self.cookie.lock().await, key)
    }
    pub async fn require_login(&self) -> Result<(), DriveError> {
        let cookie = self.cookie.lock().await;
        if cookie.trim().is_empty() {
            return Err(self.error(ErrorKind::Login, "请先在后台云端操作设置中配置 Cookie"));
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
        let referer = if self.provider == Provider::Quark {
            "https://pan.quark.cn/"
        } else {
            "https://pan.baidu.com/disk/main"
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
        let cookie = self.cookie.lock().await.clone();
        if !cookie.is_empty() {
            request = request.header(COOKIE, cookie);
        }
        if self.provider == Provider::Quark {
            request = request.header("Origin", "https://pan.quark.cn");
        }
        if let Some(form) = form {
            request = request.form(form);
        }
        if let Some(json) = json {
            request = request.json(json);
        }
        if write {
            self.wrote.store(true, Ordering::SeqCst);
        }
        let mut response = request.send().await.map_err(|_| {
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
        if !values.is_empty() {
            let mut cookie = self.cookie.lock().await;
            *cookie = merge_cookies(&cookie, &values);
        }
        if response
            .content_length()
            .is_some_and(|n| n > MAX_BODY as u64)
        {
            return Err(self.error(ErrorKind::Upstream, "网盘响应超过大小限制"));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| {
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
            return Err(self.error(ErrorKind::Login, "网盘拒绝访问，请检查 Cookie 或账号权限"));
        }
        if !status.is_success() {
            return Err(self.error(ErrorKind::Upstream, "网盘上游服务异常"));
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
            return Err(DriveError::from_code(self.provider, code));
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
fn merge_cookies(cookie: &str, values: &[String]) -> String {
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
            if v.is_empty() || value.to_ascii_lowercase().contains("max-age=0") {
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
