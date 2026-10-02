use super::common::{admin_only, ok};
use crate::{
    app::AppState,
    cloud_drive::{self, Drive, File, Provider, Reference, SaveInput, ShareInput},
    error::ApiError,
};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::{sync::Arc, time::Duration};
use uuid::Uuid;
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub url: Option<String>,
    pub provider: Option<Provider>,
    pub password: Option<String>,
    pub resource_id: Option<String>,
    pub link_index: Option<usize>,
}
async fn reference(state: &AppState, target: &Target) -> Result<Reference, ApiError> {
    if target.url.is_some() && target.resource_id.is_some() {
        return Err(ApiError::BadRequest(
            "url 和 resourceId 只能选择一个".into(),
        ));
    }
    if let Some(url) = &target.url {
        return ShareInput {
            url: url.clone(),
            provider: target.provider,
            password: target.password.clone(),
        }
        .parse();
    }
    let id = target
        .resource_id
        .as_deref()
        .ok_or_else(|| ApiError::BadRequest("需要分享链接或资源 ID".into()))?;
    let index = target
        .link_index
        .ok_or_else(|| ApiError::BadRequest("需要 linkIndex".into()))?;
    let links = sqlx::query_scalar::<_, Value>(
        "SELECT links_json FROM managed_resources WHERE id=$1 AND deleted_at IS NULL",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::NotFound("资源不存在".into()))?;
    let link = links
        .as_array()
        .and_then(|a| a.get(index))
        .ok_or_else(|| ApiError::BadRequest("链接索引不存在".into()))?;
    let provider = Provider::from_name(link["type"].as_str().unwrap_or(""))?;
    ShareInput {
        url: link["url"].as_str().unwrap_or("").into(),
        provider: Some(provider),
        password: link["password"].as_str().map(str::to_owned),
    }
    .parse()
}
async fn slot(state: &AppState) -> Result<tokio::sync::OwnedSemaphorePermit, ApiError> {
    state
        .cloud_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::Unavailable("网盘操作繁忙，请稍后再试".into()))
}
fn fingerprint(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string()))
}
fn preview_identity(drive: &Drive, r: &Reference) -> String {
    fingerprint(&json!({"account":drive.account,"url":r.url,"password":r.password}))
}
fn file_identity(files: &[File]) -> String {
    let mut items = files
        .iter()
        .map(|f| json!({"id":f.id,"name":f.name,"size":f.size,"isDir":f.is_dir}))
        .collect::<Vec<_>>();
    items.sort_by_key(|v| v["id"].as_str().unwrap_or("").to_owned());
    fingerprint(&json!(items))
}
fn parse<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, ApiError> {
    serde_json::from_value(value)
        .map_err(|_| ApiError::BadRequest("网盘请求字段缺失或格式不正确".into()))
}
fn uuid(key: &str) -> Result<Uuid, ApiError> {
    Uuid::parse_str(key)
        .map_err(|_| ApiError::BadRequest("requestKey / confirmationToken 必须是 UUID".into()))
}
fn response(status: u16, body: Value) -> Response {
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        Json(body),
    )
        .into_response()
}
fn running(key: Uuid) -> Value {
    json!({"code":0,"message":"网盘操作处理中，请查询操作状态，不要重新提交","data":{"status":"running","requestKey":key}})
}
fn failure(error: ApiError, uncertain: bool, key: Uuid) -> (u16, Value) {
    let status = error.status().as_u16();
    (
        status,
        json!({"message":error.to_string(),"statusCode":status,"statusMessage":error.to_string(),"data":{"status":if uncertain{"uncertain"}else{"failed"},"requestKey":key}}),
    )
}

