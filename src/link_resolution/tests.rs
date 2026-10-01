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
    empty_source: bool,
    unknown_file: bool,
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
            let id = format!("dir{}", state.directories.len() + 1);
            let value = qfile(&id, input["file_name"].as_str().unwrap(), 0, true);
            state.directories.insert(id, value.clone());
            json!({"code":0,"data":value})
        }
        "/qp/share/sharepage/save" => {
            state.transfer_count += 1;
            state.files.insert(
                input["to_pdir_fid"].as_str().unwrap().into(),
                vec![qfile("ownedfile", "movie.mp4", 42, false)],
            );
            json!({"code":0,"data":{"task_resp":{"data":{"status":2,"save_as":{"save_as_top_fids":["ownedfile"]}}}}})
        }
        "/qp/share" => {
            state.share_count += 1;
            json!({"code":0,"data":{"share_id":"ownshare"}})
        }
        "/qp/share/password" if state.password_failure => json!({"code":31024}),
        "/qp/share/password" => {
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
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(path)
                .header("authorization", format!("Bearer {}", session.token))
                .header("content-type", "application/json")
                .body(Body::from(value.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    assert_eq!(
        response
            .headers()
            .get("cache-control")
            .map(|v| v.to_str().unwrap()),
        Some("private, no-store")
    );
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
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
            &json!({}),
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
    sqlx::query("UPDATE policy_settings SET value_json=$1 WHERE key='link-delivery'").bind(json!({"revision":1,"quark":{"enabled":true,"targetDir":"project","deliveryTtlSeconds":3600,"deliveryMinRemainingSeconds":5,"platformShareDays":7},"baidu":{"enabled":false}})).execute(&pool).await.unwrap();
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
    worker::record(&state, id, &json!({"status":"invalid"}), &json!({}))
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
    sqlx::query("UPDATE policy_settings SET value_json=jsonb_set(value_json,'{revision}','2') WHERE key='link-delivery'").execute(&pool).await.unwrap();
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
    sqlx::query("UPDATE policy_settings SET value_json=jsonb_set(value_json,'{quark,enabled}','false') WHERE key='link-delivery'").execute(&pool).await.unwrap();
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
    sqlx::query("UPDATE policy_settings SET value_json=jsonb_set(value_json,'{quark,enabled}','true') WHERE key='link-delivery'").execute(&pool).await.unwrap();
    upstream.lock().await.invalid = false;
    worker::record(&state, id, &json!({"status":"valid"}), &json!({}))
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
    worker::record(&state, id, &json!({"status":"invalid"}), &json!({}))
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
        worker::record(&state, id, &json!({"status":"valid"}), &json!({}))
            .await
            .unwrap();
        worker::record(
            &state,
            id,
            &json!({"status":"unknown","errorKind":error}),
            &json!({}),
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
    let policy = json!({"dailyBudget":10,"intervalSeconds":2});
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
