use super::{Context, DriveError, ErrorKind, File, Reference, list_field, scalar, transport::Wire};
use base64::Engine;
use reqwest::Method;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    sync::{Arc, LazyLock},
};
use tokio::sync::Mutex;
use url::Url;
static SHARE_ID: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r#"["']?shareid["']?\s*[:=]\s*["']?(\d+)"#).unwrap());
static SHARE_UK: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r#"["']?share_uk["']?\s*[:=]\s*["']?(\d+)"#).unwrap());
#[derive(Clone)]
pub struct Baidu {
    pub wire: Wire,
    pub base: Url,
    token: Arc<Mutex<Option<(String, String)>>>,
}
impl Baidu {
    pub fn new(wire: Wire) -> Self {
        Self {
            wire,
            base: Url::parse("https://pan.baidu.com/").unwrap(),
            token: Arc::new(Mutex::new(None)),
        }
    }
    fn url(&self, path: &str, params: &[(&str, String)]) -> Url {
        let mut url = self.base.join(path).expect("fixed Baidu path");
        url.query_pairs_mut()
            .extend_pairs(params.iter().map(|(k, v)| (*k, v.as_str())));
        url
    }
    fn params(&self) -> Vec<(&'static str, String)> {
        vec![
            ("channel", "chunlei".into()),
            ("web", "1".into()),
            ("app_id", "250528".into()),
            ("clienttype", "0".into()),
        ]
    }
    async fn get(
        &self,
        path: &str,
        params: &[(&str, String)],
        step: &str,
    ) -> Result<Value, DriveError> {
        self.wire
            .json(Method::GET, self.url(path, params), None, None, step, false)
            .await
    }
    async fn post(
        &self,
        path: &str,
        params: &[(&str, String)],
        form: &[(String, String)],
        step: &str,
        write: bool,
    ) -> Result<Value, DriveError> {
        self.wire
            .json(
                Method::POST,
                self.url(path, params),
                Some(form),
                None,
                step,
                write,
            )
            .await
    }
    async fn logid(&self) -> String {
        base64::engine::general_purpose::STANDARD.encode(self.wire.cookie_value("BAIDUID").await)
    }
    pub async fn token(&self) -> Result<(String, String), DriveError> {
        self.wire.require_login().await?;
        let mut token = self.token.lock().await;
        if let Some(t) = &*token {
            return Ok(t.clone());
        }
        let response = self
            .get(
                "/api/gettemplatevariable",
                &[
                    ("clienttype", "0".into()),
                    ("app_id", "38824127".into()),
                    ("web", "1".into()),
                    ("fields", json!(["bdstoken", "uk"]).to_string()),
                ],
                "取账号信息",
            )
            .await?;
        let bdstoken = scalar(&response["result"]["bdstoken"]);
        let uk = scalar(&response["result"]["uk"]);
        if bdstoken.is_empty() {
            return Err(self
                .wire
                .error(ErrorKind::Login, "未取得百度 bdstoken，请检查 Cookie"));
        }
        let result = (bdstoken, uk);
        *token = Some(result.clone());
        Ok(result)
    }
    /// Exchange the extraction code for the share session token (`sekey`).
    /// Split out of `resolve` so a delivery that already knows the share's
    /// identity and file list only pays this one fast round trip.
    pub async fn verify_share(&self, r: &Reference) -> Result<String, DriveError> {
        let mut params = self.params();
        params.extend([
            ("surl", r.key.clone()),
            ("t", chrono::Utc::now().timestamp_millis().to_string()),
            ("logid", self.logid().await),
        ]);
        let verification = self
            .post(
                "/share/verify",
                &params,
                &[
                    ("pwd".into(), r.password.clone()),
                    ("vcode".into(), String::new()),
                    ("vcode_str".into(), String::new()),
                ],
                "校验提取码",
                false,
            )
            .await?;
        let randsk = scalar(&verification["randsk"]);
        if randsk.is_empty() {
            return Err(self
                .wire
                .error(ErrorKind::Password, "百度未返回分享授权，请检查提取码"));
        }
        // Baidu only returns the share-session cookie to requests that already
        // carry BAIDUID. A bare client (no configured account) gets none, so
        // install the still-encoded randsk as BDCLND; without it the share
        // page and /share/list answer "need verify" right after a valid check.
        if self.wire.cookie_value("BDCLND").await.is_empty() {
            self.wire.merge_cookie(&format!("BDCLND={randsk}")).await;
        }
        let encoded = format!("key={}", randsk.replace('+', "%2B"));
        Ok(url::form_urlencoded::parse(encoded.as_bytes())
            .next()
            .map(|(_, v)| v.into_owned())
            .unwrap_or_default())
    }
    pub async fn resolve(&self, r: &Reference) -> Result<Context, DriveError> {
        let sekey = self.verify_share(r).await?;
        let html = self
            .wire
            .request(
                Method::GET,
                self.url(&format!("/s/1{}", r.key), &[]),
                None,
                None,
                "解析分享页",
                false,
                true,
            )
            .await?;
        let share_id = SHARE_ID
            .captures(&html)
            .map(|c| c[1].to_owned())
            .ok_or_else(|| {
                if html.contains("<title>百度网盘-链接不存在")
                    || html.contains(r#""share_page_type":"error""#)
                {
                    self.wire
                        .error(ErrorKind::InvalidLink, "百度分享链接不存在或已失效")
                } else {
                    self.wire.error(
                        ErrorKind::Upstream,
                        "未能解析百度分享信息，不能确认链接状态",
                    )
                }
            })?;
        let owner = SHARE_UK
            .captures(&html)
            .map(|c| c[1].to_owned())
            .ok_or_else(|| {
                self.wire
                    .error(ErrorKind::Upstream, "未能解析百度分享者身份")
            })?;
        self.resolve_identity(r, sekey, share_id, owner).await
    }
    /// Cached share identity skips HTML parsing, but membership is always read live.
    pub async fn resolve_identity(
        &self,
        r: &Reference,
        sekey: String,
        share_id: String,
        owner: String,
    ) -> Result<Context, DriveError> {
        let mut files = vec![];
        for page in 1..=50 {
            let mut params = self.params();
            params.extend([
                ("shareid", share_id.clone()),
                ("uk", owner.clone()),
                ("sekey", sekey.clone()),
                ("type", "0".into()),
                ("root", "1".into()),
                ("page", page.to_string()),
                ("num", "100".into()),
                ("order", "other".into()),
                ("desc", "1".into()),
            ]);
            let value = self.get("/share/list", &params, "读分享目录").await?;
            let list = list_field(&value, "/list", &self.wire)?;
            for item in list {
                files.push(self.file(item)?);
            }
            if list.len() < 100 {
                return Ok(Context {
                    reference: r.clone(),
                    title: String::new(),
                    files,
                    token: sekey,
                    owner,
                    share_id,
                });
            }
        }
        Err(self
            .wire
            .error(ErrorKind::Limit, "百度分享超过 5000 项，拒绝截断后操作"))
    }
    fn file(&self, v: &Value) -> Result<File, DriveError> {
        let id = scalar(&v["fs_id"]);
        if id.parse::<u64>().ok().filter(|id| *id > 0).is_none() {
            return Err(self.wire.error(ErrorKind::Upstream, "百度返回了无效 fs_id"));
        }
        Ok(File {
            id,
            name: scalar(&v["server_filename"]),
            size: v["size"].as_u64().unwrap_or(0),
            is_dir: v["isdir"].as_i64() == Some(1) || v["isdir"] == true,
            md5: scalar(&v["md5"]),
            path: scalar(&v["path"]),
            token: String::new(),
        })
    }
    pub async fn list(&self, dir: &str) -> Result<Vec<File>, DriveError> {
        let (token, _) = self.token().await?;
        let mut files = vec![];
        for page in 1..=50 {
            let response = self
                .get(
                    "/api/list",
                    &[
                        ("order", "time".into()),
                        ("desc", "1".into()),
                        ("showempty", "0".into()),
                        ("web", "1".into()),
                        ("page", page.to_string()),
                        ("num", "1000".into()),
                        ("dir", dir.into()),
                        ("bdstoken", token.clone()),
                    ],
                    "列我的目录",
                )
                .await?;
            let list = list_field(&response, "/list", &self.wire)?;
            for item in list {
                files.push(self.file(item)?);
            }
            if list.len() < 1000 {
                return Ok(files);
            }
        }
        Err(self
            .wire
            .error(ErrorKind::Limit, "百度目录超过 50000 项，无法完整确认"))
    }
    pub async fn save(
        &self,
        ctx: &Context,
        files: &[File],
        dir: &str,
    ) -> Result<Vec<String>, DriveError> {
        let (token, _) = self.token().await?;
        let ids = self.ids(files)?;
        let mut params = self.params();
        params.extend([
            ("shareid", ctx.share_id.clone()),
            ("from", ctx.owner.clone()),
            ("sekey", ctx.token.clone()),
            ("ondup", "newcopy".into()),
            ("async", "0".into()),
            ("bdstoken", token),
            ("logid", self.logid().await),
        ]);
        let response = self
            .post(
                "/share/transfer",
                &params,
                &[
                    ("fsidlist".into(), json!(ids).to_string()),
                    ("path".into(), dir.into()),
                ],
                "转存",
                true,
            )
            .await?;
        self.check_items(&response)?;
        Ok(transfer_ids(&response))
    }
    fn ids(&self, files: &[File]) -> Result<Vec<u64>, DriveError> {
        if files.is_empty() || files.len() > 1000 {
            return Err(self
                .wire
                .error(ErrorKind::Input, "百度单次写操作必须为 1～1000 项"));
        }
        let ids = files
            .iter()
            .map(|f| f.id.parse::<u64>().ok().filter(|n| *n > 0))
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| self.wire.error(ErrorKind::Input, "百度文件 ID 无效"))?;
        if ids.iter().collect::<HashSet<_>>().len() != ids.len() {
            return Err(self.wire.error(ErrorKind::Input, "百度文件 ID 重复"));
        }
        Ok(ids)
    }
    fn check_items(&self, response: &Value) -> Result<(), DriveError> {
        if let Some(items) = response["info"].as_array() {
            for item in items {
                if let Some(code) = item["errno"].as_i64().filter(|c| *c != 0) {
                    let mut err = DriveError::from_code(super::Provider::Baidu, code);
                    err.message = format!(
                        "部分文件操作失败或未完成：{}；请检查云端状态，不要盲目重试",
                        err.message
                    );
                    return Err(err);
                }
            }
        }
        Ok(())
    }
    pub async fn share(&self, files: &[File]) -> Result<Value, DriveError> {
        self.share_days(files, 0).await
    }
    pub async fn share_days(&self, files: &[File], days: u32) -> Result<Value, DriveError> {
        if ![0, 1, 7, 30].contains(&days) {
            return Err(self
                .wire
                .error(ErrorKind::Input, "百度分享期限必须为1、7或30天"));
        }
        let (token, _) = self.token().await?;
        let ids = self.ids(files)?;
        let chars = b"abcdefghijklmnopqrstuvwxyz0123456789";
        use rand::Rng;
        let pwd: String = (0..4)
            .map(|_| chars[rand::rng().random_range(0..chars.len())] as char)
            .collect();
        let mut params = self.params();
        params.push(("bdstoken", token));
        let response = self
            .post(
                "/share/set",
                &params,
                &[
                    ("period".into(), days.to_string()),
                    ("pwd".into(), pwd.clone()),
                    ("eflag_disable".into(), "true".into()),
                    ("channel_list".into(), "[]".into()),
                    ("schannel".into(), "4".into()),
                    ("fid_list".into(), json!(ids).to_string()),
                ],
                "创建分享",
                true,
            )
            .await?;
        let link = scalar(&response["link"]);
        let parsed = super::ShareInput {
            url: link,
            provider: Some(super::Provider::Baidu),
            password: None,
        }
        .parse()
        .map_err(|_| {
            self.wire
                .error(ErrorKind::Upstream, "百度未返回有效分享链接")
        })?;
        Ok(json!({"url":parsed.url,"password":pwd,"shareId":scalar(&response["shareid"])}))
    }
    pub async fn owned(&self, ctx: &Context) -> Result<(), DriveError> {
        let (_, uk) = self.token().await?;
        if uk.is_empty() || uk != ctx.owner {
            return Err(self.wire.error(
                ErrorKind::Ownership,
                "该分享不属于当前百度账号，拒绝删除他人分享资源",
            ));
        }
        Ok(())
    }
    pub async fn create_directory(&self, parent: &str, name: &str) -> Result<File, DriveError> {
        let (token, _) = self.token().await?;
        let path = format!("{}/{}", parent.trim_end_matches('/'), name);
        let mut params = self.params();
        params.push(("bdstoken", token));
        let value = self
            .post(
                "/api/create",
                &params,
                &[
                    ("path".into(), path),
                    ("isdir".into(), "1".into()),
                    ("block_list".into(), "[]".into()),
                ],
                "创建交付目录",
                true,
            )
            .await?;
        let mut file = self.file(&value)?;
        // The create response carries no server_filename; the name must come
        // from the returned path so ownership evidence records what actually
        // landed (Baidu may append a suffix when the name already exists).
        if file.name.is_empty() {
            file.name = file
                .path
                .rsplit('/')
                .next()
                .filter(|segment| !segment.is_empty())
                .unwrap_or(name)
                .to_owned();
        }
        Ok(file)
    }
    pub async fn revoke_share(&self, id: &str) -> Result<(), DriveError> {
        let (token, _) = self.token().await?;
        let mut params = self.params();
        params.push(("bdstoken", token));
        let id = id
            .parse::<u64>()
            .map_err(|_| self.wire.error(ErrorKind::Input, "百度分享ID无效"))?;
        self.post(
            "/share/cancel",
            &params,
            &[("shareid_list".into(), json!([id]).to_string())],
            "撤销交付分享",
            true,
        )
        .await?;
        Ok(())
    }
    pub async fn delete(&self, files: &[File]) -> Result<(), DriveError> {
        let (token, _) = self.token().await?;
        let ids = self.ids(files)?;
        let mut params = self.params();
        params.extend([
            ("opera", "delete".into()),
            ("async", "0".into()),
            ("bdstoken", token),
            ("logid", self.logid().await),
        ]);
        // The live filemanager rejects fs_id-only entries with errno 12; each
        // entry must carry the absolute path next to the fs_id, exactly like
        // the web client sends it.
        let filelist = ids
            .iter()
            .zip(files.iter())
            .map(|(id, file)| {
                let mut item = json!({"fs_id": id});
                if !file.path.is_empty() {
                    item["path"] = json!(file.path);
                }
                item
            })
            .collect::<Vec<_>>();
        let response = self
            .post(
                "/api/filemanager",
                &params,
                &[("filelist".into(), json!(filelist).to_string())],
                "删除我的文件",
                true,
            )
            .await?;
        self.check_items(&response)?;
        Ok(())
    }
}

