//! Mutating provider operations and asynchronous task confirmation.
use super::*;

impl Extended {
    pub(super) async fn wait_task(&self, id: &str) -> Result<(), DriveError> {
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
        self.transfer_with_listing(context, dir)
            .await
            .map(|(ids, _)| ids)
    }
    pub async fn transfer_with_listing(
        &self,
        context: &Context,
        dir: &str,
    ) -> Result<(Vec<String>, Option<Vec<File>>), DriveError> {
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
            // The share endpoint rejects our default RFC3339 serialization.
            // Use the canonical UTC milliseconds accepted by that endpoint.
            Provider::Aliyun=>self.post("adrive/v2/share_link/create",json!({"drive_id":self.drive_id,"file_id_list":ids,"expiration":expires.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),"share_pwd":"","share_name":"pansou 分享"}),None,true).await?,
            Provider::Xunlei=>self.post("drive/v1/share/batch",json!({"file_ids":ids,"need_password":true,"expiration_days":days}),None,true).await?,
            // shareType=0 disables extraction codes; autoFillCode only controls
            // whether a generated code is included in the platform's URL.
            Provider::Guangya=>self.post("nd.bizuserres.s/v1/share_file",json!({"fileIds":ids,"title":"pansou 分享","validateDuration":days*24*3600,"shareType":0,"code":"","autoFillCode":false,"downloadType":1,"trafficLimit":"0","maxRestoreCount":0}),None,true).await?,
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
        let canonical = ShareInput {
            url: canonical,
            provider: Some(self.wire.provider),
            password: Some(password.clone()),
        }
        .parse()
        .map_err(|_| self.wire.error(ErrorKind::Upstream, "平台返回非法分享 URL"))?
        .browser_url();
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
