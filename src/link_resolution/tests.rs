use super::delivery::ProviderPolicy;
use super::*;
use crate::{cloud_drive::TestBases, redis_store::RedisStore};
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::State,
    http::Request,
    routing::any,
};
use sqlx::postgres::PgPoolOptions;
use tokio::sync::Mutex;
use tower::ServiceExt;
use url::Url;

#[derive(Default)]
struct Upstream {
    directories: HashMap<String, Value>,
    files: HashMap<String, Vec<Value>>,
    transfer_count: usize,
    share_count: usize,
    revoked: usize,
    deleted: usize,
    password_failure: bool,
    invalid: bool,
    source_error: bool,
    source_delay: bool,
    source_delay_ms: u64,
    directory_delay_ms: u64,
    transfer_delay_ms: u64,
    share_delay_ms: u64,
    finish_share_delay_ms: u64,
    empty_source: bool,
    unknown_file: bool,
    directory_reads: usize,
}
fn qfile(id: &str, name: &str, size: u64, dir: bool) -> Value {
    json!({"fid":id,"file_name":name,"size":size,"dir":dir,"share_fid_token":"fixture-token"})
}
async fn mock(State(state): State<Arc<Mutex<Upstream>>>, request: Request<Body>) -> Json<Value> {
    let path = request.uri().path().to_string();
    let url = Url::parse(&format!("http://mock{}", request.uri())).unwrap();
    let query: HashMap<_, _> = url.query_pairs().collect();
    let body = to_bytes(request.into_body(), 1024 * 1024).await.unwrap();
    let input: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let mut state = state.lock().await;
    if state.source_delay && path == "/qs/share/sharepage/token" && input["pwd_id"] != "ownshare" {
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    if state.source_delay_ms > 0 && path == "/qs/share/sharepage/token" && input["pwd_id"] != "ownshare" {
        tokio::time::sleep(Duration::from_millis(state.source_delay_ms)).await;
    }
    let value = match path.as_str() {
        "/qs/share/sharepage/token" if state.invalid && input["pwd_id"] != "ownshare" => {
            json!({"code":41008})
        }
        "/qs/share/sharepage/token" if state.source_error && input["pwd_id"] != "ownshare" => {
            json!({"code":50000})
        }
        "/qs/share/sharepage/token" => json!({"code":0,"data":{"stoken":"fixture"}}),
        "/qs/share/sharepage/detail" => {
            let list = if state.empty_source
                && query
                    .get("pwd_id")
                    .is_none_or(|id| id.as_ref() != "ownshare")
            {
                vec![]
            } else {
                vec![qfile("sourcefile", "movie.mp4", 42, false)]
            };
            json!({"code":0,"data":{"list":list,"share":{"title":"fixture"}}})
        }
        "/qp/file/sort" => {
            state.directory_reads += 1;
            let parent = query.get("pdir_fid").map(|s| s.as_ref()).unwrap_or("");
            let mut list = if parent == "project" {
                state.directories.values().cloned().collect::<Vec<_>>()
            } else {
                state.files.get(parent).cloned().unwrap_or_default()
            };
            if state.unknown_file && parent != "project" {
                list.push(qfile("foreign", "foreign.txt", 1, false));
            }
            json!({"code":0,"data":{"list":list}})
        }
        "/qp/file" => {
            if state.directory_delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(state.directory_delay_ms)).await;
            }
            let id = format!("dir{}", state.directories.len() + 1);
            let value = qfile(&id, input["file_name"].as_str().unwrap(), 0, true);
            state.directories.insert(id, value.clone());
            json!({"code":0,"data":value})
        }
        "/qp/share/sharepage/save" => {
            if state.transfer_delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(state.transfer_delay_ms)).await;
            }
            state.transfer_count += 1;
            state.files.insert(
                input["to_pdir_fid"].as_str().unwrap().into(),
                vec![qfile("ownedfile", "movie.mp4", 42, false)],
            );
            json!({"code":0,"data":{"task_resp":{"data":{"status":2,"save_as":{"save_as_top_fids":["ownedfile"]}}}}})
        }
        "/qp/share" => {
            if state.share_delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(state.share_delay_ms)).await;
            }
            state.share_count += 1;
            json!({"code":0,"data":{"share_id":"ownshare"}})
        }
        "/qp/share/password" if state.password_failure => json!({"code":31024}),
        "/qp/share/password" => {
            if state.finish_share_delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(state.finish_share_delay_ms)).await;
            }
            json!({"code":0,"data":{"share_url":"https://pan.quark.cn/s/ownshare","share_pwd":"own1"}})
        }
        "/qp/share/delete" => {
            state.revoked += 1;
            json!({"code":0})
        }
        "/qp/file/delete" => {
            state.deleted += 1;
            for id in input["filelist"].as_array().unwrap() {
                let id = id.as_str().unwrap();
                state.directories.remove(id);
                state.files.remove(id);
            }
            json!({"code":0,"data":{"task_resp":{"data":{"status":2}}}})
        }
        _ => panic!("unexpected mock path {path}"),
    };
    Json(value)
}
async fn call(router: &Router, session: &Session, path: &str, value: Value) -> (StatusCode, Value) {
    let mut out = call_once(router, session, path, value).await;
    let end = tokio::time::Instant::now() + Duration::from_secs(20);
    while out.0 == StatusCode::ACCEPTED && path == "/api/links/resolve" {
        assert!(tokio::time::Instant::now() < end, "operation did not finish: {out:?}");
        let key = out.1["data"]["requestKey"].as_str().unwrap();
        let path = format!("/api/links/resolve-operations/{key}");
        tokio::time::sleep(Duration::from_millis(50)).await;
        out = call_once(router, session, &path, Value::Null).await;
    }
    out
}
async fn call_once(router: &Router, session: &Session, path: &str, value: Value,
) -> (StatusCode, Value) {
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method(if path.starts_with("/api/links/resolve-operations/") || path.starts_with("/api/admin/link-cleanup?") { "GET" } else if path.starts_with("/api/settings/") { "PUT" } else { "POST" },
                )
                .uri(path)
                .header("authorization", format!("Bearer {}", session.token))
                .header("content-type", "application/json")
                .body(Body::from(value.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    if path.starts_with("/api/links/") {
    assert_eq!(
        response
            .headers()
            .get("cache-control")
            .map(|v| v.to_str().unwrap()),
        Some("private, no-store")
    );
    }
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}
async fn wait_for_cloud_writer(pool: &sqlx::PgPool, provider: &str) {
    let end = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let mut tx = pool.begin().await.unwrap();
        let free: bool = sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0))")
            .bind(format!("pansou:cloud-write:{provider}")).fetch_one(&mut *tx).await.unwrap();
        tx.rollback().await.unwrap();
        if free { return; }
        assert!(tokio::time::Instant::now() < end, "writer did not release its lock");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[derive(Default)]
struct ExtendedUpstream {
    dirs: HashMap<String, Value>, files: HashMap<String, Vec<Value>>,
    created: usize, transfers: usize, shares: usize, deleted: usize, revoked: usize,
    directory_lists: usize,
    guangya_auto_fill: Option<bool>,
    guangya_share_type: Option<i64>,
    late: bool, wrong_account: bool, multi_file: bool, login_required:bool,
}
fn extended_file(id: &str, name: &str, directory: bool) -> Value {
    json!({"id":id,"file_id":id,"fileId":id,"name":name,"fileName":name,"size":if directory{0}else{42},"fileSize":if directory{0}else{42},"type":if directory{"folder"}else{"file"},"kind":if directory{"drive#folder"}else{"drive#file"},"resType":if directory{2}else{1}})
}
async fn extended_mock(State(state): State<Arc<Mutex<ExtendedUpstream>>>, request: Request<Body>,
) -> Json<Value> {
    assert_eq!(request.headers().get("authorization").unwrap(), "Bearer fixture-access");
    assert!(request.headers().get("cookie").is_none(), "JSON credentials must never become a Cookie header");
    let path=request.uri().path().to_owned();
    if path.ends_with("/v1/user/me") {
        assert_eq!(request.method(), axum::http::Method::GET, "identity endpoint requires GET; POST returns 501 on Guangya");
    }
    let url=Url::parse(&format!("http://mock{}",request.uri())).unwrap();
    let params:HashMap<_,_>=url.query_pairs().collect();
    let body=to_bytes(request.into_body(),1024*1024).await.unwrap();
    let input:Value=serde_json::from_slice(&body).unwrap_or(Value::Null);
    let mut state=state.lock().await;
    if state.login_required{return Json(json!({"code":"AccessTokenExpired"}));}
    let value=match path.as_str() {
        "/v2/user/get"|"/v1/user/me"|"/api.aliyundrive.com/v2/user/get"|"/xluser-ssl.xunlei.com/v1/user/me"|"/account.guangyapan.com/v1/user/me"=>{
            json!({"user_id":if state.wrong_account{"different-account"}else{"fixture-account"}})}
        "/api.aliyundrive.com/v2/drive/get"=>json!({"owner":"fixture-account"}),
        "/api.aliyundrive.com/users/v1/users/device/create_session"=>json!({"result":true}),
        "/v2/share_link/get_share_token"=>json!({"share_token":"share-fixture"}),
        "/drive/v1/share"=>json!({"code":0,"data":{"pass_code_token":"share-fixture"}}),
        "/nd.bizuserres.s/v1/get_share_access_token"=>{
            json!({"code":0,"data":{"accessToken":"share-fixture"}})}
        "/adrive/v2/file/list_by_share"=>{
            json!({"items":if state.multi_file{vec![extended_file("source","movie.mp4",false),extended_file("source2","extra.mp4",false)]}else{vec![extended_file("source","movie.mp4",false)]},"next_marker":""})}
        "/drive/v1/share/detail"=>{
            json!({"code":0,"data":{"files":[extended_file("source","movie.mp4",false)],"next_page_token":""}})}
        "/nd.bizuserres.s/v1/get_share_page_files_list"=>{
            json!({"code":0,"data":{"list":[extended_file("source","movie.mp4",false)],"total":1}})}
        "/adrive/v3/file/list"|"/drive/v1/files"|"/userres/v1/file/get_file_list" if path!="/drive/v1/files" || input.is_null()=>{
            let parent=input["parent_file_id"].as_str().or(input["parentId"].as_str()).or_else(||params.get("parent_id").map(|s|s.as_ref())).unwrap_or("");
            if parent.starts_with("dir") { state.directory_lists += 1; }
            let files=if matches!(parent,"project"|"0"|""|"root"){state.dirs.values().cloned().collect::<Vec<_>>()}else{state.files.get(parent).cloned().unwrap_or_default()};
            json!({"code":0,"items":files,"files":files,"data":{"list":files,"files":files,"total":files.len()},"next_marker":""})
        }"/v2/file/create"|"/drive/v1/files"|"/nd.bizuserres.s/v1/file/create_dir"=>{
            state.created+=1;let id=format!("dir{}",state.created);let name=input["name"].as_str().or(input["dirName"].as_str()).unwrap();let file=extended_file(&id,name,true);state.dirs.insert(id,file.clone());
            json!({"code":0,"data":file})
        }"/v2/file/copy"|"/drive/v1/share/restore"|"/nd.bizuserres.s/v1/restore_share"=>{
            if state.late{tokio::time::sleep(Duration::from_secs(6)).await;}
            state.transfers+=1;let parent=input["to_parent_file_id"].as_str().or(input["parent_id"].as_str()).or(input["parentId"].as_str()).unwrap();state.files.insert(parent.into(),vec![extended_file("target","movie.mp4",false)],
            );
            if path=="/v2/file/copy"{json!({"file_id":"target"})}else{json!({"code":0,"data":{"task_id":"restore-task","taskId":"restore-task"}})}
        }"/drive/v1/tasks/restore-task"=>json!({"phase":"PHASE_TYPE_COMPLETE"}),
        "/nd.bizuserres.s/v1/get_task_status"=>json!({"code":0,"data":{"status":2}}),
        "/adrive/v2/share_link/create"|"/drive/v1/share/batch"|"/nd.bizuserres.s/v1/share_file"=>{
            state.shares+=1;if path == "/nd.bizuserres.s/v1/share_file" {
                state.guangya_auto_fill = input["autoFillCode"].as_bool();
                state.guangya_share_type = input["shareType"].as_i64();
            }
            let host=if path=="/adrive/v2/share_link/create"{"www.alipan.com"}else if path=="/drive/v1/share/batch"{"pan.xunlei.com"}else{"www.guangyapan.com"};json!({"code":0,"data":{"share_id":"ownshare","shareUrl":format!("https://{host}/s/ownshare"),"share_pwd":if path=="/nd.bizuserres.s/v1/share_file"{""}else{"own1"}}})
        }"/adrive/v2/share_link/cancel"|"/drive/v1/share/batch/delete"|"/nd.bizuserres.s/v1/delete_share"=>{state.revoked+=1;json!({"code":0})}"/v2/recyclebin/trash"|"/drive/v1/files:batchTrash"|"/nd.bizuserres.s/v1/file/delete_file"=>{
            let id=input["file_id"].as_str().or(input["ids"][0].as_str()).or(input["fileIds"][0].as_str()).unwrap();state.dirs.remove(id);state.files.remove(id);state.deleted+=1;json!({"code":0})
        }_=>panic!("unexpected extended provider request {path}"),
    };Json(value)
}

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test and PANSOU_TEST_REDIS_URL"]
async fn extended_providers_transfer_reuse_timeout_cleanup_and_admin_retry() {
    let database=std::env::var("PANSOU_TEST_DATABASE_URL").unwrap();assert!(Url::parse(&database).unwrap().path().ends_with("_test"));
    let redis=std::env::var("PANSOU_TEST_REDIS_URL").unwrap();assert!(Url::parse(&redis).unwrap().path()!="/0");
    let pool=PgPoolOptions::new().max_connections(12).connect(&database).await.unwrap();crate::db::init_db(&pool).await.unwrap();
    let upstream=Arc::new(Mutex::new(ExtendedUpstream::default()));let server=Router::new().fallback(any(extended_mock)).with_state(upstream.clone());let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let origin=Url::parse(&format!("http://{}/",listener.local_addr().unwrap())).unwrap();let task=tokio::spawn(async move{axum::serve(listener,server).await.unwrap()});
    let mut state=AppState::new(pool.clone(),RedisStore::connect(&redis).await.unwrap());state.cloud_auth_test_base=Some(origin.as_str().to_owned());state.cloud_test_bases=Some(TestBases{baidu:origin.clone(),quark_pc:origin.clone(),quark_share:origin,
    });let state=Arc::new(state);let router=crate::app::build_router(state.clone());let anon=state.auth().issue(true).await.unwrap();
    let username=format!("cleanup-{}",Uuid::new_v4());sqlx::query("INSERT INTO users(username,username_normalized,password_hash,role) VALUES($1,$1,$2,'admin')").bind(&username).bind(crate::auth::hash_password("fixture-password").unwrap()).execute(&pool).await.unwrap();let(admin,_)=state.auth().login(&username,"fixture-password").await.unwrap();
    state.resolve_test_timeout_seconds.store(5, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(call(&router,&anon,"/api/admin/link-cleanup?status=all",Value::Null).await.0,StatusCode::FORBIDDEN);
    for provider in ["aliyun","xunlei","guangya"] {
        let credential=json!({"access_token":"fixture-access","user_id":"fixture-account","drive_id":"fixture-drive","x-captcha-token":"fixture-captcha","device_id":"fixture-device"}).to_string();
        sqlx::query("INSERT INTO cloud_account_settings(provider,credential) VALUES($1,$2) ON CONFLICT(provider) DO UPDATE SET credential=excluded.credential").bind(provider).bind(&credential).execute(&pool).await.unwrap();
        assert_eq!(call(&router,&anon,&format!("/api/settings/{provider}"),json!({"credential":credential})).await.0,StatusCode::UNAUTHORIZED);
        assert_eq!(call(&router,&admin,&format!("/api/settings/{provider}"),json!({"credential":credential})).await.0,StatusCode::OK);
        assert_eq!(call(&router,&admin,"/api/admin/cloud-drive/ping",json!({"provider":provider})).await.0,StatusCode::OK);
        sqlx::query("UPDATE cloud_provider_policies SET delivery_enabled=true,target_dir='project',retention_seconds=3600,delivery_min_remaining_seconds=5,platform_share_days=7 WHERE provider=$1").bind(provider).execute(&pool).await.unwrap();
        let host=match provider{"aliyun"=>"www.alipan.com","xunlei"=>"pan.xunlei.com",_=>"www.guangyapan.com",
        };let link=Link{r#type:provider.into(),url:format!("https://{host}/s/source{}",Uuid::new_v4().simple()),password:Some("secr".into()),
        };let(out,id)=seed(&state,&anon,link.clone()).await;
        let lists_before=upstream.lock().await.directory_lists;
        let first=call(&router,&anon,"/api/links/resolve",request(&out,Uuid::new_v4()),
        ).await;assert_eq!(first.0,StatusCode::OK);assert_eq!(first.1["data"]["delivery"],"reshared","{provider}: {first:?}");
        if provider == "guangya" {
            let recorded = upstream.lock().await;
            assert_eq!(recorded.guangya_auto_fill, Some(false));
            assert_eq!(
                recorded.guangya_share_type,
                Some(0),
                "shareType controls extraction-code generation"
            );
            assert_eq!(first.1["data"]["password"], "");
            assert_eq!(
                first.1["data"]["url"],
                "https://www.guangyapan.com/s/ownshare#/share"
            );
        }
        assert_eq!(upstream.lock().await.directory_lists-lists_before,2,"{provider}: only the empty-directory and confirmed-transfer lists are needed");
        let transferred=upstream.lock().await.transfers;let reused=call(&router,&anon,"/api/links/resolve",request(&out,Uuid::new_v4()),
        ).await;assert_eq!(reused.1["data"]["cacheHit"],true,"{reused:?}");assert_eq!(upstream.lock().await.transfers,transferred);
        let scheduled=call(&router,&admin,&format!("/api/admin/link-cleanup?status=all&provider={provider}"),Value::Null,
        ).await;
        let not_due=scheduled.1["data"]["items"][0]["id"].as_i64().unwrap();assert_eq!(scheduled.1["data"]["items"][0]["canRetry"],false);assert_eq!(scheduled.1["data"]["items"][0]["retryUnavailableReason"],"not_due");assert!(!scheduled.1.to_string().contains("\"token\""));assert_eq!(call(&router,&admin,&format!("/api/admin/link-cleanup/{not_due}/retry"),json!({})).await.0,StatusCode::CONFLICT);
        // A stale queue timestamp cannot erase an unexpired delivery.
        sqlx::query("UPDATE link_cleanup_jobs SET run_after=now() WHERE id=$1").bind(not_due).execute(&pool).await.unwrap();let before_due=upstream.lock().await.deleted;delivery::cleanup_tick(&state).await.unwrap();assert_eq!(upstream.lock().await.deleted,before_due);
        // Same-account credential rotation preserves ownership; another actual account is refused.
        let rotation=credential.replace("fixture-captcha","updated-captcha");let p=crate::cloud_drive::Provider::from_name(provider).unwrap();let epoch=crate::cloud_auth::stored(&state,p).await.unwrap().unwrap().binding_epoch;crate::cloud_auth::import(&state,p,&rotation,"reauthorize",epoch).await.unwrap();
        sqlx::query("UPDATE link_share_cache SET cleanup_after=now() WHERE link_id=$1").bind(id).execute(&pool).await.unwrap();sqlx::query("UPDATE link_cleanup_jobs SET run_after=now() WHERE share_cache_id IN(SELECT id FROM link_share_cache WHERE link_id=$1)").bind(id).execute(&pool).await.unwrap();
        // Authentication failures pause cleanup without consuming attempts.
        let attempts:i32=sqlx::query_scalar("SELECT attempts FROM link_cleanup_jobs WHERE id=$1").bind(not_due).fetch_one(&pool).await.unwrap();
        upstream.lock().await.login_required=true;let before_auth=upstream.lock().await.deleted;delivery::cleanup_tick(&state).await.unwrap();
        let paused=sqlx::query("SELECT status,last_error_code,attempts FROM link_cleanup_jobs WHERE id=$1",
        ).bind(not_due).fetch_one(&pool).await.unwrap();assert_eq!(paused.get::<String,_>("status"),"blocked");assert_eq!(paused.get::<String,_>("last_error_code"),"waiting_auth");assert_eq!(paused.get::<i32,_>("attempts"),attempts);assert_eq!(upstream.lock().await.deleted,before_auth);
        assert_eq!(call(&router,&admin,&format!("/api/admin/link-cleanup/{not_due}/retry"),json!({})).await.0,StatusCode::CONFLICT);
        upstream.lock().await.login_required=false;crate::cloud_auth::import(&state,p,&rotation,"reauthorize",epoch).await.unwrap();
        assert_eq!(sqlx::query_scalar::<_,String>("SELECT status FROM link_cleanup_jobs WHERE id=$1").bind(not_due).fetch_one(&pool).await.unwrap(),"queued");
        upstream.lock().await.wrong_account=true;assert_eq!(call(&router,&admin,"/api/admin/cloud-drive/ping",json!({"provider":provider})).await.0,StatusCode::CONFLICT);let before=upstream.lock().await.deleted;delivery::cleanup_tick(&state).await.unwrap();assert_eq!(upstream.lock().await.deleted,before);
        let attention=call(&router,&admin,&format!("/api/admin/link-cleanup?status=attention&provider={provider}"),Value::Null,
        ).await;assert_eq!(attention.0,StatusCode::OK);assert!(!attention.1.to_string().contains("fixture-access"));let job=attention.1["data"]["items"][0]["id"].as_i64().unwrap();assert_eq!(attention.1["data"]["items"][0]["status"],"blocked");
        assert_eq!(call(&router,&anon,&format!("/api/admin/link-cleanup/{job}/retry"),json!({})).await.0,StatusCode::FORBIDDEN);
        upstream.lock().await.wrong_account=false;assert_eq!(call(&router,&admin,&format!("/api/admin/link-cleanup/{job}/retry"),json!({})).await.0,StatusCode::OK);delivery::cleanup_tick(&state).await.unwrap();assert_eq!(upstream.lock().await.deleted,before+1);assert_eq!(call(&router,&admin,&format!("/api/admin/link-cleanup/{job}/retry"),json!({})).await.0,StatusCode::CONFLICT);
        upstream.lock().await.late=true;upstream.lock().await.multi_file=provider=="aliyun";let key=Uuid::new_v4();let start=tokio::time::Instant::now();let pending=call_once(&router,&anon,"/api/links/resolve",request(&out,key)).await;assert_eq!(pending.0,StatusCode::ACCEPTED);assert!(start.elapsed()<Duration::from_secs(2));
        tokio::time::sleep_until(start+Duration::from_millis(5100)).await;
        let fallback=call_once(&router,&anon,&format!("/api/links/resolve-operations/{key}"),Value::Null,
        ).await;assert_eq!(fallback.1["data"]["url"],link.url,"{provider}: {fallback:?}");assert_eq!(fallback.1["data"]["delivery"],"original");
        let end=tokio::time::Instant::now()+Duration::from_secs(6);loop{let retired:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM link_share_cache s JOIN link_resolve_requests r ON r.share_cache_id=s.id WHERE r.request_key=$1 AND s.state='expiring')").bind(key).fetch_one(&pool).await.unwrap();if retired{break;}assert!(tokio::time::Instant::now()<end,"{provider}: late write was not retired");tokio::time::sleep(Duration::from_millis(20)).await;}
        wait_for_cloud_writer(&pool,provider).await;
        let cleanup_end=tokio::time::Instant::now()+Duration::from_secs(12);
        loop {
            delivery::cleanup_tick(&state).await.unwrap();
            let status:(String,Option<String>)=sqlx::query_as("SELECT j.status,j.last_error_code FROM link_cleanup_jobs j JOIN link_resolve_requests r ON r.share_cache_id=j.share_cache_id WHERE r.request_key=$1").bind(key).fetch_one(&pool).await.unwrap();
            if status.0=="completed" {break;}
            assert_eq!(status.0,"queued","{provider}: {status:?}");
            assert!(status.1.is_none() || status.1.as_deref()==Some("cleanup_busy"),"{provider}: {status:?}");
            assert!(tokio::time::Instant::now()<cleanup_end,"{provider}: cleanup writer stayed busy");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(upstream.lock().await.dirs.is_empty(),"{provider}: late artifact remained");upstream.lock().await.late=false;
        // Live leases cannot be reset by the admin retry endpoint.
        let lease_token=Uuid::new_v4();sqlx::query("UPDATE link_cleanup_jobs SET status='running',lease_token=$2,lease_until=now()+interval '3 minutes' WHERE id=$1").bind(job).bind(lease_token).execute(&pool).await.unwrap();assert_eq!(call(&router,&admin,&format!("/api/admin/link-cleanup/{job}/retry"),json!({})).await.0,StatusCode::CONFLICT);
        assert!(delivery::cleanup_checkpoint(&state,job,lease_token,"verify").await.is_ok());assert!(delivery::cleanup_checkpoint(&state,job,Uuid::new_v4(),"delete_files").await.is_err());
        sqlx::query("UPDATE link_cleanup_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
        ).bind(job).execute(&pool).await.unwrap();assert!(delivery::cleanup_checkpoint(&state,job,lease_token,"delete_files").await.is_err());
        assert_eq!(call(&router,&admin,&format!("/api/admin/link-cleanup/{job}/retry"),json!({})).await.0,StatusCode::OK);assert!(delivery::cleanup_checkpoint(&state,job,lease_token,"delete_files").await.is_err());
        sqlx::query("UPDATE link_cleanup_jobs SET status='completed',lease_until=NULL WHERE id=$1").bind(job).execute(&pool).await.unwrap();
        println!("{provider}: transfer/reuse, account-safe admin retry and late cleanup passed");
    }task.abort();
}
async fn seed(state: &AppState, session: &Session, link: Link) -> (Value, Uuid) {
    let id = format!("links-test-{}", Uuid::new_v4());
    let result = SearchResult {
        id: id.clone(),
        name: format!("Test {} 密码：secr", link.url),
        description: Some(format!("{} 提取码：secr", link.url)),
        datetime: None,
        cloud_types: vec![link.r#type.clone()],
        links: vec![link.clone()],
        tags: Some(vec![link.url.clone()]),
        images: Some(vec![link.url.clone()]),
    };
    sqlx::query("INSERT INTO managed_resources(id,name,links_json) VALUES($1,$2,$3)")
        .bind(&id)
        .bind(&result.name)
        .bind(json!([link]))
        .execute(&state.pool)
        .await
        .unwrap();
    let req = SearchRequest {
        kw: "Test".into(),
        channels: None,
        source_ids: None,
        conc: None,
    };
    let out = project(state, session, &req, None, &[result])
        .await
        .unwrap()
        .remove(0);
    assert!(!out.to_string().contains("pan.quark.cn"));
    assert!(!out.to_string().contains("secr"));
    assert!(out.get("tags").is_none());
    (out, register(state, &link).await.unwrap())
}
fn request(out: &Value, key: Uuid) -> Value {
    json!({"resultRef":out["resultRef"],"linkRef":out["links"][0]["linkRef"],"requestKey":key})
}
#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test and PANSOU_TEST_REDIS_URL"]
async fn resolution_waits_beyond_http_budget_and_fences_expired_results() {
    let database = std::env::var("PANSOU_TEST_DATABASE_URL").unwrap();
    assert!(Url::parse(&database).unwrap().path().ends_with("_test"));
    let redis_url = std::env::var("PANSOU_TEST_REDIS_URL").unwrap();
    assert!(Url::parse(&redis_url).unwrap().path() != "/0");
    let pool = PgPoolOptions::new().max_connections(12).connect(&database).await.unwrap();
    crate::db::init_db(&pool).await.unwrap();
    let upstream = Arc::new(Mutex::new(Upstream::default()));
    let server = Router::new().fallback(any(mock)).with_state(upstream.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}/", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, server).await.unwrap() });
    let mut state = AppState::new(pool.clone(), RedisStore::connect(&redis_url).await.unwrap());
    state.cloud_test_bases = Some(TestBases {
        baidu: Url::parse(&origin).unwrap(),
        quark_pc: Url::parse(&(origin.clone() + "qp/")).unwrap(),
        quark_share: Url::parse(&(origin + "qs/")).unwrap(),
    });
    let state = Arc::new(state);
    let router = crate::app::build_router(state.clone());
    let session = state.auth().issue(true).await.unwrap();
    state.resolve_test_timeout_seconds.store(5, std::sync::atomic::Ordering::SeqCst);
    sqlx::query("INSERT INTO cloud_account_settings(provider,credential) VALUES('quark','timeout-fixture=1') ON CONFLICT(provider) DO UPDATE SET credential=excluded.credential")
        .execute(&pool).await.unwrap();
    sqlx::query("UPDATE cloud_provider_policies SET delivery_enabled=true,target_dir='project',retention_seconds=3600,delivery_min_remaining_seconds=5,platform_share_days=7 WHERE provider='quark'")
        .execute(&pool).await.unwrap();

    for scenario in ["source", "directory", "transfer", "share", "finish_share", "account_lock",
    ] {
        let (transfers_before, shares_before, revoked_before, deleted_before) = {
            let mut mock = upstream.lock().await;
            mock.source_delay_ms = if scenario == "source" { 6000 } else { 0 };
            mock.directory_delay_ms = if scenario == "directory" { 6000 } else { 0 };
            mock.transfer_delay_ms = if scenario == "transfer" { 6000 } else { 0 };
            mock.share_delay_ms = if scenario == "share" { 6000 } else { 0 };
            mock.finish_share_delay_ms = if scenario == "finish_share" { 6000 } else { 0 };
            (mock.transfer_count, mock.share_count, mock.revoked, mock.deleted,
            )
        };
        let mut account_lock = pool.begin().await.unwrap();
        if scenario == "account_lock" {
            sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('pansou:cloud-write:quark',0))",
            )
                .execute(&mut *account_lock).await.unwrap();
        }
        let link = Link { r#type: "quark".into(), url: format!("https://pan.quark.cn/s/timeout{}", Uuid::new_v4().simple()), password: Some("secr".into()) ,
        };
        let (out, _) = seed(&state, &session, link.clone()).await;
        let key = Uuid::new_v4();
        let started = tokio::time::Instant::now();
        let pending = call_once(&router, &session, "/api/links/resolve", request(&out, key)).await;
        assert_eq!(pending.0, StatusCode::ACCEPTED, "{scenario}: {pending:?}");
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(pending.1["data"]["status"], "processing");
        assert!(pending.1["data"]["stage"].is_string());
        // A test-only shorter work budget exercises deadline fencing without waiting two minutes.
        tokio::time::sleep_until(started + Duration::from_millis(5100)).await;
        let (status, result) = call_once(&router, &session, &format!("/api/links/resolve-operations/{key}"), Value::Null,
        ).await;
        let elapsed = started.elapsed();
        println!("{scenario}: returned original in {elapsed:?}");
        assert_eq!(status, StatusCode::OK, "{scenario}: {result}");
        assert!(elapsed >= Duration::from_millis(4800) && elapsed < Duration::from_millis(5800), "{scenario}: {elapsed:?}");
        assert_eq!(result["data"]["delivery"], "original", "{scenario}: {result}");
        assert_eq!(result["data"]["url"], link.url);
        assert_eq!(result["data"]["password"], "secr");
        account_lock.rollback().await.unwrap();

        let metadata: (String, String, String) = sqlx::query_as("SELECT status,delivery,result_kind FROM link_resolve_requests WHERE request_key=$1",
        )
            .bind(key).fetch_one(&pool).await.unwrap();
        assert_eq!(metadata, ("completed".into(), "original".into(), "available".into()));
        let late = json!({"status":"completed","delivery":"reshared","url":"https://pan.quark.cn/s/late"});
        assert!(complete_resolution(&state, &subject(&session), key, &late, true).await.unwrap().is_none());
        let replay = call(&router, &session, &format!("/api/links/resolve-operations/{key}"), Value::Null,
        ).await;
        assert_eq!(replay.0, StatusCode::OK);
        assert_eq!(replay.1, result, "timeout result must remain stable on polling");
        // Wait for the mock's already-sent request to finish; no new share may follow it.
        let mock = upstream.lock().await;
        assert_eq!(mock.share_count - shares_before, usize::from(matches!(scenario, "share" | "finish_share")));
        assert_eq!(mock.transfer_count - transfers_before, usize::from(matches!(scenario, "transfer" | "share" | "finish_share")));
        drop(mock);
        if matches!(scenario, "directory" | "transfer" | "share" | "finish_share") {
            // The late acknowledgement must persist ownership and schedule cleanup now,
            // rather than leaving artifacts until the one-hour retention expires.
            let end = tokio::time::Instant::now() + Duration::from_secs(5);
            loop {
                let retired: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM link_share_cache s JOIN link_resolve_requests r ON r.share_cache_id=s.id JOIN link_cleanup_jobs j ON j.share_cache_id=s.id WHERE r.request_key=$1 AND s.state='expiring' AND j.status='queued' AND j.run_after<=now())")
                    .bind(key).fetch_one(&pool).await.unwrap();
                if retired { break; }
                assert!(tokio::time::Instant::now() < end, "{scenario}: late artifact was not retired");
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            // An unrelated file at the project root must survive cleanup.
            wait_for_cloud_writer(&pool, "quark").await;
            upstream.lock().await.directories.insert("foreign-root".into(), qfile("foreign-root", "personal", 0, true),
            );
            if scenario == "directory" {
                let mut busy = pool.begin().await.unwrap();
                sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('pansou:cloud-write:quark',0))",
                )
                    .execute(&mut *busy).await.unwrap();
                delivery::cleanup_tick(&state).await.unwrap();
                let retrying: bool = sqlx::query_scalar("SELECT j.status='queued' AND j.run_after<=now()+interval '11 seconds' FROM link_cleanup_jobs j JOIN link_resolve_requests r ON r.share_cache_id=j.share_cache_id WHERE r.request_key=$1")
                    .bind(key).fetch_one(&pool).await.unwrap();
                assert!(retrying, "a busy account must retry cleanup, not block it");
                assert_eq!(upstream.lock().await.deleted, deleted_before);
                busy.rollback().await.unwrap();
                sqlx::query("UPDATE link_cleanup_jobs SET run_after=now() WHERE share_cache_id IN(SELECT share_cache_id FROM link_resolve_requests WHERE request_key=$1)")
                    .bind(key).execute(&pool).await.unwrap();
            }
            if scenario == "transfer" {
                // Deterministically exercise a finalizer holding the queue row.
                let mut finalizer = pool.begin().await.unwrap();
                sqlx::query("SELECT j.id FROM link_cleanup_jobs j JOIN link_resolve_requests r ON r.share_cache_id=j.share_cache_id WHERE r.request_key=$1 FOR UPDATE OF j")
                    .bind(key).fetch_one(&mut *finalizer).await.unwrap();
                delivery::cleanup_tick(&state).await.unwrap();
                assert_eq!(upstream.lock().await.deleted, deleted_before);
                finalizer.rollback().await.unwrap();
            }
            // Late finalization may still lock the queue row after releasing
            // the account lock. SKIP LOCKED can return no job; account busy can
            // defer it. Follow both outcomes, never ownership/auth errors.
            let cleanup_end = tokio::time::Instant::now() + Duration::from_secs(12);
            let cleanup_state = loop {
                delivery::cleanup_tick(&state).await.unwrap();
                let status: (String, Option<String>, String, String) = sqlx::query_as("SELECT j.status,j.last_error_code,j.stage,s.state FROM link_cleanup_jobs j JOIN link_share_cache s ON s.id=j.share_cache_id JOIN link_resolve_requests r ON r.share_cache_id=s.id WHERE r.request_key=$1")
                    .bind(key).fetch_one(&pool).await.unwrap();
                if status.0 == "completed" { break status; }
                assert_eq!(status.0, "queued", "{scenario}: {status:?}");
                assert!(status.1.is_none() || status.1.as_deref()==Some("cleanup_busy"), "{scenario}: {status:?}");
                assert!(tokio::time::Instant::now() < cleanup_end, "{scenario}: writer did not release for cleanup");
                tokio::time::sleep(Duration::from_millis(100)).await;
            };
            let mock = upstream.lock().await;
            assert_eq!(mock.deleted - deleted_before, 1, "{scenario}: {cleanup_state:?}");
            assert_eq!(mock.revoked - revoked_before, usize::from(matches!(scenario, "share" | "finish_share")), "{scenario}");
            assert!(mock.directories.contains_key("foreign-root"));
            assert_eq!(mock.directories.len(), 1, "{scenario}: late directory remains");
            drop(mock);
            let cleaned: bool = sqlx::query_scalar("SELECT s.state='deleted' AND j.status='completed' FROM link_resolve_requests r JOIN link_share_cache s ON s.id=r.share_cache_id JOIN link_cleanup_jobs j ON j.share_cache_id=s.id WHERE r.request_key=$1")
                .bind(key).fetch_one(&pool).await.unwrap();
            assert!(cleaned, "{scenario}: cleanup was not verified");
            println!("{scenario}: late artifact cleaned; unrelated directory preserved");
        }
    }
    // Expired requests are fenced even before timeout recovery publishes its result.
    let expired_key = Uuid::new_v4();
    sqlx::query("INSERT INTO link_resolve_requests(id,request_key,subject_key,request_fingerprint,link_id,authorization_json,status,deadline_at) SELECT $1,$2,subject_key,request_fingerprint,link_id,authorization_json,'running',now()-interval '1 second' FROM link_resolve_requests WHERE subject_key=$3 ORDER BY created_at DESC LIMIT 1")
        .bind(Uuid::new_v4()).bind(expired_key).bind(subject(&session)).execute(&pool).await.unwrap();
    let late = json!({"status":"completed","delivery":"reshared","url":"https://pan.quark.cn/s/late"});
    assert!(complete_resolution(&state, &subject(&session), expired_key, &late, true).await.unwrap().is_none());
    let unfinished: bool = sqlx::query_scalar("SELECT response_json IS NULL AND status='running' FROM link_resolve_requests WHERE request_key=$1")
        .bind(expired_key).fetch_one(&pool).await.unwrap();
    assert!(unfinished);
    let unsafe_cache: i64 = sqlx::query_scalar("SELECT count(*) FROM link_share_cache WHERE state='ready'")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(unsafe_cache, 0, "an interrupted transfer must not become a ready share");
    // A source taking longer than the old five-second limit must still complete.
    state.resolve_test_timeout_seconds.store(120, std::sync::atomic::Ordering::SeqCst);
    {
        let mut mock = upstream.lock().await;
        mock.source_delay_ms = 6000;
        mock.directory_delay_ms = 0;
        mock.transfer_delay_ms = 0;
        mock.share_delay_ms = 0;
        mock.finish_share_delay_ms = 0;
    }
    let link = Link { r#type: "quark".into(), url: format!("https://pan.quark.cn/s/slow{}", Uuid::new_v4().simple()), password: None ,
    };
    let (out, _) = seed(&state, &session, link).await;
    let key = Uuid::new_v4();
    let transfers = upstream.lock().await.transfer_count;
    let pending = call_once(&router, &session, "/api/links/resolve", request(&out, key)).await;
    assert_eq!(pending.0, StatusCode::ACCEPTED);
    tokio::time::sleep(Duration::from_secs(5)).await;
    let still_pending = call_once(&router, &session, &format!("/api/links/resolve-operations/{key}"), Value::Null,
    ).await;
    assert_eq!(still_pending.0, StatusCode::ACCEPTED, "{still_pending:?}");
    let finished = call(&router, &session, "/api/links/resolve", request(&out, key)).await;
    assert_eq!(finished.1["data"]["delivery"], "reshared", "{finished:?}");
    assert_eq!(upstream.lock().await.transfer_count, transfers + 1, "retrying the same key cannot repeat the transfer");
    task.abort();
}

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test and PANSOU_TEST_REDIS_URL"]
async fn public_link_contracts_and_owned_cleanup() {
    let database = std::env::var("PANSOU_TEST_DATABASE_URL").unwrap();
    assert!(Url::parse(&database).unwrap().path().ends_with("_test"));
    let pool = PgPoolOptions::new()
        .max_connections(12)
        .connect(&database)
        .await
        .unwrap();
    crate::db::init_db(&pool).await.unwrap();
    let redis_url = std::env::var("PANSOU_TEST_REDIS_URL").unwrap();
    assert!(Url::parse(&redis_url).unwrap().path() != "/0");
    let upstream = Arc::new(Mutex::new(Upstream::default()));
    let server = Router::new()
        .fallback(any(mock))
        .with_state(upstream.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}/", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, server).await.unwrap() });
    let mut state = AppState::new(pool.clone(), RedisStore::connect(&redis_url).await.unwrap());
    state.cloud_test_bases = Some(TestBases {
        baidu: Url::parse(&origin).unwrap(),
        quark_pc: Url::parse(&(origin.clone() + "qp/")).unwrap(),
        quark_share: Url::parse(&(origin + "qs/")).unwrap(),
    });
    let state = Arc::new(state);
    let router = crate::app::build_router(state.clone());
    let session = state.auth().issue(true).await.unwrap();
    let other = state.auth().issue(true).await.unwrap();
    sqlx::query("INSERT INTO cloud_account_settings(provider,credential) VALUES('quark','fixture=1') ON CONFLICT(provider) DO UPDATE SET credential=excluded.credential").execute(&pool).await.unwrap();
    let link = Link {
        r#type: "quark".into(),
        url: format!("https://pan.quark.cn/s/original{}", Uuid::new_v4().simple()),
        password: Some("secr".into()),
    };
    let (out, id) = seed(&state, &session, link.clone()).await;
    let key = Uuid::new_v4();
    assert_eq!(
        call(&router, &other, "/api/links/resolve", request(&out, key))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    sqlx::query("UPDATE link_catalog SET validity=0,checked_at=now(),valid_until=now()+interval '1 day' WHERE id=$1").bind(id).execute(&pool).await.unwrap();
    // Detection exceptions replace even a previously definitive result with unknown.
    for previous in [0i16, 1] {
        sqlx::query(
            "UPDATE link_catalog SET validity=$2,valid_until=now()+interval '1 day' WHERE id=$1",
        )
        .bind(id)
        .bind(previous)
        .execute(&pool)
        .await
        .unwrap();
        worker::record(
            &state,
            id,
            &json!({"status":"unknown","errorKind":"network"}),
            &ProviderPolicy::default(),
        )
        .await
        .unwrap();
        let recorded = fact(&state, id).await.unwrap();
        assert_eq!(recorded.validity, -1);
        assert_eq!(recorded.current(), -1);
        assert!(recorded.valid_until.is_none());
    }
    upstream.lock().await.invalid = true;
    upstream.lock().await.invalid = true;
    let (status, invalid) = call(&router, &session, "/api/links/resolve", request(&out, key)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(invalid["data"]["status"], "unavailable");
    assert!(invalid["data"].get("url").is_none());
    assert_eq!(upstream.lock().await.transfer_count, 0);
    upstream.lock().await.invalid = false;
    assert_eq!(
        call(&router, &session, "/api/links/resolve", request(&out, key))
            .await
            .1,
        invalid
    );
    let (unsupported, _) = seed(
        &state,
        &session,
        Link {
            r#type: "uc".into(),
            url: "https://drive.uc.cn/s/abc".into(),
            password: Some("secr".into()),
        },
    )
    .await;
    let original = call(
        &router,
        &session,
        "/api/links/resolve",
        request(&unsupported, Uuid::new_v4()),
    )
    .await
    .1;
    assert_eq!(original["data"]["url"], "https://drive.uc.cn/s/abc");
    assert_eq!(original["data"]["reasonCode"], "unsupported_provider");
    upstream.lock().await.invalid = false;
    // Activate an isolated mock-only delivery policy.
    sqlx::query("UPDATE link_catalog SET validity=1,checked_at=now(),valid_until=now()+interval '1 day' WHERE id=$1").bind(id).execute(&pool).await.unwrap();
    sqlx::query("UPDATE cloud_provider_policies SET delivery_enabled=true,target_dir='project',retention_seconds=3600,delivery_min_remaining_seconds=5,platform_share_days=7 WHERE provider='quark'").execute(&pool).await.unwrap();
    upstream.lock().await.password_failure = true;
    let first = call(
        &router,
        &session,
        "/api/links/resolve",
        request(&out, Uuid::new_v4()),
    )
    .await
    .1;
    assert_eq!(first["data"]["delivery"], "original");
    assert_eq!(upstream.lock().await.transfer_count, 1);
    upstream.lock().await.password_failure = false;
    let key = Uuid::new_v4();
    let second = call(&router, &session, "/api/links/resolve", request(&out, key))
        .await
        .1;
    assert_eq!(second["data"]["delivery"], "reshared", "{second}");
    // A published cache must never be retired by a later timed-out caller.
    let ever_delivered: bool = sqlx::query_scalar("SELECT ownership_manifest_json->>'everDelivered'='true' FROM link_share_cache WHERE link_id=$1 AND state='ready'")
        .bind(id).fetch_one(&pool).await.unwrap();
    assert!(ever_delivered);
    let timeout_key = Uuid::new_v4();
    sqlx::query("INSERT INTO link_resolve_requests(id,request_key,subject_key,request_fingerprint,link_id,share_cache_id,authorization_json,status,deadline_at) SELECT $1,$2,subject_key,request_fingerprint,link_id,share_cache_id,authorization_json,'running',now()-interval '1 second' FROM link_resolve_requests WHERE request_key=$3")
        .bind(Uuid::new_v4()).bind(timeout_key).bind(key).execute(&pool).await.unwrap();
    sqlx::query("UPDATE link_share_cache SET ownership_manifest_json=ownership_manifest_json || $2 WHERE link_id=$1 AND state='ready'")
        .bind(id).bind(json!({"writerRequestKey":timeout_key})).execute(&pool).await.unwrap();
    delivery::retire_timed_out_artifacts(&state, &session, timeout_key).await.unwrap();
    let still_ready: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM link_share_cache WHERE link_id=$1 AND state='ready' AND cleanup_after>now()+interval '30 minutes')")
        .bind(id).fetch_one(&pool).await.unwrap();
    assert!(still_ready, "timeout must not delete a share already delivered to another caller");
    assert_eq!(second["data"]["password"], "own1");
    assert!(second["data"]["shareExpiresAt"].as_str().is_some());
    assert_eq!(upstream.lock().await.transfer_count, 1);
    assert_eq!(upstream.lock().await.share_count, 1);
    // Replay and other callers reuse within TTL without extending cleanup_after.
    let deadline:DateTime<Utc>=sqlx::query_scalar("SELECT cleanup_after FROM link_share_cache WHERE link_id=$1 ORDER BY created_at DESC LIMIT 1").bind(id).fetch_one(&pool).await.unwrap();
    assert_eq!(
        call(&router, &session, "/api/links/resolve", request(&out, key))
            .await
            .1,
        second
    );
    let reused = call(
        &router,
        &session,
        "/api/links/resolve",
        request(&out, Uuid::new_v4()),
    )
    .await
    .1;
    assert_eq!(reused["data"]["cacheHit"], true);
    let after:DateTime<Utc>=sqlx::query_scalar("SELECT cleanup_after FROM link_share_cache WHERE link_id=$1 ORDER BY created_at DESC LIMIT 1").bind(id).fetch_one(&pool).await.unwrap();
    assert_eq!(deadline, after);
    // A source invalidation never overrides our still-valid owned mapping, including polls.
    upstream.lock().await.invalid = true;
    worker::record(&state, id, &json!({"status":"invalid"}), &ProviderPolicy::default(),
    )
        .await
        .unwrap();
    let owned = call(
        &router,
        &session,
        "/api/links/resolve",
        request(&out, Uuid::new_v4()),
    )
    .await
    .1;
    assert_eq!(owned["data"]["delivery"], "reshared", "{owned}");
    assert_eq!(owned["data"]["originalValidity"], 0);
    assert_eq!(owned["data"]["cacheHit"], true);
    assert_eq!(
        call(&router, &session, "/api/links/resolve", request(&out, key))
            .await
            .1["data"]["delivery"],
        "reshared"
    );
    assert_eq!(upstream.lock().await.transfer_count, 1);
    // Editing settings does not orphan a reusable mapping or reset its retention.
    sqlx::query("UPDATE cloud_provider_policies SET revision=2 WHERE provider='quark'").execute(&pool).await.unwrap();
    assert_eq!(
        call(
            &router,
            &session,
            "/api/links/resolve",
            request(&out, Uuid::new_v4())
        )
        .await
        .1["data"]["cacheHit"],
        true
    );
    sqlx::query("UPDATE cloud_provider_policies SET delivery_enabled=false WHERE provider='quark'").execute(&pool).await.unwrap();
    assert_eq!(
        call(
            &router,
            &session,
            "/api/links/resolve",
            request(&out, Uuid::new_v4())
        )
        .await
        .1["data"]["delivery"],
        "reshared",
        "disabling new transfers must not discard a usable owned share"
    );
    sqlx::query("UPDATE cloud_provider_policies SET delivery_enabled=true WHERE provider='quark'").execute(&pool).await.unwrap();
    upstream.lock().await.invalid = false;
    worker::record(&state, id, &json!({"status":"valid"}), &ProviderPolicy::default(),
    )
        .await
        .unwrap();
    // Status is read-only; no extra transfer/share calls.
    let statuses = call(
        &router,
        &session,
        "/api/links/status",
        json!({"items":[{"resultRef":out["resultRef"],"linkRef":out["links"][0]["linkRef"]}]}),
    )
    .await
    .1;
    assert_eq!(statuses["data"]["items"][0]["validity"], 1);
    assert!(!statuses.to_string().contains("pan.quark.cn"));
    sqlx::query(
        "UPDATE link_share_cache SET cleanup_after=now()-interval '1 minute' WHERE link_id=$1",
    )
    .bind(id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE link_cleanup_jobs SET run_after=now()-interval '1 minute' WHERE share_cache_id IN(SELECT id FROM link_share_cache WHERE link_id=$1)").bind(id).execute(&pool).await.unwrap();
    delivery::cleanup_tick(&state).await.unwrap();
    assert_eq!(upstream.lock().await.revoked, 1);
    assert_eq!(upstream.lock().await.deleted, 1);
    let replay = call(&router, &session, "/api/links/resolve", request(&out, key))
        .await
        .1;
    assert_eq!(replay["data"]["delivery"], "original");
    // Upstream exceptions fall back to the original, never become invalid and never write.
    upstream.lock().await.source_error = true;
    let failed = call(
        &router,
        &session,
        "/api/links/resolve",
        request(&out, Uuid::new_v4()),
    )
    .await
    .1;
    assert_eq!(failed["data"]["delivery"], "original", "{failed}");
    assert_eq!(failed["data"]["validity"], -1);
    assert_eq!(failed["data"]["url"], link.url);
    assert_eq!(upstream.lock().await.transfer_count, 1);
    upstream.lock().await.source_error = false;
    upstream.lock().await.empty_source = true;
    let missing = call(
        &router,
        &session,
        "/api/links/resolve",
        request(&out, Uuid::new_v4()),
    )
    .await
    .1;
    assert_eq!(missing["data"]["status"], "unavailable", "{missing}");
    assert_eq!(missing["data"]["reasonCode"], "resource_missing");
    assert_eq!(upstream.lock().await.transfer_count, 1);
    upstream.lock().await.empty_source = false;
    // Two independent callers racing on a new generation must share one transfer.
    let left_key = Uuid::new_v4();
    let right_key = Uuid::new_v4();
    let (left, right) = tokio::join!(
        call(
            &router,
            &session,
            "/api/links/resolve",
            request(&out, left_key)
        ),
        call(
            &router,
            &session,
            "/api/links/resolve",
            request(&out, right_key)
        ),
    );
    let third = left.1;
    assert_eq!(third["data"]["delivery"], "reshared");
    assert_eq!(right.1["data"]["delivery"], "reshared");
    assert_eq!(upstream.lock().await.transfer_count, 2);
    assert_eq!(upstream.lock().await.share_count, 2);
    // Human-added files prevent recursive deletion and retain a durable blocked job.
    upstream.lock().await.unknown_file = true;
    sqlx::query("UPDATE link_share_cache SET cleanup_after=now()-interval '1 minute' WHERE link_id=$1 AND state='ready'").bind(id).execute(&pool).await.unwrap();
    sqlx::query(
        "UPDATE link_cleanup_jobs SET run_after=now()-interval '1 minute' WHERE status='queued'",
    )
    .execute(&pool)
    .await
    .unwrap();
    delivery::cleanup_tick(&state).await.unwrap();
    assert_eq!(upstream.lock().await.deleted, 1);
    assert!(
        sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM link_cleanup_jobs WHERE status='blocked')"
        )
        .fetch_one(&pool)
        .await
        .unwrap()
    );
    // Changed inputs cannot use an old search capability.
    let snap = snapshot(&state, &session, out["resultRef"].as_str().unwrap())
        .await
        .unwrap();
    sqlx::query("UPDATE managed_resources SET links_json='[]' WHERE id=$1")
        .bind(&snap.resource_id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        call(
            &router,
            &session,
            "/api/links/resolve",
            request(&out, Uuid::new_v4())
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    // A short remaining workflow deadline must still persist the timed-out read as unknown.
    worker::record(&state, id, &json!({"status":"invalid"}), &ProviderPolicy::default(),
    )
        .await
        .unwrap();
    let mut timeout_conn = state.redis.connection().unwrap();
    let _: i64 = timeout_conn
        .del("pansou:link-check:gate:quark")
        .await
        .unwrap();
    upstream.lock().await.source_delay = true;
    let drive = crate::cloud_drive::Drive::load(&state, crate::cloud_drive::Provider::Quark)
        .await
        .unwrap();
    assert!(
        delivery::original_context(
            &state,
            &drive,
            &link,
            Utc::now() + chrono::Duration::milliseconds(100)
        )
        .await
        .is_err()
    );
    assert_eq!(fact(&state, id).await.unwrap().validity, -1);
    upstream.lock().await.source_delay = false;
    for error in ["login", "rateLimit", "password", "upstream", "network"] {
        worker::record(&state, id, &json!({"status":"valid"}), &ProviderPolicy::default(),
        )
            .await
            .unwrap();
        worker::record(
            &state,
            id,
            &json!({"status":"unknown","errorKind":error}),
            &ProviderPolicy::default(),
        )
        .await
        .unwrap();
        assert_eq!(fact(&state, id).await.unwrap().validity, -1, "{error}");
    }
    // Deterministic quota checks use only this test's Redis DB and an unused provider.
    let provider = crate::cloud_drive::Provider::Baidu;
    let gate = "pansou:link-check:gate:baidu";
    let budget = format!("pansou:link-check:budget:baidu:{}", Utc::now().date_naive());
    let background = format!(
        "pansou:link-check:background:baidu:{}",
        Utc::now().date_naive()
    );
    let mut conn = state.redis.connection().unwrap();
    let _: i64 = conn
        .del(&[
            gate,
            &budget,
            &background,
            "pansou:link-check:breaker:baidu",
        ])
        .await
        .unwrap();
    let policy = ProviderPolicy {
        check_daily_budget: 10,
        check_interval_seconds: 2,
        ..ProviderPolicy::default()
    };
    for _ in 0..8 {
        assert!(
            worker::allow_check(&state, provider, &policy, false)
                .await
                .unwrap()
        );
        let _: i64 = conn.del(gate).await.unwrap();
    }
    assert!(
        !worker::allow_check(&state, provider, &policy, false)
            .await
            .unwrap()
    );
    for _ in 0..2 {
        assert!(
            worker::allow_check(&state, provider, &policy, true)
                .await
                .unwrap()
        );
        let _: i64 = conn.del(gate).await.unwrap();
    }
    assert!(
        !worker::allow_check(&state, provider, &policy, true)
            .await
            .unwrap()
    );
    let _: i64 = conn
        .del(&[
            gate,
            &budget,
            &background,
            "pansou:link-check:breaker:quark",
        ])
        .await
        .unwrap();
    task.abort();
}

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test"]
async fn admin_observations_are_per_link_password_scoped_and_read_only() {
    let url = std::env::var("PANSOU_TEST_DATABASE_URL").unwrap();
    assert!(Url::parse(&url).unwrap().path().ends_with("_test"));
    let pool = PgPoolOptions::new().max_connections(4).connect(&url).await.unwrap();
    crate::db::init_db(&pool).await.unwrap();
    let state = AppState::new(pool.clone(), RedisStore::disconnected());
    let unique = Uuid::new_v4().simple().to_string();
    let mut links = vec![];
    for (index, validity, stale) in [(0, 1, false), (1, 0, false), (2, 1, true)] {
        let link = Link { r#type: "quark".into(), url: format!("https://pan.quark.cn/s/{unique}{index}"), password: Some("1234".into()) ,
        };
        let id = register(&state, &link).await.unwrap();
        sqlx::query("UPDATE link_catalog SET validity=$2,checked_at=now(),valid_until=now()+make_interval(secs=>$3::double precision) WHERE id=$1").bind(id).bind(validity as i16).bind(if stale {-60.0} else {3600.0}).execute(&pool).await.unwrap();
        links.push(serde_json::to_value(link).unwrap());
    }
    let mut different_password = links[0].clone();
    different_password["password"] = json!("other");
    links.push(different_password);
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM link_catalog").fetch_one(&pool).await.unwrap();
    let mut resources = vec![json!({"linkValidity":1,"links":links}), json!({"links":[]})];
    admin_resource_observations(&state, &mut resources).await.unwrap();
    let links = resources[0]["links"].as_array().unwrap();
    assert_eq!(links[0]["validity"],1);
    assert_eq!(links[1]["validity"],0);
    assert_eq!(links[2]["validity"],-1);
    assert_eq!(links[2]["stale"],true);
    assert_eq!(links[3]["validity"],-1);
    assert!(links[3]["checkedAt"].is_null());
    assert_eq!(links[0]["password"],"1234");
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM link_catalog").fetch_one(&pool).await.unwrap(),before);
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test and PANSOU_TEST_REDIS_URL"]
async fn admin_manual_check_targets_only_the_selected_link() {
    let database = std::env::var("PANSOU_TEST_DATABASE_URL").unwrap();
    assert!(Url::parse(&database).unwrap().path().ends_with("_test"));
    let redis = std::env::var("PANSOU_TEST_REDIS_URL").unwrap();
    assert_eq!(Url::parse(&redis).unwrap().path(), "/15");
    let pool = PgPoolOptions::new().max_connections(4).connect(&database).await.unwrap();
    crate::db::init_db(&pool).await.unwrap();
    let upstream = Arc::new(Mutex::new(Upstream::default()));
    let server = Router::new().fallback(any(mock)).with_state(upstream.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}/", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, server).await.unwrap() });
    let mut state = AppState::new(pool.clone(), RedisStore::connect(&redis).await.unwrap());
    state.cloud_test_bases = Some(TestBases {
        baidu: Url::parse(&origin).unwrap(),
        quark_pc: Url::parse(&(origin.clone()+"qp/")).unwrap(),
        quark_share: Url::parse(&(origin+"qs/")).unwrap(),
    });
    let state = Arc::new(state);
    let router = crate::app::build_router(state.clone());
    let username = format!("link-check-{}", Uuid::new_v4());
    sqlx::query("INSERT INTO users(username,username_normalized,password_hash,role) VALUES($1,$1,$2,'admin')")
        .bind(&username).bind(crate::auth::hash_password("fixture-password").unwrap()).execute(&pool).await.unwrap();
    let (admin, _) = state.auth().login(&username,"fixture-password").await.unwrap();
    let anon = state.auth().issue(true).await.unwrap();
    sqlx::query("INSERT INTO cloud_account_settings(provider,credential) VALUES('quark','fixture=1') ON CONFLICT(provider) DO UPDATE SET credential=excluded.credential").execute(&pool).await.unwrap();
    let link = Link { r#type:"quark".into(),url:format!("https://pan.quark.cn/s/{}?pwd=1234",Uuid::new_v4().simple()),password:None ,
    };
    let sibling = Link { password:Some("different".into()),..link.clone() };
    let sibling_id = register(&state,&sibling).await.unwrap();
    worker::record(&state,sibling_id,&json!({"status":"invalid"}),&ProviderPolicy::default(),
    ).await.unwrap();
    let resource = format!("manual-check-{}",Uuid::new_v4());
    sqlx::query("INSERT INTO managed_resources(id,name,links_json) VALUES($1,'manual check',$2)").bind(&resource).bind(json!([link,sibling])).execute(&pool).await.unwrap();
    let path = format!("/api/admin/resources/{resource}/links/check");
    let input = json!({"linkKey":fingerprint(&link)});
    assert_eq!(call(&router,&anon,&path,input.clone()).await.0,StatusCode::FORBIDDEN);
    assert_eq!(call(&router,&admin,&path,json!({"linkKey":"outdated"})).await.0,StatusCode::CONFLICT);
    // Clear only this provider's test DB quota keys, never production Redis.
    use redis::AsyncCommands;
    let mut conn = state.redis.connection().unwrap();
    let _:i64 = conn.del(&[
        "pansou:link-check:gate:quark".to_owned(),
        "pansou:link-check:breaker:quark".to_owned(),
        format!("pansou:link-check:budget:quark:{}",Utc::now().date_naive()),
    ]).await.unwrap();
    let (status, result) = call(&router,&admin,&path,input.clone()).await;
    assert_eq!(status,StatusCode::OK,"{result}");
    assert_eq!(result["data"]["validity"],1,"{result}");
    assert_eq!(result["data"]["linkKey"],fingerprint(&link));
    assert!(result["data"]["checkedAt"].is_string());
    assert_eq!(fact(&state,sibling_id).await.unwrap().validity,0);
    let mut rows=vec![json!({"links":[link,sibling]})];
    admin_resource_observations(&state,&mut rows).await.unwrap();
    assert_eq!(rows[0]["links"][0]["validity"],1);
    assert_eq!(rows[0]["links"][1]["validity"],0);
    assert_eq!(rows[0]["links"][0]["checkSupported"],true);
    assert_eq!(call(&router,&admin,&path,input).await.0,StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(upstream.lock().await.transfer_count,0);
    task.abort();
}

#[tokio::test]
async fn ownership_manifest_reuses_root_listing_but_reads_all_descendants() {
    use crate::cloud_drive::{Drive, File, Provider};
    let upstream = Arc::new(Mutex::new(Upstream::default()));
    let root_files = vec![qfile("sub", "season", 0, true),qfile("rootfile","movie.mp4",42,false),
    ];
    upstream.lock().await.files.insert("root".into(),root_files.clone());
    upstream.lock().await.files.insert("sub".into(),vec![qfile("child","episode.mp4",42,false)]);
    let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin=format!("http://{}/",listener.local_addr().unwrap());
    let server=Router::new().fallback(any(mock)).with_state(upstream.clone());
    let task=tokio::spawn(async move {axum::serve(listener,server).await.unwrap()});
    let pool=PgPoolOptions::new().connect_lazy("postgres://fixture:fixture@localhost/not_connected_test").unwrap();
    let mut state=AppState::new(pool,RedisStore::disconnected());
    state.cloud_test_bases=Some(TestBases{baidu:Url::parse(&origin).unwrap(),quark_pc:Url::parse(&(origin.clone()+"qp/")).unwrap(),quark_share:Url::parse(&(origin+"qs/")).unwrap(),
    });
    let drive=Drive::from_state(&state,Provider::Quark,"fixture=1".into());
    let files=vec![File{id:"sub".into(),name:"season".into(),size:0,is_dir:true,md5:String::new(),path:String::new(),token:"fixture-token".into(),
        },File{id:"rootfile".into(),name:"movie.mp4".into(),size:42,is_dir:false,md5:String::new(),path:String::new(),token:"fixture-token".into(),
        },
    ];
    let reused=delivery::manifest_from_listing(&drive,"root",Some(files.clone())).await.unwrap();
    assert_eq!(upstream.lock().await.directory_reads,1,"only descendants are fetched");
    let live=delivery::manifest(&drive,"root").await.unwrap();
    assert_eq!(live,reused);
    assert_eq!(upstream.lock().await.directory_reads,3,"cleanup/resume reads root live");
    let oversized=vec![File{is_dir:false,..files[1].clone()};5001];
    assert!(delivery::manifest_from_listing(&drive,"root",Some(oversized)).await.is_err());
    task.abort();
}
