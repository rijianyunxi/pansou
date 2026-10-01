use super::{
    Context, DriveError, ErrorKind, File, Reference, list_field, scalar, transport::Wire, valid_id,
};
use reqwest::Method;
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use url::Url;
#[derive(Clone)]
pub struct Quark {
    pub wire: Wire,
    pub share_base: Url,
    pub pc_base: Url,
}
impl Quark {
    pub fn new(wire: Wire) -> Self {
        Self {
            wire,
            share_base: Url::parse("https://drive.quark.cn/1/clouddrive/").unwrap(),
            pc_base: Url::parse("https://drive-pc.quark.cn/1/clouddrive/").unwrap(),
        }
    }
    fn url(&self, pc: bool, path: &str, params: &[(&str, String)]) -> Url {
        let mut url = if pc { &self.pc_base } else { &self.share_base }
            .join(path)
            .expect("fixed Quark path");
        url.query_pairs_mut()
            .extend_pairs([
                ("pr", "ucpro"),
                ("fr", "pc"),
                ("uc_param_str", ""),
                ("__dt", "1000"),
            ])
            .append_pair("__t", &chrono::Utc::now().timestamp_millis().to_string())
            .extend_pairs(params.iter().map(|(k, v)| (*k, v.as_str())));
        url
    }
    async fn get(
        &self,
        pc: bool,
        path: &str,
        params: &[(&str, String)],
        step: &str,
    ) -> Result<Value, DriveError> {
        self.wire
            .json(
                Method::GET,
                self.url(pc, path, params),
                None,
                None,
                step,
                false,
            )
            .await
    }
    async fn post(
        &self,
        pc: bool,
        path: &str,
        body: Value,
        step: &str,
        write: bool,
    ) -> Result<Value, DriveError> {
        self.wire
            .json(
                Method::POST,
                self.url(pc, path, &[]),
                None,
                Some(&body),
                step,
                write,
            )
            .await
    }
    pub async fn resolve(&self, r: &Reference) -> Result<Context, DriveError> {
        let token=self.post(false,"share/sharepage/token",json!({"pwd_id":r.key,"passcode":r.password,"support_visit_limit_private_share":true}),"取分享令牌",false).await?;
        let token = scalar(&token["data"]["stoken"]);
        if token.is_empty() {
            return Err(self.wire.error(
                ErrorKind::Password,
                "无法取得夸克分享令牌，请检查链接及提取码",
            ));
        }
        let mut files = vec![];
        let mut title = String::new();
        for page in 1..=50 {
            let value = self
                .get(
                    false,
                    "share/sharepage/detail",
                    &[
                        ("pwd_id", r.key.clone()),
                        ("stoken", token.clone()),
                        ("pdir_fid", "0".into()),
                        ("_page", page.to_string()),
                        ("_size", "200".into()),
                        ("_fetch_total", "1".into()),
                        ("_sort", "file_type:asc,file_name:asc".into()),
                    ],
                    "读分享目录",
                )
                .await?;
            let list = list_field(&value, "/data/list", &self.wire)?;
            if page == 1 {
                title = scalar(&value["data"]["share"]["title"]);
            }
            for item in list {
                files.push(self.file(item)?);
            }
            if list.len() < 200 {
                return Ok(Context {
                    reference: r.clone(),
                    title,
                    files,
                    token,
                    owner: String::new(),
                    share_id: String::new(),
                });
            }
        }
        Err(self
            .wire
            .error(ErrorKind::Limit, "分享顶层条目超过 10000，拒绝截断后操作"))
    }
    fn file(&self, v: &Value) -> Result<File, DriveError> {
        let id = scalar(&v["fid"]);
        if !valid_id(&id, false) {
            return Err(self
                .wire
                .error(ErrorKind::Upstream, "夸克返回了无效文件 ID"));
        }
        Ok(File {
            id,
            name: v["file_name"]
                .as_str()
                .or_else(|| v["filename"].as_str())
                .unwrap_or("")
                .into(),
            size: v["size"].as_u64().unwrap_or(0),
            is_dir: v["dir"]
                .as_bool()
                .unwrap_or_else(|| v["dir"].as_i64() == Some(1)),
            md5: String::new(),
            path: String::new(),
            token: scalar(&v["share_fid_token"]),
        })
    }
    pub async fn list(&self, dir: &str) -> Result<Vec<File>, DriveError> {
        self.wire.require_login().await?;
        let mut files = vec![];
        for page in 1..=50 {
            let value = self
                .get(
                    true,
                    "file/sort",
                    &[
                        ("pdir_fid", dir.into()),
                        ("_page", page.to_string()),
                        ("_size", "200".into()),
                        ("_fetch_total", "1".into()),
                        ("_sort", "file_type:asc,updated_at:desc".into()),
                    ],
                    "列我的目录",
                )
                .await?;
            let list = list_field(&value, "/data/list", &self.wire)?;
            for item in list {
                files.push(self.file(item)?);
            }
            if list.len() < 200 {
                return Ok(files);
            }
        }
        Err(self
            .wire
            .error(ErrorKind::Limit, "目标目录超过 10000 项，无法完整确认"))
    }
    async fn task(&self, task_id: &str) -> Result<Value, DriveError> {
        let start = Instant::now();
        let mut retry = 0;
        while start.elapsed() < Duration::from_secs(120) {
            let value = self
                .get(
                    true,
                    "task",
                    &[
                        ("task_id", task_id.into()),
                        ("retry_index", retry.to_string()),
                    ],
                    "等待任务",
                )
                .await?;
            retry += 1;
            match value["data"]["status"].as_i64() {
                Some(2) => return Ok(value["data"].clone()),
                Some(3) => return Err(self.wire.error(ErrorKind::Upstream, "夸克异步任务失败")),
                Some(0 | 1) => {}
                _ => return Err(self.wire.error(ErrorKind::Upstream, "夸克返回未知任务状态")),
            }
            let ms = if start.elapsed() < Duration::from_secs(3) {
                150
            } else {
                value["metadata"]["tq_gap"]
                    .as_u64()
                    .unwrap_or(1000)
                    .clamp(150, 1000)
            };
            tokio::time::sleep(Duration::from_millis(ms)).await;
        }
        Err(self.wire.error(
            ErrorKind::Network,
            "夸克任务未在时限内完成，结果未确认，请勿重复执行",
        ))
    }
    async fn completion(&self, response: &Value) -> Result<Value, DriveError> {
        let inline = &response["data"]["task_resp"]["data"];
        if inline["status"].as_i64() == Some(2) {
            return Ok(inline.clone());
        }
        if inline["status"].as_i64() == Some(3) {
            return Err(self.wire.error(ErrorKind::Upstream, "夸克任务失败"));
        }
        let task_id = scalar(&response["data"]["task_id"]);
        if !task_id.is_empty() {
            return self.task(&task_id).await;
        }
        Err(self.wire.error(
            ErrorKind::Upstream,
            "夸克未返回可确认的任务结果，不能判定完成",
        ))
    }
    pub async fn save(
        &self,
        ctx: &Context,
        files: &[File],
        dir: &str,
    ) -> Result<Vec<String>, DriveError> {
        if files.iter().any(|f| f.token.is_empty()) {
            return Err(self.wire.error(ErrorKind::Upstream, "分享缺少文件转存令牌"));
        }
        let result=self.post(true,"share/sharepage/save",json!({"fid_list":files.iter().map(|f|&f.id).collect::<Vec<_>>(),"fid_token_list":files.iter().map(|f|&f.token).collect::<Vec<_>>(),"pdir_fid":"0","pwd_id":ctx.reference.key,"scene":"link","stoken":ctx.token,"to_pdir_fid":dir}),"转存",true).await?;
        let task = self.completion(&result).await?;
        Ok(task["save_as"]["save_as_top_fids"]
            .as_array()
            .map(|ids| {
                ids.iter()
                    .map(scalar)
                    .filter(|s| valid_id(s, false))
                    .collect()
            })
            .unwrap_or_default())
    }
    pub async fn share(&self, files: &[File]) -> Result<Value, DriveError> {
        self.share_days(files, 0).await
    }
    pub async fn share_days(&self, files: &[File], days: u32) -> Result<Value, DriveError> {
        let pending = self.begin_share(files, days).await?;
        let mut share = self
            .finish_share(pending["shareId"].as_str().unwrap_or(""))
            .await?;
        share["shareExpiresAt"] = pending["shareExpiresAt"].clone();
        Ok(share)
    }
    pub async fn begin_share(&self, files: &[File], days: u32) -> Result<Value, DriveError> {
        self.wire.require_login().await?;
        if files.is_empty() {
            return Err(self.wire.error(ErrorKind::Input, "没有可分享文件"));
        }
        let mut body = json!({"fid_list":files.iter().map(|f|&f.id).collect::<Vec<_>>(),"title":"pansou 分享","url_type":1,"expired_type":if days==0{1}else{2},"expire_time":0});
        let expires = (days > 0).then(|| chrono::Utc::now() + chrono::Duration::days(days as i64));
        if let Some(expires) = expires {
            body["expired_at"] = json!(expires.timestamp_millis());
        }
        let value = self.post(true, "share", body, "创建分享", true).await?;
        let mut id = scalar(&value["data"]["share_id"]);
        if id.is_empty() {
            id = scalar(&value["data"]["task_resp"]["data"]["share_id"]);
        }
        if id.is_empty() {
            id = scalar(&self.completion(&value).await?["share_id"]);
        }
        if id.is_empty() {
            return Err(self.wire.error(ErrorKind::Upstream, "夸克未返回分享 ID"));
        }
        Ok(json!({"shareId":id,"shareExpiresAt":expires}))
    }
    pub async fn finish_share(&self, id: &str) -> Result<Value, DriveError> {
        let password = self
            .post(
                true,
                "share/password",
                json!({"share_id":id}),
                "取分享链接",
                false,
            )
            .await?;
        let url = scalar(&password["data"]["share_url"]);
        let parsed = super::ShareInput {
            url: url.clone(),
            provider: Some(super::Provider::Quark),
            password: None,
        }
        .parse()
        .map_err(|_| {
            self.wire
                .error(ErrorKind::Upstream, "夸克返回了非法分享链接")
        })?;
        Ok(json!({"shareId":id,"url":parsed.url,"password":scalar(&password["data"]["share_pwd"])}))
    }
    pub async fn owned(&self, ctx: &Context) -> Result<(), DriveError> {
        self.wire.require_login().await?;
        // The authenticated account's share list, not public FIDs, is the ownership proof.
        for page in 1..=50 {
            let value = self
                .get(
                    true,
                    "share/mypage/detail",
                    &[
                        ("_page", page.to_string()),
                        ("_size", "100".into()),
                        ("_order_field", "created_at".into()),
                        ("_order_type", "desc".into()),
                    ],
                    "核实分享归属",
                )
                .await?;
            let list = list_field(&value, "/data/list", &self.wire)?;
            if list.iter().any(|v| {
                if v["is_owner"] != 1 && v["is_owner"] != true {
                    return false;
                }
                scalar(&v["pwd_id"]) == ctx.reference.key
                    || v["share_url"].as_str().is_some_and(|s| {
                        super::ShareInput {
                            url: s.into(),
                            provider: Some(super::Provider::Quark),
                            password: None,
                        }
                        .parse()
                        .is_ok_and(|r| r.key == ctx.reference.key)
                    })
            }) {
                return Ok(());
            }
            if list.len() < 100 {
                break;
            }
        }
        Err(self.wire.error(
            ErrorKind::Ownership,
            "未在当前夸克账号的分享列表找到该链接，拒绝删除他人分享资源",
        ))
    }
    pub async fn create_directory(&self, parent: &str, name: &str) -> Result<File, DriveError> {
        self.wire.require_login().await?;
        let value = self
            .post(
                true,
                "file",
                json!({"pdir_fid":parent,"file_name":name,"dir_path":"","dir_init_lock":false}),
                "创建交付目录",
                true,
            )
            .await?;
        let mut file = self.file(&value["data"])?;
        file.name = name.into();
        file.is_dir = true;
        Ok(file)
    }
    pub async fn revoke_share(&self, id: &str) -> Result<(), DriveError> {
        self.wire.require_login().await?;
        self.post(
            true,
            "share/delete",
            json!({"share_id":id}),
            "撤销交付分享",
            true,
        )
        .await?;
        Ok(())
    }
    pub async fn delete(&self, files: &[File]) -> Result<(), DriveError> {
        self.wire.require_login().await?;
        if files.is_empty() || files.iter().any(|f| !valid_id(&f.id, false)) {
            return Err(self.wire.error(ErrorKind::Input, "没有安全可删除的文件 ID"));
        }
        let response=self.post(true,"file/delete",json!({"action_type":2,"filelist":files.iter().map(|f|&f.id).collect::<Vec<_>>(),"exclude_fids":[]}),"删除我的文件",true).await?;
        self.completion(&response).await?;
        Ok(())
    }
}
