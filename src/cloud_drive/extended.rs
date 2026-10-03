//! Native token-authenticated providers. Endpoint contracts are documented in
//! docs/cloud-drive-providers.md; API hosts are fixed and never caller supplied.
use super::{
    Context, DriveError, ErrorKind, File, Provider, Reference, ShareInput, scalar, transport::Wire,
    valid_id,
};
use reqwest::{
    Method,
    header::{HeaderMap, HeaderName, HeaderValue},
};
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
pub(super) fn credential_headers(provider: Provider, raw: &str) -> Result<HeaderMap, ()> {
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
        ("x-client-version", "0.0.1"), ("x-device-name", "PC-Chrome"),
        ("x-device-model", "chrome%2F131.0.0.0"), ("x-net-work-type", "NONE"),
        ("x-os-version", "Win32"), ("x-platform-version", "1"),
        ("x-protocol-version", "301"), ("x-provider-name", "NONE"),
        ("x-sdk-version", "9.1.3"),
    ] { headers.insert(HeaderName::from_static(name), HeaderValue::from_static(value)); }
    Ok(headers)
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
        let code=scalar(&value["code"]);
        let error=scalar(&value["error"]);
        if matches!(code.as_str(),"AccessTokenInvalid"|"AccessTokenExpired"|"InvalidAccessToken"|"Unauthorized"|"401"|"403")||matches!(error.as_str(),"invalid_token"|"invalid_grant"|"unauthorized"|"unauthenticated"|"captcha_required"){
            self.wire.auth_rejected(code!="403"&&error!="captcha_required").await;
            return Err(self.wire.error(ErrorKind::Login,"账号授权已失效或需要额外验证，请重新连接"));
        }
        let actual = text(self.data(&value), &["user_id", "userId", "sub", "id"]);
        if actual.is_empty(){return Err(self.wire.error(ErrorKind::Upstream,"账号响应缺少身份字段，无法核实账号"));}
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
                let kind = match code.as_str() {
                    "AccessTokenInvalid" | "AccessTokenExpired" | "InvalidAccessToken"
                    | "Unauthorized" | "401" | "DeviceSessionSignatureInvalid"
                    | "DeviceSessionSignatureOffline" | "DeviceSessionNotFound" => ErrorKind::Login,
                    "ShareLinkNotFound" | "ShareLinkExpired" | "ShareLinkCancelled" => {
                        ErrorKind::InvalidLink
                    }
                    "ShareLinkPasswordMismatch" | "InvalidSharePwd" => ErrorKind::Password,
                    "TooManyRequests" | "429" => ErrorKind::RateLimit,
                    _ => ErrorKind::Upstream,
                };
                if kind==ErrorKind::Login {wire.auth_rejected(true).await;}
                return Err(wire.error(kind, "网盘拒绝操作，请检查登录凭据、提取码或账号限制"));
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
    fn file(&self, value: &Value) -> Result<File, DriveError> {
        let id = text(value, &["file_id", "fileId", "id"]);
        let name = text(value, &["name", "fileName"]);
        if !valid_id(&id, false) || name.is_empty() {
            return Err(self.wire.error(ErrorKind::Upstream, "文件身份或名称缺失"));
        }
        let is_dir = match (
            value["type"].as_str(),
            value["kind"].as_str(),
            value["resType"].as_i64(),
            value["isDir"].as_bool(),
        ) {
            (Some("folder"), _, _, _)
            | (_, Some("drive#folder"), _, _)
            | (_, _, Some(2), _)
            | (_, _, _, Some(true)) => true,
            (Some("file"), _, _, _)
            | (_, Some("drive#file"), _, _)
            | (_, _, Some(1), _)
            | (_, _, _, Some(false)) => false,
            _ => {
                return Err(self
                    .wire
                    .error(ErrorKind::Upstream, "文件类型缺失或未知，不能核实完整目录"));
            }
        };
        let size = if is_dir {
            0
        } else {
            text(value, &["size", "fileSize"])
                .parse::<u64>()
                .map_err(|_| {
                    self.wire
                        .error(ErrorKind::Upstream, "文件大小缺失或无效，不能核实转存结果")
                })?
        };
        Ok(File {
            id,
            name,
            size,
            is_dir,
            md5: text(value, &["content_hash", "md5", "gcid"]),
            path: String::new(),
            token: String::new(),
        })
    }
    fn array<'a>(&self, value: &'a Value) -> Result<&'a Vec<Value>, DriveError> {
        let data = self.data(value);
        if value["data"].is_array() {
            return Ok(value["data"].as_array().unwrap());
        }
        if let Some(list) = ["items", "files", "list", "fileList", "records", "resList"]
            .iter()
            .find_map(|name| data[*name].as_array())
        {
            return Ok(list);
        }
        // The live guangya file list answers an empty directory with
        // `{"msg":"success","data":{}}` — no list field at all. Refusing that
        // would turn every empty directory into a hard failure, so a success
        // envelope without entries is an empty listing. Missing msg or any
        // other message still fails closed.
        if self.wire.provider == Provider::Guangya && scalar(&value["msg"]) == "success" {
            static EMPTY: Vec<Value> = Vec::new();
            return Ok(&EMPTY);
        }
        tracing::warn!(
            top_keys=?value.as_object().map(|o|o.keys().collect::<Vec<_>>()),
            data_keys=?data.as_object().map(|o|o.keys().collect::<Vec<_>>()),
            "drive listing response has no known file list field"
        );
        Err(self.wire.error(
            ErrorKind::Upstream,
            "目录响应缺少文件列表，拒绝当作空目录",
        ))
    }
    async fn listing(
        &self,
        parent: &str,
        reference: Option<(&Reference, &str)>,
    ) -> Result<Vec<File>, DriveError> {
        let mut files = vec![];
        let mut marker = String::new();
        let mut seen = HashSet::new();
        for page in 0..50 {
            let value = match self.wire.provider {
                Provider::Aliyun => {
                    let mut body = json!({"parent_file_id":parent,"limit":100,"marker":marker,"order_by":"name","order_direction":"ASC"});
                    if let Some((r, _)) = reference {
                        body["share_id"] = json!(r.key);
                    } else {
                        body["drive_id"] = json!(self.drive_id);
                    }
                    self.post(
                        if reference.is_some() {
                            "adrive/v2/file/list_by_share"
                        } else {
                            "adrive/v3/file/list"
                        },
                        body,
                        reference.map(|(_, t)| t),
                        false,
                    )
                    .await?
                }
                Provider::Xunlei => {
                    let root = if parent == "0" { "" } else { parent };
                    if let Some((r, t)) = reference {
                        self.post("drive/v1/share/detail",json!({"parent_id":root,"limit":100,"page_token":marker,"share_id":r.key,"pass_code_token":t,"thumbnail_size":"SIZE_LARGE","order":"6"}),None,false).await?
                    } else {
                        self.call(
                            Method::GET,
                            "drive/v1/files",
                            &[
                                ("parent_id", root.into()),
                                ("limit", "100".into()),
                                ("page_token", marker.clone()),
                                ("filters", json!({"trashed":{"eq":false}}).to_string()),
                            ],
                            None,
                            None,
                            false,
                        )
                        .await?
                    }
                }
                Provider::Guangya => {
                    let root = if parent == "0" { "" } else { parent };
                    // The official client omits fileTypes when it does not filter;
                    // sending an empty array is not the same request.
                    let mut body = json!({"parentId":root,"page":if reference.is_some(){page+1}else{page},"pageSize":100,"orderBy":0,"sortType":0});
                    if let Some((_, t)) = reference {
                        body["accessToken"] = json!(t);
                    }
                    self.post(
                        if reference.is_some() {
                            "nd.bizuserres.s/v1/get_share_page_files_list"
                        } else {
                            "userres/v1/file/get_file_list"
                        },
                        body,
                        None,
                        false,
                    )
                    .await?
                }
                _ => unreachable!(),
            };
            let items = self.array(&value)?;
            for item in items {
                let file = self.file(item)?;
                if !seen.insert(file.id.clone()) {
                    return Err(self.wire.error(ErrorKind::Upstream, "列表重复或翻页异常"));
                }
                files.push(file);
            }
            let next = text(
                self.data(&value),
                &["next_marker", "next_page_token", "page_token"],
            );
            if self.wire.provider == Provider::Guangya {
                let total = text(self.data(&value), &["total", "totalCount"])
                    .parse::<usize>()
                    .ok();
                if items.len() < 100 && total.is_none_or(|t| files.len() >= t)
                    || total.is_some_and(|t| files.len() >= t)
                {
                    return Ok(files);
                }
            } else if next.is_empty() {
                return Ok(files);
            } else if next == marker {
                return Err(self.wire.error(ErrorKind::Upstream, "翻页游标未推进"));
            }
            marker = next;
        }
        Err(self
            .wire
            .error(ErrorKind::Limit, "文件列表过大，拒绝不完整操作"))
    }
    pub async fn resolve(&self, r: &Reference) -> Result<Context, DriveError> {
        let value = match self.wire.provider {
            Provider::Aliyun => {
                self.post(
                    "v2/share_link/get_share_token",
                    json!({"share_id":r.key,"share_pwd":r.password}),
                    None,
                    false,
                )
                .await?
            }
            Provider::Xunlei => {
                self.call(
                    Method::GET,
                    "drive/v1/share",
                    &[
                        ("share_id", r.key.clone()),
                        ("pass_code", r.password.clone()),
                        ("limit", "100".into()),
                    ],
                    None,
                    None,
                    false,
                )
                .await?
            }
            Provider::Guangya => {
                self.post(
                    "nd.bizuserres.s/v1/get_share_access_token",
                    json!({"shareId":r.key,"code":r.password}),
                    None,
                    false,
                )
                .await?
            }
            _ => unreachable!(),
        };
        let token = text(
            self.data(&value),
            &[
                "share_token",
                "pass_code_token",
                "accessToken",
                "access_token",
            ],
        );
        if token.is_empty() {
            return Err(self
                .wire
                .error(ErrorKind::Upstream, "分享访问令牌缺失，未判定链接失效"));
        }
        let files = self
            .listing(
                if self.wire.provider == Provider::Aliyun {
                    "root"
                } else {
                    "0"
                },
                Some((r, &token)),
            )
            .await?;
        Ok(Context {
            reference: r.clone(),
            title: text(self.data(&value), &["title", "share_name"]),
            files,
            token,
            owner: String::new(),
            share_id: r.key.clone(),
        })
    }
    pub async fn list(&self, dir: &str) -> Result<Vec<File>, DriveError> {
        self.wire.require_login().await?;
        self.listing(dir, None).await
    }
    async fn wait_task(&self, id: &str) -> Result<(), DriveError> {
        if !valid_id(id, false) {
            return Err(self.wire.error(ErrorKind::Upstream, "任务身份无效"));
        }
        let started = tokio::time::Instant::now();
        let deadline = started + Duration::from_secs(30);
        while tokio::time::Instant::now() < deadline {
            let value = match self.wire.provider {
                Provider::Aliyun => {
                    self.post(
                        "v2/async_task/get",
                        json!({"async_task_id":id}),
                        None,
                        false,
                    )
                    .await?
                }
                Provider::Xunlei => {
                    self.call(
                        Method::GET,
                        &format!("drive/v1/tasks/{id}"),
                        &[],
                        None,
                        None,
                        false,
                    )
                    .await?
                }
                Provider::Guangya => {
                    self.post(
                        "nd.bizuserres.s/v1/get_task_status",
                        json!({"taskId":id}),
                        None,
                        false,
                    )
                    .await?
                }
                _ => unreachable!(),
            };
            let data = self.data(&value);
            let state = text(data, &["state", "status", "phase"]);
            if matches!(
                state.as_str(),
                "Succeed" | "Success" | "Succeeded" | "PHASE_TYPE_COMPLETE" | "2"
            ) {
                return Ok(());
            }
            if matches!(state.as_str(), "Failed" | "PHASE_TYPE_ERROR" | "3") {
                return Err(self.wire.error(ErrorKind::Upstream, "网盘任务失败"));
            }
            // Short jobs should not pay a full second between acknowledgements.
            // Back off for longer jobs to keep provider polling bounded.
            let interval = if started.elapsed() < Duration::from_secs(2) {
                Duration::from_millis(250)
            } else if started.elapsed() < Duration::from_secs(5) {
                Duration::from_millis(500)
            } else {
                Duration::from_secs(1)
            };
            tokio::time::sleep_until(deadline.min(tokio::time::Instant::now() + interval)).await;
        }
        Err(self
            .wire
            .error(ErrorKind::Network, "网盘任务尚未确认，保留产物记录待核实"))
    }
    pub async fn create_directory(&self, parent: &str, name: &str) -> Result<File, DriveError> {
        self.wire.require_login().await?;
        let value = match self.wire.provider {
            Provider::Aliyun => self.post("v2/file/create",json!({"drive_id":self.drive_id,"parent_file_id":parent,"name":name,"type":"folder","check_name_mode":"refuse"}),None,true).await?,
            Provider::Xunlei => self.post("drive/v1/files",json!({"kind":"drive#folder","name":name,"parent_id":if parent=="0"{""}else{parent}}),None,true).await?,
            Provider::Guangya => self.post("nd.bizuserres.s/v1/file/create_dir",json!({"parentId":if parent=="0"{""}else{parent},"dirName":name,"failIfNameExist":true}),None,true).await?,
            _=>unreachable!(),
        };
        if let Ok(file) = self.file(self.data(&value)) {
            if file.is_dir && file.name == name {
                return Ok(file);
            }
        }
        // Some providers only acknowledge creation. Resolve the unique child identity.
        let mut found = self
            .list(parent)
            .await?
            .into_iter()
            .filter(|f| f.name == name && f.is_dir);
        let owned = found
            .next()
            .ok_or_else(|| self.wire.error(ErrorKind::Upstream, "新目录身份未确认"))?;
        if found.next().is_some() {
            return Err(self
                .wire
                .error(ErrorKind::Ownership, "新目录重名，拒绝猜测归属"));
        }
        Ok(owned)
    }
    pub async fn transfer(&self, context: &Context, dir: &str) -> Result<Vec<String>, DriveError> {
        self.transfer_with_listing(context, dir).await.map(|(ids, _)| ids)
    }
    pub async fn transfer_with_listing(&self, context: &Context, dir: &str) -> Result<(Vec<String>, Option<Vec<File>>), DriveError> {
        self.wire.require_login().await?;
        let ids: Vec<&str> = context.files.iter().map(|f| f.id.as_str()).collect();
        let mut acknowledged = vec![];
        if self.wire.provider == Provider::Aliyun {
            for id in &ids {
                let value=self.post("v2/file/copy",json!({"share_id":context.reference.key,"file_id":id,"to_drive_id":self.drive_id,"to_parent_file_id":dir,"auto_rename":false}),Some(&context.token),true).await?;
                let data = self.data(&value);
                let task = text(data, &["async_task_id"]);
                if !task.is_empty() {
                    self.wait_task(&task).await?;
                }
                let id = text(data, &["file_id"]);
                if !valid_id(&id, false) {
                    return Err(self.wire.error(ErrorKind::Upstream, "转存文件 ID 缺失"));
                }
                self.wire.confirmed_file_ids.lock().await.push(id.clone());
                acknowledged.push(id);
            }
            return Ok((acknowledged, None));
        }
        let value = if self.wire.provider == Provider::Xunlei {
            self.post("drive/v1/share/restore",json!({"share_id":context.reference.key,"pass_code_token":context.token,"file_ids":ids,"specify_parent_id":true,"parent_id":dir,"ancestor_ids":[]}),None,true).await?
        } else {
            self.post(
                "nd.bizuserres.s/v1/restore_share",
                json!({"accessToken":context.token,"fileIds":ids,"parentId":dir}),
                None,
                true,
            )
            .await?
        };
        let data = self.data(&value);
        let task = text(data, &["task_id", "taskId"]);
        if !task.is_empty() {
            self.wait_task(&task).await?;
        }
        let files = self.list(dir).await?;
        // A dedicated, previously-empty child directory plus an acknowledged write
        // and exact source mapping are required before recording deletion ownership.
        if !matches_transferred_files(&context.files, &files) {
            return Err(self
                .wire
                .error(ErrorKind::Ownership, "转存结果与来源不匹配，拒绝确认或删除"));
        }
        Ok((files.iter().map(|f| f.id.clone()).collect(), Some(files)))
    }
    pub async fn share(&self, files: &[File], days: u32) -> Result<Value, DriveError> {
        self.wire.require_login().await?;
        if files.is_empty() || ![1, 7, 30].contains(&days) {
            return Err(self.wire.error(ErrorKind::Input, "分享文件或期限无效"));
        }
        let ids: Vec<_> = files.iter().map(|f| &f.id).collect();
        let expires = chrono::Utc::now() + chrono::Duration::days(days as i64);
        let value=match self.wire.provider {
            Provider::Aliyun=>self.post("adrive/v2/share_link/create",json!({"drive_id":self.drive_id,"file_id_list":ids,"expiration":expires.to_rfc3339(),"share_pwd":"","share_name":"pansou 分享"}),None,true).await?,
            Provider::Xunlei=>self.post("drive/v1/share/batch",json!({"file_ids":ids,"need_password":true,"expiration_days":days}),None,true).await?,
            Provider::Guangya=>self.post("nd.bizuserres.s/v1/share_file",json!({"fileIds":ids,"title":"pansou 分享","validateDuration":days*24*3600,"shareType":1,"code":"","autoFillCode":true,"downloadType":1,"trafficLimit":"0","maxRestoreCount":0}),None,true).await?,
            _=>unreachable!(),
        };
        let data = self.data(&value);
        let url = text(data, &["share_url", "shareUrl", "url", "shareLink"]);
        let mut id = text(data, &["share_id", "shareId", "id"]);
        let mut password = text(data, &["share_pwd", "pass_code", "code"]);
        let canonical = if !url.is_empty() {
            let parsed = ShareInput {
                url,
                provider: Some(self.wire.provider),
                password: None,
            }
            .parse()
            .map_err(|_| self.wire.error(ErrorKind::Upstream, "平台返回非法分享 URL"))?;
            if password.is_empty() {
                password = parsed.password;
            }
            if id.is_empty() {
                id = parsed.key;
            } else if !share_id_matches(self.wire.provider, &id, &parsed.key) {
                return Err(self
                    .wire
                    .error(ErrorKind::Upstream, "分享 ID 与链接不一致，保留记录待核实"));
            }
            parsed.url
        } else {
            let host = match self.wire.provider {
                Provider::Aliyun => "www.alipan.com",
                Provider::Xunlei => "pan.xunlei.com",
                _ => "www.guangyapan.com",
            };
            format!("https://{host}/s/{id}")
        };
        if !valid_id(&id, false) {
            return Err(self
                .wire
                .error(ErrorKind::Upstream, "分享 ID 缺失，产物需核实"));
        }
        Ok(json!({"shareId":id,"url":canonical,"password":password,"shareExpiresAt":expires}))
    }
    pub async fn revoke_share(&self, id: &str) -> Result<(), DriveError> {
        self.wire.require_login().await?;
        match self.wire.provider {
            Provider::Aliyun => {
                self.post(
                    "adrive/v2/share_link/cancel",
                    json!({"share_id":id}),
                    None,
                    true,
                )
                .await?;
            }
            Provider::Xunlei => {
                self.post(
                    "drive/v1/share/batch/delete",
                    json!({"share_ids":[id]}),
                    None,
                    true,
                )
                .await?;
            }
            Provider::Guangya => {
                self.post(
                    "nd.bizuserres.s/v1/delete_share",
                    json!({"ids":[id]}),
                    None,
                    true,
                )
                .await?;
            }
            _ => unreachable!(),
        }
        Ok(())
    }
    pub async fn delete(&self, files: &[File]) -> Result<(), DriveError> {
        self.wire.require_login().await?;
        for file in files {
            if !valid_id(&file.id, false) {
                return Err(self.wire.error(ErrorKind::Input, "删除文件 ID 无效"));
            }
            let value = match self.wire.provider {
                Provider::Aliyun => {
                    self.post(
                        "v2/recyclebin/trash",
                        json!({"drive_id":self.drive_id,"file_id":file.id}),
                        None,
                        true,
                    )
                    .await?
                }
                Provider::Xunlei => {
                    self.post(
                        "drive/v1/files:batchTrash",
                        json!({"ids":[file.id],"space":""}),
                        None,
                        true,
                    )
                    .await?
                }
                Provider::Guangya => {
                    self.post(
                        "nd.bizuserres.s/v1/file/delete_file",
                        json!({"fileIds":[file.id]}),
                        None,
                        true,
                    )
                    .await?
                }
                _ => unreachable!(),
            };
            let task = text(self.data(&value), &["task_id", "taskId", "async_task_id"]);
            if !task.is_empty() {
                self.wait_task(&task).await?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Json, Router, extract::State, response::IntoResponse, routing::any};

    fn provider(provider: Provider) -> Extended {
        let raw = json!({"access_token":"fixture-access","user_id":"fixture-user","drive_id":"fixture-drive","captcha_token":"fixture-captcha"}).to_string();
        Extended::new(
            Wire::new(reqwest::Client::new(), provider, raw.clone()),
            &raw,
        )
    }

    #[test]
    fn guangya_share_id_prefix_belongs_to_the_link_key() {
        // Captured live: shareId "1953326881503436886" with the share URL
        // .../s/1953326881503436886_aeXCPJwocgzRgD8m?code=bmwv.
        assert!(share_id_matches(
            Provider::Guangya,
            "1953326881503436886",
            "1953326881503436886_aeXCPJwocgzRgD8m"
        ));
        assert!(!share_id_matches(
            Provider::Guangya,
            "1953326881503436887",
            "1953326881503436886_aeXCPJwocgzRgD8m"
        ));
        // A bare prefix without the id/suffix separator is still a mismatch,
        // and other providers stay strict.
        assert!(!share_id_matches(
            Provider::Guangya,
            "1953326881503436886",
            "19533268815034368865_extra"
        ));
        assert!(!share_id_matches(
            Provider::Aliyun,
            "1953326881503436886",
            "1953326881503436886_aeXCPJwocgzRgD8m"
        ));
        assert!(share_id_matches(Provider::Aliyun, "abc", "abc"));
    }

    #[test]
    fn guangya_empty_directory_is_an_empty_listing_not_a_failure() {
        // Captured from userres/v1/file/get_file_list on 2026-10-03: an empty
        // directory answers {"msg":"success","data":{}} with no list field.
        let drive = provider(Provider::Guangya);
        assert!(drive.array(&json!({"msg":"success","data":{}})).unwrap().is_empty());
        // A non-empty listing keeps its entries, and the shape that broke the
        // delivery before stays parseable.
        let root = json!({"msg":"success","data":{"total":1,"list":[
            {"fileId":"1953187127336075337","fileName":"__PANSOU__","depth":1,"dirType":1,"resType":2}
        ]}});
        assert_eq!(drive.array(&root).unwrap().len(), 1);
        // Anything else without a list field still fails closed, for guangya
        // only when the envelope is not a success.
        assert!(drive.array(&json!({"msg":"出错了","data":{}})).is_err());
        assert!(drive.array(&json!({"data":{}})).is_err());
        for other in [Provider::Aliyun, Provider::Xunlei] {
            assert!(provider(other).array(&json!({"msg":"success","data":{}})).is_err());
        }
    }

    #[tokio::test]
    async fn short_tasks_are_confirmed_without_whole_second_polling_gaps() {
        async fn status(State(calls): State<std::sync::Arc<std::sync::atomic::AtomicUsize>>) -> Json<Value> {
            let count = calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Json(json!({"code":0,"data":{"status":if count < 2 {1} else {2}}}))
        }
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut drive = provider(Provider::Guangya);
        drive.base = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let app = Router::new().fallback(any(status)).with_state(calls.clone());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let started = std::time::Instant::now();
        drive.wait_task("fixture-task").await.unwrap();
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 3);
        assert!(started.elapsed() < Duration::from_millis(1800), "short task waited {:?}", started.elapsed());
        server.abort();
    }

    #[tokio::test]
    async fn guangya_identity_uses_get_and_rejects_wrong_account() {
        async fn identity(request: axum::http::Request<axum::body::Body>) -> axum::response::Response {
            assert_eq!(request.uri().path(), "/v1/user/me");
            assert_eq!(request.headers()["authorization"], "Bearer fixture-access");
            if request.method() != Method::GET {
                return (axum::http::StatusCode::NOT_IMPLEMENTED, Json(json!({"error":"unimplemented"}))).into_response();
            }
            Json(json!({"sub":"fixture-user"})).into_response()
        }
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut drive=provider(Provider::Guangya);
        drive.account_base=Url::parse(&format!("http://{}/",listener.local_addr().unwrap())).unwrap();
        let app=Router::new().fallback(any(identity));
        let server=tokio::spawn(async move{axum::serve(listener,app).await.unwrap()});
        drive.verify_account().await.unwrap();
        drive.user_id="wrong-account".into();
        assert_eq!(drive.verify_account().await.unwrap_err().kind,ErrorKind::Ownership);
        server.abort();
    }

    #[test]
    fn transferred_files_must_match_each_source_once() {
        let file = |id: &str, name: &str| File {
            id: id.into(),
            name: name.into(),
            size: 42,
            is_dir: false,
            md5: String::new(),
            path: String::new(),
            token: String::new(),
        };
        let source = vec![file("s1", "a.mp4"), file("s2", "b.mp4")];
        assert!(!matches_transferred_files(
            &source,
            &[file("t1", "a.mp4"), file("t2", "a.mp4")]
        ));
        assert!(matches_transferred_files(
            &source,
            &[file("t2", "b.mp4"), file("t1", "a.mp4")]
        ));
        let mut wrong = file("t1", "a.mp4");
        wrong.size = 0;
        assert!(!matches_transferred_files(&[source[0].clone()], &[wrong]));
    }

    #[test]
    fn missing_file_metadata_is_not_assumed_to_be_an_empty_file() {
        for p in [Provider::Aliyun, Provider::Xunlei, Provider::Guangya] {
            let drive = provider(p);
            assert!(
                drive
                    .file(&json!({"id":"file","name":"movie","type":"file","size":"42"}))
                    .is_ok()
            );
            assert!(
                drive
                    .file(&json!({"id":"dir","name":"folder","type":"folder"}))
                    .unwrap()
                    .is_dir
            );
            for item in [
                json!({"id":"file","name":"movie","type":"file"}),
                json!({"id":"file","name":"movie","size":0}),
                json!({"id":"file","name":"movie","type":"file","size":-1}),
            ] {
                assert!(drive.file(&item).is_err());
            }
        }
    }

    async fn mock(
        State(value): State<Value>,
        headers: axum::http::HeaderMap,
    ) -> axum::response::Response {
        assert_eq!(
            headers.get("authorization").unwrap(),
            "Bearer fixture-access"
        );
        assert!(headers.get("cookie").is_none());
        let mut response = Json(value).into_response();
        response.headers_mut().insert(
            "set-cookie",
            HeaderValue::from_static("upstream_session=fixture; Path=/"),
        );
        response
    }

    #[tokio::test]
    async fn malformed_business_status_fails_closed_and_set_cookie_keeps_token_credentials() {
        for p in [Provider::Aliyun, Provider::Xunlei, Provider::Guangya] {
            for value in [
                json!({"code":0}),
                json!({"code":null}),
                json!({"code":true}),
                json!({"code":""}),
                json!({"code":{}}),
                json!({"code":0,"success":false}),
            ] {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let mut drive = provider(p);
                drive.base =
                    Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
                let success = value == json!({"code":0});
                let app = Router::new().fallback(any(mock)).with_state(value);
                let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
                assert_eq!(
                    drive.post("fixture", json!({}), None, false).await.is_ok(),
                    success
                );
                // Set-Cookie must not rewrite the stored JSON on any response.
                assert!(drive.wire.require_login().await.is_ok());
                assert_eq!(
                    drive.post("fixture", json!({}), None, false).await.is_ok(),
                    success
                );
                server.abort();
            }
        }
    }
    #[tokio::test]
    async fn guangya_replies_without_a_business_code_still_need_a_payload() {
        async fn envelope(State(value): State<Value>) -> axum::response::Response {
            Json(value).into_response()
        }
        for (value, accepted) in [
            // The live service answers successful business calls with
            // `{"data":…,"msg":…}` and no `code` at all.
            (
                json!({"data":{"resList":[],"total":0},"msg":"success"}),
                true,
            ),
            (json!({"data":{"taskId":"t"},"msg":"ok"}), true),
            // A `code` envelope stays authoritative when it is present.
            (json!({"code":200,"data":{"resList":[]}}), true),
            (json!({"code":"0","data":{"resList":[]}}), true),
            (json!({"code":117,"msg":"无效token"}), false),
            // A bare status message carries no confirmed result.
            (json!({"msg":"无效token"}), false),
            (json!({"data":null,"msg":"失败"}), false),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let mut drive = provider(Provider::Guangya);
            drive.base =
                Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
            let app = Router::new().fallback(any(envelope)).with_state(value);
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            assert_eq!(
                drive.post("fixture", json!({}), None, false).await.is_ok(),
                accepted
            );
            server.abort();
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