pub async fn cloud_check(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(value): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    let target: Target = parse(value)?;
    let r = reference(&state, &target).await?;
    let _slot = slot(&state).await?;
    let drive = Drive::load(&state, r.provider).await?;
    let value = drive.check(&r).await;
    crate::link_resolution::record_check(
        &state,
        &crate::models::Link {
            r#type: r.provider.name().into(),
            url: r.url.clone(),
            password: Some(r.password.clone()).filter(|s| !s.is_empty()),
        },
        &value,
    )
    .await?;
    Ok(ok(value))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Directory {
    provider: Provider,
    dir: Option<String>,
}
pub async fn cloud_list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(value): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    let input: Directory = parse(value)?;
    let dir = cloud_drive::validate_dir(input.provider, input.dir.as_deref())?;
    let _slot = slot(&state).await?;
    let drive = Drive::load(&state, input.provider).await?;
    let files = tokio::time::timeout(Duration::from_secs(60), drive.list(&dir))
        .await
        .map_err(|_| ApiError::Upstream("列目录超时".into()))?
        .map_err(|e| e.api())?;
    Ok(ok(
        json!({"provider":input.provider,"dir":dir,"files":files,"count":files.len()}),
    ))
}
pub async fn cloud_ping(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(value): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    let input: Directory = parse(value)?;
    let _slot = slot(&state).await?;
    let drive = Drive::load(&state, input.provider).await?;
    let root = cloud_drive::validate_dir(input.provider, None)?;
    if input.provider.token_auth() {
        let mut connection = state.pool.acquire().await?;
        tokio::time::timeout(Duration::from_secs(45), drive.ensure_current_account(&mut connection))
            .await.map_err(|_| ApiError::Upstream("账号身份检测超时".into()))??;
    }
    let files = tokio::time::timeout(Duration::from_secs(45), drive.list(&root))
        .await
        .map_err(|_| ApiError::Upstream("登录态检测超时".into()))?
        .map_err(|e| e.api())?;
    Ok(ok(
        json!({"provider":input.provider,"ok":true,"count":files.len()}),
    ))
}

