//! Provider file normalization, pagination and share resolution.
use super::*;

impl Extended {
    pub(super) fn file(&self, value: &Value) -> Result<File, DriveError> {
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
    pub(super) fn array<'a>(&self, value: &'a Value) -> Result<&'a Vec<Value>, DriveError> {
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
        Err(self
            .wire
            .error(ErrorKind::Upstream, "目录响应缺少文件列表，拒绝当作空目录"))
    }
    pub(super) async fn listing(
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
}