/// Extract the identities the transfer created. The live response carries them
/// in `extra.list[].to_fs_id`; `info[]` only echoes the source fsid. Older
/// captures exposed to_fs_id/new_fs_id directly on info[], so both shapes stay
/// supported; an empty result stays an error upstream instead of a silent 0.
fn transfer_ids(response: &Value) -> Vec<String> {
    let from_extra: Vec<String> = response["extra"]["list"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("to_fs_id"))
                .map(scalar)
                .filter(|id| !id.is_empty())
                .collect()
        })
        .unwrap_or_default();
    if !from_extra.is_empty() {
        return from_extra;
    }
    response["info"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("to_fs_id").or_else(|| item.get("new_fs_id")))
                .map(scalar)
                .filter(|id| !id.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transfer_ids_come_from_extra_list_and_fall_back_to_info() {
        // Captured from pan.baidu.com/share/transfer on 2026-10-03: info[] has
        // no to_fs_id, the identities live under extra.list.
        let live = json!({
            "errno": 0,
            "extra": {"list": [
                {"from": "/share", "from_fs_id": 35671588331591u64, "to": "/target/share", "to_fs_id": 848731236733481u64},
                {"from": "/share2", "from_fs_id": 42, "to": "/target/share2", "to_fs_id": 99}
            ]},
            "info": [{"errno": 0, "fsid": 35671588331591u64, "path": "/share"}],
            "task_id": 0
        });
        assert_eq!(transfer_ids(&live), vec!["848731236733481", "99"]);
        // Legacy responses exposed the ids directly on info[].
        let legacy =
            json!({"errno":0,"info":[{"errno":0,"to_fs_id":"123"},{"errno":0,"new_fs_id":"456"}]});
        assert_eq!(transfer_ids(&legacy), vec!["123", "456"]);
        // A rejected item or an empty envelope yields nothing for the caller
        // to treat as "everything transferred".
        assert!(transfer_ids(&json!({"errno":0,"info":[{"errno":12,"path":"/x"}]})).is_empty());
        assert!(transfer_ids(&json!({"errno":0})).is_empty());
    }
}