pub async fn cloud_delete_preview(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(value): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let actor = admin_only(&headers, &state).await?.user_id.unwrap();
    let target: Target = parse(value)?;
    let r = reference(&state, &target).await?;
    let _slot = slot(&state).await?;
    let drive = Drive::load(&state, r.provider).await?;
    let ctx = tokio::time::timeout(Duration::from_secs(60), async {
        let ctx = drive.resolve(&r).await?;
        drive.owned(&ctx).await?;
        Ok::<_, cloud_drive::DriveError>(ctx)
    })
    .await
    .map_err(|_| ApiError::Upstream("删除预检超时，未执行删除".into()))?
    .map_err(|e| e.api())?;
    if ctx.files.is_empty() || ctx.files.len() > 1000 {
        return Err(ApiError::BadRequest(
            "单次删除必须为 1～1000 个顶层文件/目录".into(),
        ));
    }
    let token = Uuid::new_v4();
    let identity = preview_identity(&drive, &r);
    sqlx::query("INSERT INTO cloud_delete_previews(token,actor_id,fingerprint,files_json) VALUES($1,$2,$3,$4)").bind(token).bind(actor).bind(identity).bind(json!(ctx.files)).execute(&state.pool).await?;
    Ok(ok(
        json!({"provider":r.provider,"confirmationToken":token,"expiresIn":300,"count":ctx.files.len(),"files":ctx.files,"warning":"只删除当前账号分享的顶层条目；删除目录会包含目录下所有内容，盘搜记录不会被删除"}),
    ))
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteInput {
    #[serde(flatten)]
    target: Target,
    confirmation_token: String,
    request_key: String,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExistingInput {
    #[serde(flatten)]
    link: ShareInput,
    to_dir: Option<String>,
    #[serde(default)]
    auto_share: bool,
    request_key: Option<String>,
}
#[derive(Clone)]
enum Action {
    Save(SaveInput, Reference),
    Delete(DeleteInput, Reference),
    Existing(ExistingInput, Reference),
}
impl Action {
    fn name(&self) -> &'static str {
        match self {
            Self::Save(..) => "save",
            Self::Delete(..) => "delete",
            Self::Existing(..) => "existing",
        }
    }
}

async fn existing(drive: &Drive, input: &ExistingInput, r: &Reference) -> Result<Value, ApiError> {
    let dir = cloud_drive::validate_dir(r.provider, input.to_dir.as_deref())?;
    let ctx = drive.resolve(r).await.map_err(|e| e.api())?;
    let mine = drive.list(&dir).await.map_err(|e| e.api())?;
    let (matched, missing) = cloud_drive::match_existing(r.provider, &ctx.files, &mine);
    let share = if input.auto_share && !matched.is_empty() {
        drive.share(&matched).await.map_err(|e| e.api())?
    } else {
        Value::Null
    };
    Ok(
        json!({"provider":r.provider,"alreadyExists":!matched.is_empty(),"complete":missing.is_empty(),"matched":matched,"missing":missing,"share":share,"timings":drive.wire.trace.lock().await.clone()}),
    )
}
async fn execute(
    state: &AppState,
    actor: i64,
    key: Uuid,
    drive: &Drive,
    action: &Action,
) -> Result<Value, ApiError> {
    match action {
        Action::Save(input, r) => drive.save(input, r).await.map_err(|e| e.api()),
        Action::Existing(input, r) => existing(drive, input, r).await,
        Action::Delete(input, r) => {
            let token = uuid(&input.confirmation_token)?;
            let identity = preview_identity(drive, r);
            let preview=sqlx::query("SELECT files_json FROM cloud_delete_previews WHERE token=$1 AND actor_id=$2 AND fingerprint=$3 AND expires_at>now() AND (used_by IS NULL OR used_by=$4)").bind(token).bind(actor).bind(&identity).bind(key).fetch_optional(&state.pool).await?.ok_or_else(||ApiError::Conflict("删除确认已失效或登录态已变化，请重新预检".into()))?;
            let expected: Vec<File> = serde_json::from_value(preview.get("files_json"))
                .map_err(|_| ApiError::Internal("删除预检数据损坏".into()))?;
            let ctx = drive.resolve(r).await.map_err(|e| e.api())?;
            drive.owned(&ctx).await.map_err(|e| e.api())?;
            if file_identity(&ctx.files) != file_identity(&expected) {
                return Err(ApiError::Conflict(
                    "分享文件列表已变化，请重新查看并确认".into(),
                ));
            }
            let consumed=sqlx::query("UPDATE cloud_delete_previews SET used_by=$4 WHERE token=$1 AND actor_id=$2 AND fingerprint=$3 AND used_by IS NULL AND expires_at>now()").bind(token).bind(actor).bind(identity).bind(key).execute(&state.pool).await?.rows_affected();
            if consumed != 1 {
                return Err(ApiError::Conflict("删除确认已使用，请勿重复执行".into()));
            }
            drive.delete_files(&ctx.files).await.map_err(|e| e.api())?;
            sqlx::query("UPDATE link_share_cache SET state='invalid',share_validity=0,last_error_code='admin_cloud_delete',updated_at=now() WHERE target_account_key=$1 AND state='ready'").bind(&drive.account).execute(&state.pool).await?;
            Ok(
                json!({"provider":r.provider,"deleted":ctx.files.len(),"deletedCount":ctx.files.len(),"names":ctx.files.iter().map(|f|&f.name).collect::<Vec<_>>(),"timings":drive.wire.trace.lock().await.clone()}),
            )
        }
    }
}
async fn operation(
    state: Arc<AppState>,
    actor: i64,
    key: Uuid,
    payload: Value,
    drive: Drive,
    action: Action,
) -> Result<Response, ApiError> {
    let identity = fingerprint(
        &json!({"actor":actor,"action":action.name(),"account":drive.account,"payload":payload}),
    );
    let inserted=sqlx::query("INSERT INTO cloud_drive_operations(request_key,actor_id,provider,action,fingerprint) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING").bind(key).bind(actor).bind(drive.wire.provider.name()).bind(action.name()).bind(&identity).execute(&state.pool).await?.rows_affected();
    if inserted == 0 {
        let row=sqlx::query("SELECT actor_id,fingerprint,status,http_status,response_json FROM cloud_drive_operations WHERE request_key=$1").bind(key).fetch_one(&state.pool).await?;
        if row.get::<i64, _>("actor_id") != actor || row.get::<String, _>("fingerprint") != identity
        {
            return Err(ApiError::Conflict(
                "requestKey 已用于其他参数，请勿复用".into(),
            ));
        }
        return stored_operation(&state, actor, key).await;
    }
    let mut task = tokio::spawn(async move {
        let result = tokio::time::timeout(Duration::from_secs(180), async {
            let _slot = slot(&state).await?;
            let mut tx = state.pool.begin().await?;
            let locked: bool =
                sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0))")
                    .bind(format!("pansou:cloud-write:{}", drive.wire.provider.name()))
                    .fetch_one(&mut *tx)
                    .await?;
            if !locked {
                return Err(ApiError::Conflict(
                    "当前网盘已有写操作运行，请稍后再试".into(),
                ));
            }
            // Settings writes use the same lock; reject an account changed while awaiting it.
            drive.ensure_current_account(&mut tx).await?;
            let value = execute(&state, actor, key, &drive, &action).await?;
            tx.commit().await?;
            Ok::<_, ApiError>(value)
        })
        .await;
        let (status, body, operation_status) = match result {
            Ok(Ok(mut value)) => {
                value["requestKey"] = json!(key);
                value["status"] = json!("completed");
                (
                    200,
                    json!({"code":0,"message":"success","data":value}),
                    "completed",
                )
            }
            err => {
                let uncertain = drive.wrote();
                let api = match err {
                    Ok(Err(e)) => e,
                    _ => ApiError::Upstream(
                        "网盘操作超过时限；状态未确认，请先核对云端，不要重复提交".into(),
                    ),
                };
                let (s, b) = failure(api, uncertain, key);
                (s, b, if uncertain { "uncertain" } else { "failed" })
            }
        };
        sqlx::query("UPDATE cloud_drive_operations SET status=$2,http_status=$3,response_json=$4,updated_at=now() WHERE request_key=$1 AND status='running'").bind(key).bind(operation_status).bind(status as i32).bind(&body).execute(&state.pool).await?;
        Ok::<_, ApiError>(response(status, body))
    });
    tokio::select! {result=&mut task=>result.map_err(|_|ApiError::Internal("网盘任务异常退出，请通过 requestKey 查询状态".into()))?,_=tokio::time::sleep(Duration::from_secs(25))=>Ok(response(202,running(key)))}
}
async fn stored_operation(state: &AppState, actor: i64, key: Uuid) -> Result<Response, ApiError> {
    let expired = json!({"message":"服务中断或操作超时，结果未确认，请先核对云端，不要重新提交","statusCode":409,"data":{"status":"uncertain","requestKey":key}});
    sqlx::query("UPDATE cloud_drive_operations SET status='uncertain',http_status=409,response_json=$3,updated_at=now() WHERE request_key=$1 AND actor_id=$2 AND status='running' AND expires_at<=now()").bind(key).bind(actor).bind(expired).execute(&state.pool).await?;
    let row=sqlx::query("SELECT status,http_status,response_json FROM cloud_drive_operations WHERE request_key=$1 AND actor_id=$2").bind(key).bind(actor).fetch_optional(&state.pool).await?.ok_or_else(||ApiError::NotFound("网盘操作不存在".into()))?;
    if row.get::<String, _>("status") == "running" {
        Ok(response(202, running(key)))
    } else {
        Ok(response(
            row.get::<i32, _>("http_status") as u16,
            row.get("response_json"),
        ))
    }
}
pub async fn cloud_operation_get(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(key): Path<String>,
) -> Result<Response, ApiError> {
    let actor = admin_only(&headers, &state).await?.user_id.unwrap();
    stored_operation(&state, actor, uuid(&key)?).await
}
pub async fn cloud_save(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(value): Json<Value>,
) -> Result<Response, ApiError> {
    let actor = admin_only(&headers, &state).await?.user_id.unwrap();
    let input: SaveInput = parse(value.clone())?;
    let r = input.link.parse()?;
    cloud_drive::validate_dir(r.provider, input.to_dir.as_deref())?;
    let key = uuid(&input.request_key)?;
    let drive = Drive::load(&state, r.provider).await?;
    operation(state, actor, key, value, drive, Action::Save(input, r)).await
}
pub async fn cloud_delete(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(value): Json<Value>,
) -> Result<Response, ApiError> {
    let actor = admin_only(&headers, &state).await?.user_id.unwrap();
    let input: DeleteInput = parse(value.clone())?;
    let r = reference(&state, &input.target).await?;
    let key = uuid(&input.request_key)?;
    uuid(&input.confirmation_token)?;
    let drive = Drive::load(&state, r.provider).await?;
    operation(state, actor, key, value, drive, Action::Delete(input, r)).await
}
pub async fn cloud_existing(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(value): Json<Value>,
) -> Result<Response, ApiError> {
    let actor = admin_only(&headers, &state).await?.user_id.unwrap();
    let input: ExistingInput = parse(value.clone())?;
    let r = input.link.parse()?;
    cloud_drive::validate_dir(r.provider, input.to_dir.as_deref())?;
    let drive = Drive::load(&state, r.provider).await?;
    if input.auto_share {
        let key = uuid(
            input
                .request_key
                .as_deref()
                .ok_or_else(|| ApiError::BadRequest("创建分享需要 requestKey".into()))?,
        )?;
        operation(state, actor, key, value, drive, Action::Existing(input, r)).await
    } else {
        let _slot = slot(&state).await?;
        let result = tokio::time::timeout(Duration::from_secs(60), existing(&drive, &input, &r))
            .await
            .map_err(|_| ApiError::Upstream("检测已有资源超时".into()))??;
        Ok(ok(result).into_response())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CheckBatch {
    ids: Vec<String>,
}
pub async fn resources_check(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(value): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    admin_only(&headers, &state).await?;
    let input: CheckBatch = parse(value)?;
    if input.ids.is_empty()
        || input.ids.len() > 50
        || input.ids.iter().any(|s| s.is_empty() || s.len() > 256)
    {
        return Err(ApiError::BadRequest("请选择 1～50 个资源".into()));
    }
    let mut ids = input.ids;
    ids.sort();
    ids.dedup();
    let rows = sqlx::query(
        "SELECT id,links_json FROM managed_resources WHERE id=ANY($1) AND deleted_at IS NULL",
    )
    .bind(&ids)
    .fetch_all(&state.pool)
    .await?;
    let found = rows
        .iter()
        .map(|r| r.get::<String, _>("id"))
        .collect::<std::collections::HashSet<_>>();
    let mut results = ids
        .iter()
        .filter(|id| !found.contains(*id))
        .map(|id| json!({"id":id,"status":"invalid","message":"资源不存在"}))
        .collect::<Vec<_>>();
    let mut credentials=std::collections::HashMap::new();
    for p in Provider::ALL {
        if let Ok(Some(account))=crate::cloud_auth::credentials(&state,p).await {
            if let Ok(raw)=account.raw(p){credentials.insert(p.name().to_owned(),raw);}
        }
    }
    let credentials = Arc::new(credentials);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
    use futures::{StreamExt, stream};
    let jobs = rows.into_iter().map(|row| {
        check_resource(
            state.clone(),
            credentials.clone(),
            row.get("id"),
            row.get("links_json"),
            deadline,
        )
    });
    let mut pending = stream::iter(jobs).buffer_unordered(4);
    while let Some(result) = pending.next().await {
        results.push(result?);
    }
    let valid = results.iter().filter(|r| r["status"] == "valid").count();
    let invalid = results.iter().filter(|r| r["status"] == "invalid").count();
    let unknown = results.len() - valid - invalid;
    Ok(ok(
        json!({"results":results,"count":results.len(),"valid":valid,"invalid":invalid,"unknown":unknown}),
    ))
}

async fn check_resource(
    state: Arc<AppState>,
    credentials: Arc<std::collections::HashMap<String, String>>,
    id: String,
    links: Value,
    deadline: tokio::time::Instant,
) -> Result<Value, ApiError> {
    let check = async {
        let _permit = slot(&state).await?;
        let mut statuses = vec![];
        for link in links.as_array().into_iter().flatten().take(20) {
            let provider = match Provider::from_name(link["type"].as_str().unwrap_or("")) {
                Ok(provider) => provider,
                Err(_) => {
                    statuses.push(json!({"status":"unknown","reason":"该网盘暂不支持原生检测"}));
                    continue;
                }
            };
            let input = ShareInput {
                url: link["url"].as_str().unwrap_or("").into(),
                provider: Some(provider),
                password: link["password"].as_str().map(str::to_owned),
            };
            let result = match input.parse() {
                Ok(reference) => {
                    // Each link gets a separate ephemeral Cookie jar: Baidu BDCLND is share-scoped.
                    let drive = Drive::from_state(
                        &state,
                        provider,
                        credentials
                            .get(provider.name())
                            .cloned()
                            .unwrap_or_default(),
                    );
                    tokio::time::timeout(Duration::from_secs(15), drive.check(&reference))
                        .await
                        .unwrap_or_else(
                            |_| json!({"status":"unknown","reason":"检测超时，未判定失效"}),
                        )
                }
                Err(_) => json!({"status":"unknown","reason":"分享链接格式异常"}),
            };
            let original = crate::models::Link {
                r#type: provider.name().into(),
                url: input.url.clone(),
                password: input.password.clone(),
            };
            crate::link_resolution::record_check(&state, &original, &result).await?;
            statuses.push(result);
        }
        if links.as_array().is_some_and(|a| a.len() > 20) {
            statuses.push(json!({"status":"unknown","reason":"资源链接过多，未完整检测"}));
        }
        let status = if statuses.iter().any(|s| s["status"] == "valid") {
            "valid"
        } else if !statuses.is_empty() && statuses.iter().all(|s| s["status"] == "invalid") {
            "invalid"
        } else {
            "unknown"
        };
        let message = if status == "valid" {
            "至少一个链接有效".to_owned()
        } else {
            statuses
                .iter()
                .filter_map(|v| v["reason"].as_str())
                .take(3)
                .collect::<Vec<_>>()
                .join("；")
        };
        Ok::<_, ApiError>((status.to_owned(), message, statuses))
    };
    let (status, message, links_result) = match tokio::time::timeout_at(deadline, check).await {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => ("unknown".into(), e.to_string(), vec![]),
        Err(_) => (
            "unknown".into(),
            "批量检测到达时限，未判定链接失效".into(),
            vec![],
        ),
    };
    let changed = sqlx::query("UPDATE managed_resources SET check_status=$2,check_message=$3,checked_at=now(),link_validity=CASE $2 WHEN 'valid' THEN 1 WHEN 'invalid' THEN 0 ELSE -1 END,link_validity_updated_at=now() WHERE id=$1 AND deleted_at IS NULL AND links_json=$4")
        .bind(&id).bind(&status).bind(&message).bind(&links).execute(&state.pool).await?;
    Ok(
        json!({"id":id,"status":if changed.rows_affected()==1{status.as_str()}else{"unknown"},"message":if changed.rows_affected()==1{message.as_str()}else{"资源链接已改变，请重新检测"},"links":links_result}),
    )
}
