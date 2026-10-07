//! Explicit opt-in integration tests. Never use the application database.
use crate::{
    app::{AppState, build_router},
    auth, crawl, db, local_index,
    models::Source,
    redis_store::RedisStore,
    telegram,
};
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{ConnectInfo, State},
    http::{Request, StatusCode, Uri},
    response::IntoResponse,
};
use chrono::Utc;
use serde_json::{Value, json};
use sqlx::{Row, postgres::PgPoolOptions};
use std::future::IntoFuture;
use std::{
    net::SocketAddr,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use tower::ServiceExt;

const DSL: &str = r#"{"kind":"html","item_selector":".tgme_widget_message","fields":{"name":".tgme_widget_message_text","description":".tgme_widget_message_text","datetime":"time::datetime","links":".tgme_widget_message_text a::href"}}"#;

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test"]
async fn empty_history_page_retries_without_losing_checkpoint() {
    let url = std::env::var("PANSOU_TEST_DATABASE_URL").unwrap();
    assert!(url::Url::parse(&url).unwrap().path().ends_with("_test"));
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .connect(&url)
        .await
        .unwrap();
    db::init_db(&pool).await.unwrap();
    sqlx::query("UPDATE crawl_channels SET enabled=false")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE crawl_jobs SET status='cancelled',lease_id=NULL,lease_until=NULL WHERE status IN ('queued','running','paused')").execute(&pool).await.unwrap();
    sqlx::query("UPDATE crawl_settings SET concurrent_channels=1,page_delay_seconds=0")
        .execute(&pool)
        .await
        .unwrap();
    let state = Arc::new(AppState::new(pool.clone(), RedisStore::disconnected()));
    let channel = format!("empty_{}", &uuid::Uuid::new_v4().simple().to_string()[..10]);
    let requests = Arc::new(AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(
        axum::serve(
            listener,
            Router::new()
                .fallback(|State(mock): State<Mock>| async move {
                    let call = mock.requests.fetch_add(1, Ordering::SeqCst);
                    let raw = if call == 1 {
                        format!(
                            r#"<a class="tme_messages_more" href="/s/{}?before=80"></a>{}"#,
                            mock.channel,
                            message(&mock.channel, 90, "重试恢复资源", "recovered").html
                        )
                    } else {
                        "<html><body>temporarily unavailable</body></html>".to_owned()
                    };
                    ([("content-type", "text/html; charset=utf-8")], raw)
                })
                .with_state(Mock {
                    channel: channel.clone(),
                    requests: requests.clone(),
                }),
        )
        .into_future(),
    );
    sqlx::query("INSERT INTO crawl_channels(id,name,transform,newest_message,history_cursor,history_pages,next_sync_at) VALUES($1,$1,$2,101,100,3312,now()+interval '1 day')")
        .bind(&channel).bind(DSL).execute(&pool).await.unwrap();
    let node = format!("node_{channel}");
    sqlx::query("INSERT INTO proxy_nodes(id,name,base_url) VALUES($1,$1,$2)")
        .bind(&node)
        .bind(format!("http://{addr}"))
        .execute(&pool)
        .await
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    crate::outbound::save(
        &mut tx,
        crate::outbound::Owner::Channel(&channel),
        &crate::outbound::Policy {
            nodes: vec![crate::outbound::NodeWeight {
                node_id: node,
                weight: 10,
            }],
            ..crate::outbound::Policy::direct()
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let job = crawl::enqueue(&pool, &channel, "backfill").await.unwrap();
    crawl::tick(&state).await.unwrap();
    let row = sqlx::query("SELECT status,cursor_before,attempts,next_run_at>now() deferred FROM crawl_jobs WHERE id=$1")
        .bind(job).fetch_one(&pool).await.unwrap();
    assert_eq!(
        row.get::<String, _>("status"),
        "queued",
        "one empty response must not stop backfill"
    );
    assert_eq!(row.get::<Option<i64>, _>("cursor_before"), Some(100));
    assert_eq!(row.get::<i32, _>("attempts"), 1);
    assert!(row.get::<bool, _>("deferred"));
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM crawl_page_failures WHERE channel_id=$1"
        )
        .bind(&channel)
        .fetch_one(&pool)
        .await
        .unwrap(),
        0
    );
    crawl::tick(&state).await.unwrap();
    assert_eq!(
        requests.load(Ordering::SeqCst),
        1,
        "backoff must be respected"
    );
    sqlx::query("UPDATE crawl_jobs SET next_run_at=now() WHERE id=$1")
        .bind(job)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE crawl_channels SET next_page_at=now() WHERE id=$1")
        .bind(&channel)
        .execute(&pool)
        .await
        .unwrap();
    crawl::tick(&state).await.unwrap();
    let row = sqlx::query("SELECT status,cursor_before,attempts FROM crawl_jobs WHERE id=$1")
        .bind(job)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(row.get::<String, _>("status"), "queued");
    assert_eq!(row.get::<Option<i64>, _>("cursor_before"), Some(80));
    assert_eq!(row.get::<i32, _>("attempts"), 0);
    let row = sqlx::query(
        "SELECT history_cursor,history_pages,history_complete FROM crawl_channels WHERE id=$1",
    )
    .bind(&channel)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.get::<Option<i64>, _>("history_cursor"), Some(80));
    assert_eq!(row.get::<i32, _>("history_pages"), 3313);
    assert!(!row.get::<bool, _>("history_complete"));
    // Persistent empty responses still stop after the bounded retry budget.
    sqlx::query("UPDATE crawl_jobs SET attempts=5 WHERE id=$1")
        .bind(job)
        .execute(&pool)
        .await
        .unwrap();
    crawl::tick(&state).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT status FROM crawl_jobs WHERE id=$1")
            .bind(job)
            .fetch_one(&pool)
            .await
            .unwrap(),
        "failed"
    );
    assert_eq!(
        sqlx::query_scalar::<_, Option<i64>>(
            "SELECT history_cursor FROM crawl_channels WHERE id=$1"
        )
        .bind(&channel)
        .fetch_one(&pool)
        .await
        .unwrap(),
        Some(80)
    );
    assert!(
        !sqlx::query_scalar::<_, bool>("SELECT history_complete FROM crawl_channels WHERE id=$1")
            .bind(&channel)
            .fetch_one(&pool)
            .await
            .unwrap()
    );
    server.abort();
    pool.close().await;
}

#[derive(Clone)]
struct Mock {
    channel: String,
    requests: Arc<AtomicUsize>,
}
fn message(channel: &str, id: i64, title: &str, share: &str) -> telegram::Message {
    let share = format!("{}-{share}", channel.rsplit('_').next().unwrap());
    telegram::Message {
        id,
        html: format!(
            r#"<div class="tgme_widget_message" data-post="{channel}/{id}"><div class="tgme_widget_message_text">名称：{title}<br/>描述：<b>独立的资源简介</b><br/>移动：<a href="https://yun.139.com/shareweb/#/w/i/{share}">https://yun.139.com/shareweb/#/w/i/{share}</a> 密码：AB12<br/>标签：#测试<br/><a href="https://t.me/{channel}/{id}">查看原帖</a></div><time datetime="2026-09-29T01:00:00Z"></time></div>"#
        ),
        published: Some(Utc::now()),
    }
}
async fn mock_limited(State(mock): State<Mock>) -> impl IntoResponse {
    mock.requests.fetch_add(1, Ordering::SeqCst);
    (
        StatusCode::TOO_MANY_REQUESTS,
        [("retry-after", "600")],
        "limited",
    )
}
async fn mock_page(State(mock): State<Mock>, uri: Uri) -> impl IntoResponse {
    mock.requests.fetch_add(1, Ordering::SeqCst);
    if uri.path() == "/live" {
        tokio::time::sleep(std::time::Duration::from_millis(750)).await;
        return (
            [("content-type", "application/json")],
            r#"{"items":[{"title":"慢来源资源","url":"https://pan.quark.cn/s/live-mock"}]}"#
                .to_owned(),
        );
    }
    if uri.path() == "/fast" {
        let share = format!(
            "https://yun.139.com/shareweb/#/w/i/{}-new-share",
            mock.channel.rsplit('_').next().unwrap()
        );
        return (
            [("content-type", "application/json")],
            json!({"items":[
                {"title":"快来源重复资源", "url":share},
                {"title":"快来源重复资源", "url":share}
            ]})
            .to_string(),
        );
    }
    let older = uri.path().contains("before%3D") || uri.path().contains("before%3d");
    let raw = if older {
        message(&mock.channel, 90, "历史资源", "older").html
    } else {
        format!(
            r#"<a class="tme_messages_more" href="/s/{}?before=100"></a>{}{}"#,
            mock.channel,
            message(&mock.channel, 101, "兰香如故", "test-a").html,
            message(&mock.channel, 100, "另一部电影", "test-b").html
        )
    };
    ([("content-type", "text/html; charset=utf-8")], raw)
}
async fn call(
    router: &Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Value,
) -> (StatusCode, String) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if let Some(token) = token {
        req = req.header("authorization", format!("Bearer {token}"));
    }
    let mut req = req.body(Body::from(body.to_string())).unwrap();
    req.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:41234".parse::<SocketAddr>().unwrap(),
    ));
    let response = router.clone().oneshot(req).await.unwrap();
    let status = response.status();
    let data = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        to_bytes(response.into_body(), 4 * 1024 * 1024),
    )
    .await
    .unwrap()
    .unwrap();
    (status, String::from_utf8(data.to_vec()).unwrap())
}
async fn ingest(
    state: &AppState,
    channel: &str,
    source: &Source,
    msg: telegram::Message,
) -> (usize, bool) {
    let mut parsed = telegram::messages(&msg.html, channel).unwrap().remove(0);
    parsed.published = msg.published;
    let mut tx = state.pool.begin().await.unwrap();
    let result = crawl::persist_message(&mut tx, channel, &parsed, source)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    result
}
#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test and PANSOU_TEST_REDIS_URL"]
async fn telegram_ingestion_search_and_admin_contracts() {
    let url = std::env::var("PANSOU_TEST_DATABASE_URL").expect("test database URL");
    let parsed = url::Url::parse(&url).unwrap();
    assert!(
        parsed.path().ends_with("_test"),
        "refuse integration test against non-test database"
    );
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .connect(&url)
        .await
        .unwrap();
    db::init_db(&pool).await.unwrap();
    // The suffix guard above authorizes disposable fixtures only, never the app database.
    sqlx::query("TRUNCATE crawl_page_failures,crawl_jobs,crawl_message_tasks,crawl_channels,managed_resources CASCADE").execute(&pool).await.unwrap();
    // The explicit isolated test database is disposable; disable previous test schedules only.
    sqlx::query("UPDATE resource_sources SET enabled=false")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE crawl_channels SET enabled=false")
        .execute(&pool)
        .await
        .unwrap();
    let redis =
        RedisStore::connect(&std::env::var("PANSOU_TEST_REDIS_URL").expect("test Redis URL"))
            .await
            .unwrap();
    let state = Arc::new(AppState::new(pool.clone(), redis));
    let unique = uuid::Uuid::new_v4().simple().to_string();
    let channel = format!("test_{}", &unique[..12]);
    let private = format!("private_{}", &unique[..12]);
    let source_id = format!("tg_{unique}");
    let source = Source {
        id: source_id.clone(),
        name: "测试 TG".into(),
        description: String::new(),
        url: format!("https://t.me/s/{channel}?q={{{{keyword}}}}"),
        method: "GET".into(),
        format: "html".into(),
        priority: 0,
        enabled: true,
        request: None,
        transform: DSL.into(),
    };
    sqlx::query("INSERT INTO resource_sources(id,name,url,method,format,transform) VALUES($1,$2,$3,'GET','html',$4)").bind(&source.id).bind(&source.name).bind(&source.url).bind(DSL).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO crawl_channels(id,name,transform) VALUES($1,'测试 TG',$2)")
        .bind(&channel)
        .bind(DSL)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE resource_sources SET channel_id=$2,kind='telegram' WHERE id=$1")
        .bind(&source_id)
        .bind(&channel)
        .execute(&pool)
        .await
        .unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let mock = Router::new()
        .route("/limited/{*path}", axum::routing::get(mock_limited))
        .fallback(mock_page)
        .with_state(Mock {
            channel: channel.clone(),
            requests: requests.clone(),
        });
    let server = tokio::spawn(async move { axum::serve(listener, mock).await.unwrap() });
    sqlx::query("INSERT INTO proxy_nodes(id,name,base_url) VALUES($1,'test',$2)")
        .bind(&source_id)
        .bind(format!("http://{addr}"))
        .execute(&pool)
        .await
        .unwrap();
    let p = crate::outbound::Policy {
        nodes: vec![crate::outbound::NodeWeight {
            node_id: source_id.clone(),
            weight: 10,
        }],
        ..crate::outbound::Policy::direct()
    };
    let mut tx = pool.begin().await.unwrap();
    crate::outbound::save(&mut tx, crate::outbound::Owner::Channel(&channel), &p)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    sqlx::query("UPDATE crawl_settings SET page_delay_seconds=0")
        .execute(&pool)
        .await
        .unwrap();
    let sync = crawl::enqueue(&pool, &channel, "sync").await.unwrap();
    assert!(crawl::enqueue(&pool, &channel, "sync").await.is_err());
    let backfill = crawl::enqueue(&pool, &channel, "backfill").await.unwrap();
    crawl::tick(&state).await.unwrap();
    let row = sqlx::query("SELECT status,diagnostics_json FROM crawl_jobs WHERE id=$1")
        .bind(sync)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        row.get::<String, _>("status"),
        "completed",
        "sync diagnostics: {row:?}"
    );
    assert_eq!(row.get::<Value, _>("diagnostics_json")["nodeId"], source_id);
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    crawl::tick(&state).await.unwrap();
    sqlx::query("UPDATE crawl_jobs SET next_run_at=now() WHERE id=$1")
        .bind(backfill)
        .execute(&pool)
        .await
        .unwrap();
    crawl::tick(&state).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT status FROM crawl_jobs WHERE id=$1")
            .bind(backfill)
            .fetch_one(&pool)
            .await
            .unwrap(),
        "completed"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM crawl_message_tasks WHERE channel_id=$1"
        )
        .bind(&channel)
        .fetch_one(&pool)
        .await
        .unwrap(),
        3
    );
    // Required-proxy routes must not silently fall back to direct requests.
    assert!(
        crate::outbound::Plan::load(
            &pool,
            crate::outbound::Owner::Channel("unlisted_public"),
            "GET"
        )
        .await
        .is_err()
    );
    sqlx::query("UPDATE proxy_nodes SET enabled=false WHERE id=$1")
        .bind(&source_id)
        .execute(&pool)
        .await
        .unwrap();
    let before = requests.load(Ordering::SeqCst);
    assert!(
        crawl::fetch_page(&state, &source, &channel, None)
            .await
            .is_err()
    );
    assert_eq!(requests.load(Ordering::SeqCst), before);
    sqlx::query("UPDATE proxy_nodes SET enabled=true WHERE id=$1")
        .bind(&source_id)
        .execute(&pool)
        .await
        .unwrap();
    // Upstream 429 honors Retry-After without proxy rotation or partial-page commits.
    sqlx::query("UPDATE proxy_nodes SET base_url=$2 WHERE id=$1")
        .bind(&source_id)
        .bind(format!("http://{addr}/limited"))
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE crawl_channels SET next_page_at=now() WHERE id=$1")
        .bind(&channel)
        .execute(&pool)
        .await
        .unwrap();
    let limited = crawl::enqueue(&pool, &channel, "sync").await.unwrap();
    crawl::tick(&state).await.unwrap();
    let limited_row=sqlx::query("SELECT status,pages,last_error,extract(epoch FROM next_run_at-now())::bigint AS delay FROM crawl_jobs WHERE id=$1").bind(limited).fetch_one(&pool).await.unwrap();
    assert_eq!(limited_row.get::<String, _>("status"), "queued");
    assert_eq!(limited_row.get::<i32, _>("pages"), 0);
    assert!(
        limited_row
            .get::<String, _>("last_error")
            .contains("HTTP 429")
    );
    assert!(limited_row.get::<i64, _>("delay") >= 590);
    sqlx::query("UPDATE crawl_jobs SET status='cancelled' WHERE id=$1")
        .bind(limited)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE proxy_nodes SET base_url=$2 WHERE id=$1")
        .bind(&source_id)
        .bind(format!("http://{addr}"))
        .execute(&pool)
        .await
        .unwrap();
    // A rolled-back page creates neither message nor resources.
    let mut tx = pool.begin().await.unwrap();
    crawl::persist_message(
        &mut tx,
        &channel,
        &message(&channel, 999, "回滚不出现", "rollback"),
        &source,
    )
    .await
    .unwrap();
    tx.rollback().await.unwrap();
    assert!(!sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM crawl_message_tasks WHERE channel_id=$1 AND message_id=999)"
    )
    .bind(&channel)
    .fetch_one(&pool)
    .await
    .unwrap());
    let local = local_index::query(&state, std::slice::from_ref(&channel), "兰香")
        .await
        .unwrap();
    assert_eq!(local.len(), 1);
    let resource = local[0].clone();
    assert_eq!(resource.name, "兰香如故");
    assert_eq!(resource.description.as_deref(), Some("独立的资源简介"));
    for description_or_tag in ["独立的资源简介", "测试"] {
        assert!(
            local_index::query(&state, std::slice::from_ref(&channel), description_or_tag)
                .await
                .unwrap()
                .is_empty(),
            "description and tags must not participate in matching"
        );
    }
    assert_eq!(resource.links[0].password.as_deref(), Some("AB12"));
    assert!(!resource.name.contains("http"));
    assert!(!resource.description.as_ref().unwrap().contains('<'));
    let same = message(&channel, 101, "兰香如故", "test-a");
    assert_eq!(ingest(&state, &channel, &source, same).await, (1, false));
    let resource_xmin: String = sqlx::query_scalar(
        "SELECT xmin::text FROM managed_resources WHERE source_channel_id=$1 AND source_message_id=101",
    )
    .bind(&channel)
    .fetch_one(&pool)
    .await
    .unwrap();
    let revision: i64 =
        sqlx::query_scalar("SELECT revision FROM config_revisions WHERE scope='local-index'")
            .fetch_one(&pool)
            .await
            .unwrap();
    let mut unchanged = message(&channel, 101, "兰香如故", "test-a");
    unchanged.published = sqlx::query_scalar("SELECT published_at FROM managed_resources WHERE source_channel_id=$1 AND source_message_id=101 LIMIT 1")
        .bind(&channel).fetch_one(&pool).await.unwrap();
    assert_eq!(
        ingest(&state, &channel, &source, unchanged).await,
        (1, false)
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT xmin::text FROM managed_resources WHERE source_channel_id=$1 AND source_message_id=101"
        )
        .bind(&channel)
        .fetch_one(&pool)
        .await
        .unwrap(),
        resource_xmin
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT revision FROM config_revisions WHERE scope='local-index'"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        revision
    );
    assert_eq!(
        ingest(
            &state,
            &channel,
            &source,
            message(&channel, 101, "兰香如故新版", "test-a")
        )
        .await,
        (1, false)
    );
    let edited = local_index::query(&state, std::slice::from_ref(&channel), "新版")
        .await
        .unwrap();
    assert_eq!(edited[0].id, resource.id);
    assert_eq!(
        ingest(
            &state,
            &channel,
            &source,
            message(&channel, 101, "兰香如故更换分享", "new-share")
        )
        .await,
        (1, false)
    );
    let replacement = local_index::query(&state, std::slice::from_ref(&channel), "更换")
        .await
        .unwrap()[0]
        .clone();
    assert_ne!(
        replacement.id, resource.id,
        "changed link sets create independent resources"
    );
    assert_eq!(
        local_index::query(&state, std::slice::from_ref(&channel), "新版")
            .await
            .unwrap()
            .len(),
        1
    );
    sqlx::query("UPDATE managed_resources SET enabled=false WHERE id=$1")
        .bind(&resource.id)
        .execute(&pool)
        .await
        .unwrap();
    let resource = replacement;
    // An unrelated channel's resource remains outside the selected source scope.
    sqlx::query("INSERT INTO crawl_channels(id,enabled) VALUES($1,false)")
        .bind(&private)
        .execute(&pool)
        .await
        .unwrap();
    ingest(
        &state,
        &private,
        &source,
        message(&private, 300, "私有标题不能泄露", "private-share"),
    )
    .await;
    assert!(
        local_index::query(&state, std::slice::from_ref(&channel), "私有标题")
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        local_index::query(&state, std::slice::from_ref(&channel), "兰香")
            .await
            .unwrap()[0]
            .name,
        "兰香如故更换分享"
    );
    let fallback = AppState::new(pool.clone(), RedisStore::disconnected());
    assert_eq!(
        local_index::query(&fallback, std::slice::from_ref(&channel), "兰香")
            .await
            .unwrap()
            .len(),
        1
    );
    let shared_scope = vec![channel.clone(), private.clone()];
    let shared = local_index::query(&state, &shared_scope, "").await.unwrap();
    assert_eq!(
        shared.iter().filter(|item| item.id == resource.id).count(),
        1
    );
    let user = format!("admin_{unique}");
    sqlx::query("INSERT INTO users(username,username_normalized,password_hash,role) VALUES($1,$1,$2,'admin')").bind(&user).bind(auth::hash_password(&unique).unwrap()).execute(&pool).await.unwrap();
    let session = state.auth().login(&user, &unique).await.unwrap().0;
    let anon = state.auth().issue(true).await.unwrap();
    let router = build_router(state.clone());
    assert_eq!(
        call(
            &router,
            "POST",
            "/api/admin/resources",
            Some(&session.token),
            json!({"name":"invalid types fixture","cloud_types":{"not":"an array"}})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST,
    );
    for path in ["/api/admin/crawl/channels", "/api/search/json?kw=x"] {
        assert_eq!(
            call(&router, "GET", path, Some(&anon.token), Value::Null)
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        call(&router, "POST", "/api/search", None, json!({"kw":"兰香"}))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let (status, json_response) = call(
        &router,
        "GET",
        &format!("/api/search/json?kw=%E5%85%B0%E9%A6%99&sourceIds={source_id}"),
        Some(&session.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{json_response}");
    let payload: Value = serde_json::from_str(&json_response).unwrap();
    assert_eq!(payload["data"]["total"], 1);
    assert_eq!(payload["data"]["results"].as_array().unwrap().len(), 1);
    assert_eq!(payload["data"]["contractVersion"], 2);
    assert!(payload["data"]["results"][0]["resultRef"].is_string());
    assert!(payload["data"]["results"][0].get("tags").is_none());
    assert!(
        payload["data"]["results"][0]["links"][0]
            .get("url")
            .is_none()
    );
    assert!(!json_response.contains("yun.139.com"));
    assert!(!json_response.contains("AB12"));
    let visible = &payload["data"]["results"][0];
    let (status,delivered)=call(&router,"POST","/api/links/resolve",Some(&session.token),json!({"resultRef":visible["resultRef"],"linkRef":visible["links"][0]["linkRef"],"requestKey":uuid::Uuid::new_v4()})).await;
    assert_eq!(status, StatusCode::OK, "{delivered}");
    assert!(
        serde_json::from_str::<Value>(&delivered).unwrap()["data"]["url"]
            .as_str()
            .unwrap()
            .contains("yun.139.com")
    );
    assert!(payload["data"]["results"][0].get("priority").is_none());
    assert!(payload["data"]["results"][0].get("sourceId").is_none());
    assert!(payload["data"]["sources"].as_array().unwrap().is_empty());
    let network_before = requests.load(Ordering::SeqCst);
    let (status, sse) = call(
        &router,
        "POST",
        "/api/search",
        Some(&anon.token),
        json!({"kw":"兰香","source_ids":[source_id]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{sse}");
    assert!(sse.contains("event: result"), "{sse}");
    assert!(sse.contains("event: complete"), "{sse}");
    assert!(!sse.contains("\"tags\""), "{sse}");
    assert!(sse.contains("兰香如故更换分享"));
    assert!(!sse.contains("plugin:"));
    assert_eq!(
        network_before,
        requests.load(Ordering::SeqCst),
        "search must not fetch TG"
    );
    // Saving user preferences never registers an ingestion channel.
    let (_, saved) = call(
        &router,
        "POST",
        "/api/account/channels",
        Some(&session.token),
        json!({"channels":["only_live_channel"]}),
    )
    .await;
    assert!(saved.contains("only_live_channel"));
    assert!(
        !sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM crawl_channels WHERE id='only_live_channel')"
        )
        .fetch_one(&pool)
        .await
        .unwrap()
    );
    let live_sources = crate::handlers::search::load_sources(
        &state,
        None,
        Some(&vec!["only_live_channel".into()]),
    )
    .await
    .unwrap();
    assert!(live_sources.local_channels.is_empty());
    assert_eq!(live_sources.live_sources[0].id, "custom:only_live_channel");
    assert_eq!(live_sources.live_sources[0].transform, DSL);
    sqlx::query("UPDATE crawl_channels SET next_page_at=now() WHERE id=$1")
        .bind(&channel)
        .execute(&pool)
        .await
        .unwrap();
    // Mixed SSE must deliver local results before a slow live source finishes.
    let live_id = format!("live_{unique}");
    sqlx::query("INSERT INTO resource_sources(id,name,url,method,format,transform) VALUES($1,'live',$2,'GET','json',$3)").bind(&live_id).bind(format!("http://{addr}/live")).bind(r#"{"kind":"json","items":"$.items[*]","fields":{"name":"title","url":"url"}}"#).execute(&pool).await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    crate::outbound::save(
        &mut tx,
        crate::outbound::Owner::Source(&live_id),
        &crate::outbound::Policy::direct(),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let fast_id = format!("fast_{unique}");
    sqlx::query("INSERT INTO resource_sources(id,name,url,method,format,priority,transform) VALUES($1,'fast',$2,'GET','json',-10,$3)")
        .bind(&fast_id).bind(format!("http://{addr}/fast"))
        .bind(r#"{"kind":"json","items":"$.items[*]","fields":{"name":"title","url":"url"}}"#)
        .execute(&pool).await.unwrap();
    sqlx::query("UPDATE resource_sources SET priority=9999 WHERE id=$1")
        .bind(&source_id)
        .execute(&pool)
        .await
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    crate::outbound::save(
        &mut tx,
        crate::outbound::Owner::Source(&fast_id),
        &crate::outbound::Policy::direct(),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let mut req = Request::builder()
        .method("POST")
        .uri("/api/search")
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {}", session.token))
        .body(Body::from(
            json!({"kw":"兰香","source_ids":[source_id,live_id,fast_id]}).to_string(),
        ))
        .unwrap();
    req.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:41234".parse::<SocketAddr>().unwrap(),
    ));
    let response = router.clone().oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    use futures::StreamExt;
    let mut chunks = response.into_body().into_data_stream();
    let mut text = String::new();
    let clock = std::time::Instant::now();
    let mut first_local = None;
    while let Some(chunk) = chunks.next().await {
        text.push_str(std::str::from_utf8(&chunk.unwrap()).unwrap());
        if first_local.is_none() && text.contains("兰香如故更换分享") {
            first_local = Some(clock.elapsed());
            assert!(!text.contains("慢来源资源"));
            assert!(!text.contains("快来源重复资源"));
        }
    }
    assert!(
        first_local.unwrap() < std::time::Duration::from_millis(700),
        "local results blocked by slow live source"
    );
    assert!(text.contains("慢来源资源"));
    assert!(text.contains("event: complete"));
    let batches = text
        .lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .map(|data| serde_json::from_str::<Value>(data).unwrap())
        .collect::<Vec<_>>();
    let records = batches
        .iter()
        .filter_map(|event| event["results"].as_array())
        .flatten()
        .collect::<Vec<_>>();
    assert_eq!(
        records.len(),
        4,
        "search must preserve duplicate live records"
    );
    assert_eq!(records[0]["name"], "兰香如故更换分享");
    assert!(records[0]["resultRef"].is_string());
    assert!(!text.contains("yun.139.com"));
    assert!(!text.contains("pan.quark.cn"));
    assert_eq!(batches.last().unwrap()["total"], 4);
    let (status, mixed_json) = call(
        &router,
        "GET",
        "/api/search/json?kw=%E5%85%B0%E9%A6%99",
        Some(&session.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{mixed_json}");
    let mixed: Value = serde_json::from_str(&mixed_json).unwrap();
    assert_eq!(mixed["data"]["total"], 4);
    assert_eq!(mixed["data"]["results"].as_array().unwrap().len(), 4);
    assert_eq!(mixed["data"]["results"][0]["name"], "兰香如故更换分享");
    assert!(!mixed_json.contains("yun.139.com"));
    assert!(!mixed_json.contains("pan.quark.cn"));
    let external = mixed["data"]["sources"].as_array().unwrap();
    assert_eq!(external.len(), 2);
    assert_eq!(external[0]["id"], fast_id);
    assert!(!external.iter().any(|source| source["id"] == source_id));
    // Cached live-only SSE also preserves duplicate records and reports raw totals.
    let cache_body = json!({"kw":"兰香","source_ids":[fast_id]});
    let (_, first) = call(
        &router,
        "POST",
        "/api/search",
        Some(&session.token),
        cache_body.clone(),
    )
    .await;
    assert!(first.contains("\"total\":3"));
    let before_cached = requests.load(Ordering::SeqCst);
    let (status, cached) = call(
        &router,
        "POST",
        "/api/search",
        Some(&session.token),
        cache_body,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{cached}");
    assert_eq!(
        before_cached + 1,
        requests.load(Ordering::SeqCst),
        "system mode still combines local records with requested live sources"
    );
    assert_eq!(cached.matches("快来源重复资源").count(), 2);
    assert!(cached.contains("\"total\":3"));
    let (status, list) = call(
        &router,
        "GET",
        "/api/admin/crawl/channels",
        Some(&session.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let (status, messages) = call(
        &router,
        "GET",
        &format!("/api/admin/crawl/channels/{channel}/messages"),
        Some(&session.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{messages}");
    let messages: Value = serde_json::from_str(&messages).unwrap();
    for item in messages["data"]["items"].as_array().unwrap() {
        for removed in ["rawHtml", "rawText", "summary"] {
            assert!(
                item.get(removed).is_none(),
                "removed field {removed}: {item}"
            );
        }
    }
    let (status, preview) = call(
        &router,
        "POST",
        &format!("/api/admin/crawl/channels/{channel}/messages/101/preview"),
        Some(&session.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{preview}");
    let (status,edited)=call(&router,"PUT",&format!("/api/admin/resources/{}",resource.id),Some(&session.token),json!({"name":"管理员修订","description":"手动内容","links":resource.links,"cloud_types":["mobile"]})).await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!(
        local_index::query(&state, std::slice::from_ref(&channel), "管理员修订")
            .await
            .unwrap()
            .len(),
        1
    );
    ingest(
        &state,
        &channel,
        &source,
        message(&channel, 101, "采集更新资源内容", "new-share"),
    )
    .await;
    assert_eq!(
        local_index::query(&state, std::slice::from_ref(&channel), "采集更新资源内容")
            .await
            .unwrap()
            .len(),
        1
    );
    let (status, deleted) = call(
        &router,
        "DELETE",
        &format!("/api/admin/resources/{}", resource.id),
        Some(&session.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{deleted}");
    assert!(
        local_index::query(&state, std::slice::from_ref(&channel), "管理员修订")
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        sqlx::query_scalar::<_, bool>(
            "SELECT NOT EXISTS(SELECT 1 FROM managed_resources WHERE id=$1)"
        )
        .bind(&resource.id)
        .fetch_one(&pool)
        .await
        .unwrap()
    );
    let job = crawl::enqueue(&pool, &channel, "sync").await.unwrap();
    let (status, pause) = call(
        &router,
        "PUT",
        &format!("/api/admin/crawl/channels/{channel}"),
        Some(&session.token),
        json!({"id":channel,"name":"测试 TG","description":"","enabled":false,"expectedVersion":1,"transform":DSL,"outbound":crate::outbound::read(&pool,crate::outbound::Owner::Channel(&channel)).await.unwrap().unwrap()}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{pause}");
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT status FROM crawl_jobs WHERE id=$1")
            .bind(job)
            .fetch_one(&pool)
            .await
            .unwrap(),
        "paused"
    );
    let cancel=sqlx::query("UPDATE crawl_jobs SET status='cancelled',lease_id=NULL,lease_until=NULL,stop_reason='admin_cancelled',completed_at=now(),updated_at=now() WHERE id=$1 AND status IN ('queued','running','paused')").bind(job).execute(&pool).await.unwrap().rows_affected();
    assert_eq!(cancel, 1);
    sqlx::query("UPDATE crawl_channels SET next_page_at=now() WHERE id=$1")
        .bind(&channel)
        .execute(&pool)
        .await
        .unwrap();
    // Recover a worker crash/expired lease without losing durable task progress.
    sqlx::query(
        "UPDATE crawl_channels SET enabled=true,next_sync_at=now()+interval '1 day' WHERE id=$1",
    )
    .bind(&channel)
    .execute(&pool)
    .await
    .unwrap();
    let recovery = crawl::enqueue(&pool, &channel, "sync").await.unwrap();
    sqlx::query("UPDATE crawl_jobs SET status='running',lease_id=$2,lease_until=now()-interval '1 second' WHERE id=$1").bind(recovery).bind(uuid::Uuid::new_v4()).execute(&pool).await.unwrap();
    let network_before = requests.load(Ordering::SeqCst);
    crawl::tick(&state).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT status FROM crawl_jobs WHERE id=$1")
            .bind(recovery)
            .fetch_one(&pool)
            .await
            .unwrap(),
        "completed"
    );
    assert_eq!(
        network_before + 1,
        requests.load(Ordering::SeqCst),
        "resumed sync fetches its page again"
    );
    state.auth().revoke_session(&session).await.unwrap();
    state.auth().revoke_session(&anon).await.unwrap();
    server.abort();
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test and PANSOU_TEST_REDIS_URL"]
async fn channel_scheduling_and_page_failures() {
    let url = std::env::var("PANSOU_TEST_DATABASE_URL").unwrap();
    assert!(url::Url::parse(&url).unwrap().path().ends_with("_test"));
    let pool = PgPoolOptions::new()
        .max_connections(16)
        .connect(&url)
        .await
        .unwrap();
    db::init_db(&pool).await.unwrap();
    sqlx::query("UPDATE crawl_channels SET enabled=false")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE crawl_jobs SET status='cancelled',lease_id=NULL,lease_until=NULL WHERE status IN ('queued','running','paused')").execute(&pool).await.unwrap();
    sqlx::query("UPDATE crawl_settings SET concurrent_channels=1,page_delay_seconds=0")
        .execute(&pool)
        .await
        .unwrap();
    let redis = RedisStore::connect(&std::env::var("PANSOU_TEST_REDIS_URL").unwrap())
        .await
        .unwrap();
    let mut state = AppState::new(pool.clone(), redis);
    let unique = uuid::Uuid::new_v4().simple().to_string();
    let channel = format!("sched_{}", &unique[..10]);
    let requests = Arc::new(AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(
        axum::serve(
            listener,
            Router::new().fallback(mock_page).with_state(Mock {
                channel: channel.clone(),
                requests: requests.clone(),
            }),
        )
        .into_future(),
    );
    state.custom_test_base = Some(format!("http://{addr}"));
    let state = Arc::new(state);
    sqlx::query("INSERT INTO crawl_channels(id,name,transform,newest_message,next_sync_at) VALUES($1,$1,$2,101,now()+interval '1 day')").bind(&channel).bind(DSL).execute(&pool).await.unwrap();
    let node = format!("sched_node_{unique}");
    sqlx::query("INSERT INTO proxy_nodes(id,name,base_url) VALUES($1,$1,$2)")
        .bind(&node)
        .bind(format!("http://{addr}"))
        .execute(&pool)
        .await
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    crate::outbound::save(
        &mut tx,
        crate::outbound::Owner::Channel(&channel),
        &crate::outbound::Policy {
            nodes: vec![crate::outbound::NodeWeight {
                node_id: node.clone(),
                weight: 10,
            }],
            ..crate::outbound::Policy::direct()
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    // Opposite resource order across concurrent channel commits must not deadlock.
    let peer = format!("peer_{}", &unique[..10]);
    sqlx::query("INSERT INTO crawl_channels(id,name,enabled,transform) VALUES($1,$1,false,$2)")
        .bind(&peer)
        .bind(DSL)
        .execute(&pool)
        .await
        .unwrap();
    let source = crawl::source_for(&pool, &channel).await.unwrap();
    let commit = |channel: String,
                  shares: Vec<&'static str>,
                  state: Arc<AppState>,
                  source: Source| async move {
        let mut tx = state.pool.begin().await.unwrap();
        for (i, share) in shares.iter().enumerate() {
            crawl::persist_message(
                &mut tx,
                &channel,
                &message(&channel, 600 + i as i64, "并行共用资源", share),
                &source,
            )
            .await
            .unwrap();
        }
        tx.commit().await.unwrap();
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        tokio::join!(
            commit(
                channel.clone(),
                vec!["shared-a", "shared-b"],
                state.clone(),
                source.clone()
            ),
            commit(peer, vec!["shared-b", "shared-a"], state.clone(), source)
        );
    })
    .await
    .expect("concurrent page commit deadlocked");
    // Previously reaching 500 pages does not end the historical job.
    let history = crawl::enqueue(&pool, &channel, "backfill").await.unwrap();
    sqlx::query("UPDATE crawl_jobs SET pages=501 WHERE id=$1")
        .bind(history)
        .execute(&pool)
        .await
        .unwrap();
    crawl::tick(&state).await.unwrap();
    let row = sqlx::query("SELECT pages,status,cursor_before FROM crawl_jobs WHERE id=$1")
        .bind(history)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(row.get::<i32, _>("pages"), 502);
    assert_eq!(row.get::<String, _>("status"), "queued");
    assert_eq!(row.get::<Option<i64>, _>("cursor_before"), Some(100));
    // Due daily sync is interleaved before the next history page.
    sqlx::query("UPDATE crawl_channels SET next_sync_at=now() WHERE id=$1")
        .bind(&channel)
        .execute(&pool)
        .await
        .unwrap();
    crawl::tick(&state).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i32>("SELECT pages FROM crawl_jobs WHERE id=$1")
            .bind(history)
            .fetch_one(&pool)
            .await
            .unwrap(),
        502
    );
    crawl::tick(&state).await.unwrap();
    assert!(
        sqlx::query_scalar::<_, bool>("SELECT history_complete FROM crawl_channels WHERE id=$1")
            .bind(&channel)
            .fetch_one(&pool)
            .await
            .unwrap()
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT status FROM crawl_jobs WHERE id=$1")
            .bind(history)
            .fetch_one(&pool)
            .await
            .unwrap(),
        "completed"
    );
    // A global occupied slot prevents another channel from being claimed.
    let blocker = format!("block_{}", &unique[..10]);
    sqlx::query("INSERT INTO crawl_channels(id,name,enabled,history_complete,next_sync_at) VALUES($1,$1,false,true,now()+interval '1 day')").bind(&blocker).execute(&pool).await.unwrap();
    let blocked_job=sqlx::query_scalar::<_,i64>("INSERT INTO crawl_jobs(channel_id,kind,status,lease_id,lease_until) VALUES($1,'sync','running',$2,now()+interval '60 seconds') RETURNING id").bind(&blocker).bind(uuid::Uuid::new_v4()).fetch_one(&pool).await.unwrap();
    let sync = crawl::enqueue(&pool, &channel, "sync").await.unwrap();
    let before = requests.load(Ordering::SeqCst);
    crawl::tick(&state).await.unwrap();
    assert_eq!(requests.load(Ordering::SeqCst), before);
    sqlx::query(
        "UPDATE crawl_jobs SET status='cancelled',lease_id=NULL,lease_until=NULL WHERE id=$1",
    )
    .bind(blocked_job)
    .execute(&pool)
    .await
    .unwrap();
    // Shared per-channel wait applies even when switching from backfill to daily.
    sqlx::query("UPDATE crawl_channels SET next_page_at=now()+interval '1 hour' WHERE id=$1")
        .bind(&channel)
        .execute(&pool)
        .await
        .unwrap();
    crawl::tick(&state).await.unwrap();
    assert_eq!(requests.load(Ordering::SeqCst), before);
    sqlx::query("UPDATE crawl_channels SET next_page_at=now() WHERE id=$1")
        .bind(&channel)
        .execute(&pool)
        .await
        .unwrap();
    crawl::tick(&state).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT status FROM crawl_jobs WHERE id=$1")
            .bind(sync)
            .fetch_one(&pool)
            .await
            .unwrap(),
        "completed"
    );
    let username = format!("sched_admin_{unique}");
    sqlx::query("INSERT INTO users(username,username_normalized,password_hash,role) VALUES($1,$1,$2,'admin')").bind(&username).bind(auth::hash_password(&unique).unwrap()).execute(&pool).await.unwrap();
    let session = state.auth().login(&username, &unique).await.unwrap().0;
    let router = build_router(state.clone());
    let (_, cfg) = call(
        &router,
        "GET",
        "/api/admin/crawl/settings",
        Some(&session.token),
        Value::Null,
    )
    .await;
    let mut cfg = serde_json::from_str::<Value>(&cfg).unwrap()["data"].clone();
    cfg["pageDelaySeconds"] = json!(2);
    assert_eq!(
        call(
            &router,
            "PUT",
            "/api/admin/crawl/settings",
            Some(&session.token),
            cfg.clone()
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &router,
            "PUT",
            "/api/admin/crawl/settings",
            Some(&session.token),
            cfg
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    sqlx::query("UPDATE crawl_settings SET page_delay_seconds=0")
        .execute(&pool)
        .await
        .unwrap();
    let failure=sqlx::query_scalar::<_,i64>("INSERT INTO crawl_page_failures(channel_id,kind,cursor_before,page_number,last_error) VALUES($1,'backfill',100,503,'test parse failure') RETURNING id").bind(&channel).fetch_one(&pool).await.unwrap();
    let path = format!("/api/admin/crawl/channels/{channel}/failures");
    let (code, reply) = call(
        &router,
        "POST",
        &path,
        Some(&session.token),
        json!({"action":"retry","ids":[failure]}),
    )
    .await;
    assert_eq!(code, StatusCode::OK, "{reply}");
    crawl::tick(&state).await.unwrap();
    assert!(
        !sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM crawl_page_failures WHERE id=$1)"
        )
        .bind(failure)
        .fetch_one(&pool)
        .await
        .unwrap()
    );
    let fail=sqlx::query_scalar::<_,i64>("INSERT INTO crawl_page_failures(channel_id,kind,cursor_before,page_number,last_error) VALUES($1,'backfill',90,504,'ignore test') RETURNING id").bind(&channel).fetch_one(&pool).await.unwrap();
    let count = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM managed_resources")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        call(
            &router,
            "POST",
            &path,
            Some(&session.token),
            json!({"action":"ignore","ids":[fail]})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert!(
        !sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM crawl_page_failures WHERE id=$1)"
        )
        .bind(fail)
        .fetch_one(&pool)
        .await
        .unwrap()
    );
    assert_eq!(
        count,
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM managed_resources")
            .fetch_one(&pool)
            .await
            .unwrap()
    );
    for obsolete in [
        format!("/api/admin/crawl/channels/{channel}/archive"),
        format!("/api/admin/crawl/channels/{channel}/messages/101/reparse"),
    ] {
        assert_eq!(
            call(&router, "POST", &obsolete, Some(&session.token), json!({}))
                .await
                .0,
            StatusCode::NOT_FOUND
        );
    }
    // A custom search performs HTTP against submitted channels, does not ingest and uses shared, expiring Redis capabilities.
    let before = requests.load(Ordering::SeqCst);
    let (code, live) = call(
        &router,
        "POST",
        "/api/search",
        Some(&session.token),
        json!({"kw":"兰香","channels":[channel],"source_ids":["not_a_system_source"]}),
    )
    .await;
    assert_eq!(code, StatusCode::OK, "{live}");
    assert_eq!(requests.load(Ordering::SeqCst), before + 1);
    assert!(live.contains("custom:"));
    assert!(!live.contains("yun.139.com"));
    assert!(!live.contains("历史资源"));
    // A second API instance can create a capability that the first instance resolves.
    let isolated = AppState::new(pool.clone(), state.redis.clone());
    let request: crate::models::SearchRequest =
        serde_json::from_value(json!({"kw":"x","channels":[channel]})).unwrap();
    let source = crawl::source_for(&pool, &channel).await.unwrap();
    let resources =
        crawl::parse_message(&source, &channel, &message(&channel, 101, "仅实时", "live")).results;
    assert!(!resources.is_empty());
    let projected = crate::link_resolution::project(
        &isolated,
        &session,
        &request,
        Some(&format!("custom:{channel}")),
        &resources,
    )
    .await
    .unwrap();
    assert!(
        projected[0]["resultRef"]
            .as_str()
            .unwrap()
            .starts_with("custom:")
    );
    let (status, body) = call(&router, "POST", "/api/links/status", Some(&session.token),
        json!({"items":[{"resultRef":projected[0]["resultRef"],"linkRef":projected[0]["links"][0]["linkRef"]}]})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let body: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(body["data"]["items"][0]["errorCode"].is_null(), "{body}");
    assert_eq!(
        count,
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM managed_resources")
            .fetch_one(&pool)
            .await
            .unwrap()
    );
    state.auth().revoke_session(&session).await.unwrap();
    server.abort();
}

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test and PANSOU_TEST_REDIS_URL"]
async fn today_success_counts_match_records_without_resource_deduplication() {
    let url = std::env::var("PANSOU_TEST_DATABASE_URL").unwrap();
    assert!(url::Url::parse(&url).unwrap().path().ends_with("_test"));
    let pool = db::connect(&url).await.unwrap();
    db::init_db(&pool).await.unwrap();
    let redis = RedisStore::connect(&std::env::var("PANSOU_TEST_REDIS_URL").unwrap())
        .await
        .unwrap();
    let state = Arc::new(AppState::new(pool.clone(), redis));
    let unique = uuid::Uuid::new_v4().simple().to_string();
    let channel = format!("today_{unique}");
    let visible = format!("visible_{unique}");
    let disabled = format!("disabled_{unique}");
    sqlx::query("INSERT INTO crawl_channels(id,name,enabled) VALUES($1,$1,false)")
        .bind(&channel)
        .execute(&pool)
        .await
        .unwrap();
    for (resource, enabled) in [(&visible, true), (&disabled, false)] {
        sqlx::query("INSERT INTO managed_resources(id,name,enabled,source_channel_ids) VALUES($1,$1,$2,ARRAY[$3::text])")
            .bind(resource).bind(enabled).bind(&channel).execute(&pool).await.unwrap();
    }
    let start: chrono::DateTime<Utc> = sqlx::query_scalar(
        "SELECT date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    for (id, status, resources, at) in [
        (1i64, "parsed", vec![visible.clone()], start),
        (2, "parsed", vec![visible.clone()], start),
        (3, "parsed", vec![disabled.clone()], start),
        (4, "parsed", vec![format!("deleted_{unique}")], start),
        (5, "empty", vec![], start),
        (6, "failed", vec![], start),
        (
            7,
            "parsed",
            vec![visible.clone()],
            start - chrono::Duration::seconds(1),
        ),
        (8, "failed", vec![], start - chrono::Duration::seconds(1)),
    ] {
        sqlx::query("INSERT INTO crawl_message_tasks(channel_id,message_id,status,resource_ids,task_at,error_message) VALUES($1,$2,$3,$4,$5,CASE WHEN $3='failed' THEN 'test failure' END)")
            .bind(&channel).bind(id).bind(status).bind(resources).bind(at).execute(&pool).await.unwrap();
    }
    let user = format!("admin_{unique}");
    sqlx::query("INSERT INTO users(username,username_normalized,password_hash,role) VALUES($1,$1,$2,'admin')")
        .bind(&user).bind(auth::hash_password(&unique).unwrap()).execute(&pool).await.unwrap();
    let session = state.auth().login(&user, &unique).await.unwrap().0;
    let router = build_router(state.clone());
    async fn read(router: &Router, path: &str, token: &str) -> Value {
        let (status, body) = call(router, "GET", path, Some(token), Value::Null).await;
        assert_eq!(status, StatusCode::OK, "{path}: {body}");
        serde_json::from_str::<Value>(&body).unwrap()["data"].clone()
    }
    let detail_path = format!("/api/admin/crawl/channels/{channel}");
    let success_path = format!("{detail_path}/messages?scope=today&status=success");
    let detail = read(&router, &detail_path, &session.token).await;
    assert_eq!(detail["todaySuccessCount"], 5);
    assert_eq!(detail["todayResourceCount"], 1);
    assert_eq!(detail["failedMessageCount"], 2);
    let messages = read(&router, &success_path, &session.token).await;
    assert_eq!(detail["todaySuccessCount"], messages["counts"]["success"]);
    assert_eq!(messages["total"], 5);
    assert_eq!(messages["counts"], json!({"all":6,"success":5,"failed":1}));
    let list = read(
        &router,
        &format!("/api/admin/crawl/channels?q={channel}"),
        &session.token,
    )
    .await;
    assert_eq!(list["items"][0]["todaySuccessCount"], messages["total"]);
    // Simulate successful retry while the resource cache is still warm.
    sqlx::query("UPDATE crawl_message_tasks SET status='empty',error_message=NULL WHERE channel_id=$1 AND message_id=6")
        .bind(&channel).execute(&pool).await.unwrap();
    let detail = read(&router, &detail_path, &session.token).await;
    let messages = read(&router, &success_path, &session.token).await;
    assert_eq!(detail["todaySuccessCount"], 6);
    assert_eq!(detail["todaySuccessCount"], messages["total"]);
    assert_eq!(detail["failedMessageCount"], 1);
    // No rows must render zero even though resources and old failures remain.
    sqlx::query("DELETE FROM crawl_message_tasks WHERE channel_id=$1 AND status<>'failed'")
        .bind(&channel)
        .execute(&pool)
        .await
        .unwrap();
    let detail = read(&router, &detail_path, &session.token).await;
    let messages = read(&router, &success_path, &session.token).await;
    assert_eq!(detail["todaySuccessCount"], 0);
    assert_eq!(messages["total"], 0);
    state.auth().revoke_session(&session).await.unwrap();
    sqlx::query("DELETE FROM crawl_channels WHERE id=$1")
        .bind(&channel)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM managed_resources WHERE id=ANY($1)")
        .bind(vec![visible, disabled])
        .execute(&pool)
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test and PANSOU_TEST_REDIS_URL"]
async fn failed_message_actions_bulk_ignore_and_page_retry() {
    let url = std::env::var("PANSOU_TEST_DATABASE_URL").expect("test database URL");
    assert!(url::Url::parse(&url).unwrap().path().ends_with("_test"));
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .connect(&url)
        .await
        .unwrap();
    db::init_db(&pool).await.unwrap();
    sqlx::query("TRUNCATE crawl_page_failures,crawl_jobs,crawl_message_tasks,crawl_channels,managed_resources CASCADE").execute(&pool).await.unwrap();
    let redis =
        RedisStore::connect(&std::env::var("PANSOU_TEST_REDIS_URL").expect("test Redis URL"))
            .await
            .unwrap();
    let state = Arc::new(AppState::new(pool.clone(), redis));
    let unique = uuid::Uuid::new_v4().simple().to_string();
    let channel = format!("act_{unique}");
    sqlx::query("INSERT INTO crawl_channels(id,name,transform) VALUES($1,'批量测试',$2)")
        .bind(&channel)
        .bind(DSL)
        .execute(&pool)
        .await
        .unwrap();
    for (id, status) in [
        (300i64, "failed"),
        (310, "failed"),
        (500, "failed"),
        (600, "parsed"),
    ] {
        sqlx::query("INSERT INTO crawl_message_tasks(channel_id,message_id,status,error_message) VALUES($1,$2,$3,CASE WHEN $3='failed' THEN 'x' END)")
            .bind(&channel).bind(id).bind(status).execute(&pool).await.unwrap();
    }
    // Page checkpoints have a different unit and may outlive resolved messages.
    sqlx::query("INSERT INTO crawl_page_failures(channel_id,kind,page_number,last_error) VALUES($1,'sync',1,'old page failure')")
        .bind(&channel).execute(&pool).await.unwrap();
    let user = format!("admin_{unique}");
    sqlx::query("INSERT INTO users(username,username_normalized,password_hash,role) VALUES($1,$1,$2,'admin')").bind(&user).bind(auth::hash_password(&unique).unwrap()).execute(&pool).await.unwrap();
    let session = state.auth().login(&user, &unique).await.unwrap().0;
    let router = build_router(state.clone());
    let path = format!("/api/admin/crawl/channels/{channel}/messages/action");

    async fn assert_failure_totals(router: &Router, token: &str, channel: &str, expected: i64) {
        let mut replies = Vec::new();
        for path in [
            "/api/admin/crawl/overview".to_owned(),
            "/api/admin/crawl/channels".to_owned(),
            format!("/api/admin/crawl/channels/{channel}/messages?status=failed"),
            "/api/monitor".to_owned(),
        ] {
            let (status, body) = call(router, "GET", &path, Some(token), Value::Null).await;
            assert_eq!(status, StatusCode::OK, "{path}: {body}");
            replies.push(serde_json::from_str::<Value>(&body).unwrap()["data"].clone());
        }
        assert_eq!(replies[0]["failedMessages"], expected);
        assert_eq!(replies[0]["review"], 1);
        let channel_total: i64 = replies[1]["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["failedMessageCount"].as_i64().unwrap())
            .sum();
        assert_eq!(channel_total, expected);
        assert_eq!(replies[2]["total"], expected);
        assert_eq!(replies[2]["counts"]["failed"], expected);
        assert_eq!(replies[3]["crawl"]["failedMessages"], expected);
    }
    // Warm the resource cache before mutating failures, then check without waiting for TTL.
    assert_failure_totals(&router, &session.token, &channel, 3).await;

    assert_eq!(
        call(
            &router,
            "POST",
            &path,
            None,
            json!({"action":"ignore","ids":[300]})
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    // Retry on a paused channel is refused.
    sqlx::query("UPDATE crawl_channels SET enabled=false WHERE id=$1")
        .bind(&channel)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        call(
            &router,
            "POST",
            &path,
            Some(&session.token),
            json!({"action":"retry","ids":[300]})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    sqlx::query("UPDATE crawl_channels SET enabled=true WHERE id=$1")
        .bind(&channel)
        .execute(&pool)
        .await
        .unwrap();

    // Bulk retry groups 300/310 into one page window and 500 into another.
    let (code, reply) = call(
        &router,
        "POST",
        &path,
        Some(&session.token),
        json!({"action":"retry","ids":[300,310,500]}),
    )
    .await;
    assert_eq!(code, StatusCode::OK, "{reply}");
    let reply: Value = serde_json::from_str(&reply).unwrap();
    assert_eq!(reply["data"]["affected"], 3, "{reply}");
    assert_eq!(reply["data"]["jobs"], 2, "{reply}");
    let jobs = sqlx::query("SELECT cursor_before,stop_at FROM crawl_jobs WHERE channel_id=$1 AND kind='retry' AND status='queued' ORDER BY cursor_before").bind(&channel).fetch_all(&pool).await.unwrap();
    assert_eq!(jobs.len(), 2);
    assert_eq!(
        (
            jobs[0].get::<i64, _>("cursor_before"),
            jobs[0].get::<i64, _>("stop_at")
        ),
        (311, 300)
    );
    assert_eq!(
        (
            jobs[1].get::<i64, _>("cursor_before"),
            jobs[1].get::<i64, _>("stop_at")
        ),
        (501, 500)
    );

    let resource_id = format!("ignore_resource_{unique}");
    sqlx::query("INSERT INTO managed_resources(id,name,source_channel_ids,source_channel_id,source_message_id) VALUES($1,'保留资源',ARRAY[$2::text],$2,300)")
        .bind(&resource_id).bind(&channel).execute(&pool).await.unwrap();
    sqlx::query("UPDATE crawl_message_tasks SET resource_ids=ARRAY[$2::text] WHERE channel_id=$1 AND message_id=300")
        .bind(&channel).bind(&resource_id).execute(&pool).await.unwrap();
    let resource_before: Value =
        sqlx::query_scalar("SELECT to_jsonb(r) FROM managed_resources r WHERE id=$1")
            .bind(&resource_id)
            .fetch_one(&pool)
            .await
            .unwrap();

    // Ignore deletes the failed row without adding a successful record.
    let (code, reply) = call(
        &router,
        "POST",
        &path,
        Some(&session.token),
        json!({"action":"ignore","ids":[300]}),
    )
    .await;
    assert_eq!(code, StatusCode::OK, "{reply}");
    let left: Vec<i64> = sqlx::query_scalar(
        "SELECT message_id FROM crawl_message_tasks WHERE channel_id=$1 ORDER BY message_id",
    )
    .bind(&channel)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(left, vec![310, 500, 600]);
    assert_failure_totals(&router, &session.token, &channel, 2).await;
    let resource_after: Value =
        sqlx::query_scalar("SELECT to_jsonb(r) FROM managed_resources r WHERE id=$1")
            .bind(&resource_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(resource_before, resource_after);
    let counts = sqlx::query("SELECT count(*) message_count,count(*) FILTER(WHERE status<>'failed') success_count,count(*) FILTER(WHERE status='failed') failed_count FROM crawl_message_tasks WHERE channel_id=$1").bind(&channel).fetch_one(&pool).await.unwrap();
    assert_eq!(
        (
            counts.get::<i64, _>("message_count"),
            counts.get::<i64, _>("success_count"),
            counts.get::<i64, _>("failed_count")
        ),
        (3, 1, 2)
    );
    let (code, reply) = call(
        &router,
        "GET",
        &format!("/api/admin/crawl/channels/{channel}/messages?scope=today"),
        Some(&session.token),
        Value::Null,
    )
    .await;
    assert_eq!(code, StatusCode::OK, "{reply}");
    let reply: Value = serde_json::from_str(&reply).unwrap();
    assert_eq!(
        reply["data"]["counts"],
        json!({"all":3,"success":1,"failed":2})
    );
    assert_eq!(
        call(
            &router,
            "POST",
            &path,
            Some(&session.token),
            json!({"action":"ignore","ids":[300]})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    // Retrying a non-failed selection is rejected wholesale.
    assert_eq!(
        call(
            &router,
            "POST",
            &path,
            Some(&session.token),
            json!({"action":"retry","ids":[600]})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    // A successful retry drops the total even while its old page checkpoint remains.
    sqlx::query("UPDATE crawl_message_tasks SET status='empty',error_message=NULL WHERE channel_id=$1 AND message_id=310")
        .bind(&channel).execute(&pool).await.unwrap();
    assert_failure_totals(&router, &session.token, &channel, 1).await;
    // Paused channels are included in the all-channel total too.
    sqlx::query("UPDATE crawl_channels SET enabled=false WHERE id=$1")
        .bind(&channel)
        .execute(&pool)
        .await
        .unwrap();
    assert_failure_totals(&router, &session.token, &channel, 1).await;
    sqlx::query("DELETE FROM crawl_message_tasks WHERE channel_id=$1 AND status='failed'")
        .bind(&channel)
        .execute(&pool)
        .await
        .unwrap();
    assert_failure_totals(&router, &session.token, &channel, 0).await;
    state.auth().revoke_session(&session).await.unwrap();
}

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test and PANSOU_TEST_REDIS_URL"]
async fn deleting_crawl_channel_preserves_resources_and_discards_inflight_page() {
    let url = std::env::var("PANSOU_TEST_DATABASE_URL").unwrap();
    assert!(url::Url::parse(&url).unwrap().path().ends_with("_test"));
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .connect(&url)
        .await
        .unwrap();
    db::init_db(&pool).await.unwrap();
    sqlx::query("UPDATE crawl_channels SET enabled=false")
        .execute(&pool)
        .await
        .unwrap();
    let state = Arc::new(AppState::new(
        pool.clone(),
        RedisStore::connect(&std::env::var("PANSOU_TEST_REDIS_URL").unwrap())
            .await
            .unwrap(),
    ));
    let unique = uuid::Uuid::new_v4().simple().to_string();
    let channel = format!("delete_{unique}");
    let other = format!("keep_{unique}");
    for (id, enabled) in [(&channel, true), (&other, false)] {
        sqlx::query("INSERT INTO crawl_channels(id,name,enabled,transform) VALUES($1,$1,$2,$3)")
            .bind(id)
            .bind(enabled)
            .bind(DSL)
            .execute(&pool)
            .await
            .unwrap();
    }
    let source = crawl::source_for(&pool, &channel).await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    crawl::persist_message(
        &mut tx,
        &channel,
        &message(&channel, 10, "独有资源", "exclusive"),
        &source,
    )
    .await
    .unwrap();
    crawl::persist_message(
        &mut tx,
        &channel,
        &message(&channel, 11, "共享资源", "shared"),
        &source,
    )
    .await
    .unwrap();
    crawl::persist_message(
        &mut tx,
        &other,
        &message(&other, 11, "共享资源", "shared"),
        &source,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let resource_ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM managed_resources WHERE source_channel_ids @> ARRAY[$1]::text[] ORDER BY id",
    )
    .bind(&channel)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(resource_ids.len(), 2);
    let resources_before: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(r)-'source_channel_ids' FROM managed_resources r WHERE id=ANY($1) ORDER BY id",
    )
    .bind(&resource_ids)
    .fetch_all(&pool)
    .await
    .unwrap();
    let links_before: Vec<Value> = sqlx::query_scalar(
        "SELECT resource_links_json(id) FROM managed_resources WHERE id=ANY($1) ORDER BY id",
    )
    .bind(&resource_ids)
    .fetch_all(&pool)
    .await
    .unwrap();
    let job: i64 = sqlx::query_scalar(
        "INSERT INTO crawl_jobs(channel_id,kind) VALUES($1,'sync') RETURNING id",
    )
    .bind(&channel)
    .fetch_one(&pool)
    .await
    .unwrap();
    let failure: i64 = sqlx::query_scalar("INSERT INTO crawl_page_failures(channel_id,job_id,retry_job_id,kind,last_error) VALUES($1,$2,$2,'sync','fixture') RETURNING id").bind(&channel).bind(job).fetch_one(&pool).await.unwrap();
    sqlx::query("UPDATE crawl_jobs SET failure_id=$2 WHERE id=$1")
        .bind(job)
        .bind(failure)
        .execute(&pool)
        .await
        .unwrap();
    let started = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(
        axum::serve(
            listener,
            Router::new().fallback({
                let started = started.clone();
                let release = release.clone();
                let channel = channel.clone();
                move || {
                    let started = started.clone();
                    let release = release.clone();
                    let channel = channel.clone();
                    async move {
                        started.notify_one();
                        release.notified().await;
                        message(&channel, 12, "不应写入的晚到消息", "late").html
                    }
                }
            }),
        )
        .into_future(),
    );
    let node = format!("node_{unique}");
    sqlx::query("INSERT INTO proxy_nodes(id,name,base_url) VALUES($1,$1,$2)")
        .bind(&node)
        .bind(format!("http://{address}"))
        .execute(&pool)
        .await
        .unwrap();
    let policy: i64 =
        sqlx::query_scalar("INSERT INTO outbound_policies(channel_id) VALUES($1) RETURNING id")
            .bind(&channel)
            .fetch_one(&pool)
            .await
            .unwrap();
    sqlx::query("INSERT INTO outbound_policy_nodes(policy_id,node_id,weight) VALUES($1,$2,10)")
        .bind(policy)
        .bind(&node)
        .execute(&pool)
        .await
        .unwrap();
    let username = format!("delete_admin_{unique}");
    sqlx::query("INSERT INTO users(username,username_normalized,password_hash,role) VALUES($1,$1,$2,'admin')").bind(&username).bind(auth::hash_password(&unique).unwrap()).execute(&pool).await.unwrap();
    let session = state.auth().login(&username, &unique).await.unwrap().0;
    let router = build_router(state.clone());
    let path = format!("/api/admin/crawl/channels/{channel}");
    assert_eq!(
        call(&router, "DELETE", &path, None, json!({})).await.0,
        StatusCode::UNAUTHORIZED
    );
    let worker = tokio::spawn({
        let state = state.clone();
        async move { crawl::tick(&state).await }
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), started.notified())
        .await
        .unwrap();
    let (status, body) = call(&router, "DELETE", &path, Some(&session.token), json!({})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    release.notify_one();
    tokio::time::timeout(std::time::Duration::from_secs(5), worker)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    for table in [
        "crawl_channels",
        "crawl_jobs",
        "crawl_page_failures",
        "crawl_message_tasks",
        "outbound_policies",
    ] {
        let key = if table == "crawl_channels" {
            "id"
        } else {
            "channel_id"
        };
        let count: i64 =
            sqlx::query_scalar(&format!("SELECT count(*) FROM {table} WHERE {key}=$1"))
                .bind(&channel)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 0, "{table}");
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM crawl_message_tasks WHERE channel_id=$1"
        )
        .bind(&other)
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, Value>(
            "SELECT to_jsonb(r)-'source_channel_ids' FROM managed_resources r WHERE id=ANY($1) ORDER BY id"
        )
        .bind(&resource_ids)
        .fetch_all(&pool)
        .await
        .unwrap(),
        resources_before
    );
    assert_eq!(
        sqlx::query_scalar::<_, Value>(
            "SELECT resource_links_json(id) FROM managed_resources WHERE id=ANY($1) ORDER BY id"
        )
        .bind(&resource_ids)
        .fetch_all(&pool)
        .await
        .unwrap(),
        links_before
    );
    assert_eq!(
        call(&router, "DELETE", &path, Some(&session.token), json!({}))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    state.auth().revoke_session(&session).await.unwrap();
    server.abort();
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test"]
async fn cron_defers_daily_pages_but_full_history_and_notifications_work() {
    use chrono::Timelike;
    let url = std::env::var("PANSOU_TEST_DATABASE_URL").unwrap();
    assert!(url::Url::parse(&url).unwrap().path().ends_with("_test"));
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .connect(&url)
        .await
        .unwrap();
    db::init_db(&pool).await.unwrap();
    sqlx::query("UPDATE crawl_channels SET enabled=false")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE crawl_jobs SET status='cancelled',lease_id=NULL,lease_until=NULL WHERE status IN ('queued','running','paused')").execute(&pool).await.unwrap();
    let observed: chrono::DateTime<Utc> = sqlx::query_scalar("SELECT now()")
        .fetch_one(&pool)
        .await
        .unwrap();
    let shanghai_hour = (observed.hour() + 8) % 24;
    let closed_cron = format!("0 */10 {} * * *", (shanghai_hour + 2) % 24);
    sqlx::query("UPDATE crawl_settings SET concurrent_channels=1,page_delay_seconds=0,daily_cron=$1,version=version+1")
        .bind(&closed_cron).execute(&pool).await.unwrap();
    let channel = format!("cron_{}", &uuid::Uuid::new_v4().simple().to_string()[..10]);
    let requests = Arc::new(AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(
        axum::serve(
            listener,
            Router::new().fallback(mock_page).with_state(Mock {
                channel: channel.clone(),
                requests: requests.clone(),
            }),
        )
        .into_future(),
    );
    sqlx::query("INSERT INTO crawl_channels(id,name,enabled,transform) VALUES($1,$1,false,$2)")
        .bind(&channel)
        .bind(DSL)
        .execute(&pool)
        .await
        .unwrap();
    let node = format!("node_{channel}");
    sqlx::query("INSERT INTO proxy_nodes(id,name,base_url) VALUES($1,$1,$2)")
        .bind(&node)
        .bind(format!("http://{addr}"))
        .execute(&pool)
        .await
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    crate::outbound::save(
        &mut tx,
        crate::outbound::Owner::Channel(&channel),
        &crate::outbound::Policy {
            nodes: vec![crate::outbound::NodeWeight {
                node_id: node,
                weight: 10,
            }],
            ..crate::outbound::Policy::direct()
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let redis_url = std::env::var("PANSOU_TEST_REDIS_URL").unwrap();
    assert!(!matches!(
        url::Url::parse(&redis_url).unwrap().path(),
        "" | "/" | "/0"
    ));
    let state = Arc::new(AppState::new(
        pool.clone(),
        RedisStore::connect(&redis_url).await.unwrap(),
    ));
    let worker_state = state.clone();
    let worker = tokio::spawn(async move { crawl::worker(worker_state).await });
    // With every channel disabled, the worker has no deadline before its 60s
    // safety scan. A committed channel update must wake it immediately.
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    sqlx::query("UPDATE crawl_channels SET enabled=true WHERE id=$1")
        .bind(&channel)
        .execute(&pool)
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if sqlx::query_scalar::<_, bool>(
                "SELECT history_complete FROM crawl_channels WHERE id=$1",
            )
            .bind(&channel)
            .fetch_one(&pool)
            .await
            .unwrap()
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("notification did not wake initial full collection outside cron hours");
    assert_eq!(
        requests.load(Ordering::SeqCst),
        3,
        "initial head and history both run outside daily cron"
    );
    state.shutdown.cancel();
    tokio::time::timeout(std::time::Duration::from_secs(3), worker)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let checkpoint: i64 =
        sqlx::query_scalar("SELECT newest_message FROM crawl_channels WHERE id=$1")
            .bind(&channel)
            .fetch_one(&pool)
            .await
            .unwrap();
    let job = crawl::enqueue(&pool, &channel, "sync").await.unwrap();
    sqlx::query("UPDATE crawl_jobs SET cursor_before=100,head_message=101,pages=1 WHERE id=$1")
        .bind(job)
        .execute(&pool)
        .await
        .unwrap();
    crawl::tick(&state).await.unwrap();
    assert_eq!(
        requests.load(Ordering::SeqCst),
        3,
        "daily pages cannot run outside cron hours"
    );
    let deferred = sqlx::query("SELECT status,next_run_at>now() deferred,cursor_before,attempts FROM crawl_jobs WHERE id=$1")
        .bind(job).fetch_one(&pool).await.unwrap();
    assert_eq!(deferred.get::<String, _>("status"), "queued");
    assert!(deferred.get::<bool, _>("deferred"));
    assert_eq!(deferred.get::<i32, _>("attempts"), 0);
    assert_eq!(deferred.get::<Option<i64>, _>("cursor_before"), Some(100));
    assert_eq!(
        checkpoint,
        sqlx::query_scalar::<_, i64>("SELECT newest_message FROM crawl_channels WHERE id=$1")
            .bind(&channel)
            .fetch_one(&pool)
            .await
            .unwrap()
    );
    let task = sqlx::query(include_str!("sql/channel_task_states.sql"))
        .bind(vec![channel.clone()])
        .bind(false)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(task.get::<String, _>("task_state"), "idle");
    assert_eq!(task.get::<String, _>("task_phase"), "cron_wait");
    // Invalid cron cannot alter the stored version or existing checkpoints.
    let username = format!("admin_{channel}");
    sqlx::query("INSERT INTO users(username,username_normalized,password_hash,role) VALUES($1,$1,$2,'admin')")
        .bind(&username).bind(auth::hash_password(&channel).unwrap()).execute(&pool).await.unwrap();
    let session = state.auth().login(&username, &channel).await.unwrap().0;
    let router = build_router(state.clone());
    let stored = crawl::settings(&pool).await.unwrap();
    let jobs_before: i64 = sqlx::query_scalar("SELECT count(*) FROM crawl_jobs")
        .fetch_one(&pool)
        .await
        .unwrap();
    let preview_request = json!({"dailyCron":"  30 */10 8-21 * * *  "});
    assert_eq!(
        call(
            &router,
            "POST",
            "/api/admin/crawl/settings/preview",
            None,
            preview_request.clone()
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let (status, data) = call(
        &router,
        "POST",
        "/api/admin/crawl/settings/preview",
        Some(&session.token),
        preview_request,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{data}");
    let data = serde_json::from_str::<Value>(&data).unwrap()["data"].clone();
    assert_eq!(data["dailyCron"], "30 */10 8-21 * * *");
    assert_eq!(data["timeZone"], "Asia/Shanghai");
    let mut previous = data["observedAt"]
        .as_str()
        .unwrap()
        .parse::<chrono::DateTime<Utc>>()
        .unwrap();
    let times = data["nextRuns"].as_array().unwrap();
    assert_eq!(times.len(), 5);
    for time in times {
        let time = time
            .as_str()
            .unwrap()
            .parse::<chrono::DateTime<Utc>>()
            .unwrap();
        assert!(time > previous);
        assert_eq!(time.second(), 30);
        assert_eq!(time.minute() % 10, 0);
        assert!((8..=21).contains(&((time.hour() + 8) % 24)));
        previous = time;
    }
    for expression in ["0 0 8 30 2 *", "*/10 8-21 * * *", "invalid"] {
        assert_eq!(
            call(
                &router,
                "POST",
                "/api/admin/crawl/settings/preview",
                Some(&session.token),
                json!({"dailyCron":expression})
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        crawl::settings(&pool).await.unwrap().version,
        stored.version
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM crawl_jobs")
            .fetch_one(&pool)
            .await
            .unwrap(),
        jobs_before
    );
    let mut cfg = serde_json::to_value(&stored).unwrap();
    cfg["dailyCron"] = json!("0 0 8 30 2 *");
    assert_eq!(
        call(
            &router,
            "PUT",
            "/api/admin/crawl/settings",
            Some(&session.token),
            cfg.clone()
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        crawl::settings(&pool).await.unwrap().version,
        stored.version
    );
    // Returning to all-day cron resumes the same persisted incremental job.
    cfg["dailyCron"] = json!("0 */10 * * * *");
    assert_eq!(
        call(
            &router,
            "PUT",
            "/api/admin/crawl/settings",
            Some(&session.token),
            cfg
        )
        .await
        .0,
        StatusCode::OK
    );
    crawl::tick(&state).await.unwrap();
    let row = sqlx::query("SELECT status FROM crawl_jobs WHERE id=$1")
        .bind(job)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(row.get::<String, _>("status"), "completed");
    assert_eq!(requests.load(Ordering::SeqCst), 4);
    let next: chrono::DateTime<Utc> =
        sqlx::query_scalar("SELECT next_sync_at FROM crawl_channels WHERE id=$1")
            .bind(&channel)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(next.minute() % 10, 0);
    assert_eq!(next.second(), 0);
    sqlx::query("UPDATE crawl_settings SET daily_cron='0 */10 * * * *',page_delay_seconds=0")
        .execute(&pool)
        .await
        .unwrap();
    server.abort();
}

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test"]
async fn canonical_resources_keep_latest_content_and_channel_membership_without_message_versions() {
    let url = std::env::var("PANSOU_TEST_DATABASE_URL").unwrap();
    assert!(url::Url::parse(&url).unwrap().path().ends_with("_test"));
    let pool = crate::db::connect(&url).await.unwrap();
    db::init_db(&pool).await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    let prefix = uuid::Uuid::new_v4().simple().to_string();
    let a = format!("a_{prefix}");
    let b = format!("b_{prefix}");
    for channel in [&a, &b] {
        sqlx::query("INSERT INTO crawl_channels(id,name) VALUES($1,$1)")
            .bind(channel)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    let source = Source {
        id: prefix.clone(),
        name: "Test".into(),
        description: String::new(),
        url: String::new(),
        method: "GET".into(),
        format: "html".into(),
        priority: 0,
        enabled: true,
        request: None,
        transform: DSL.into(),
    };
    let mut newest = message(&a, 1, "最新标题", &prefix);
    newest.published = Some(Utc::now());
    crawl::persist_message(&mut tx, &a, &newest, &source)
        .await
        .unwrap();
    let id: String = sqlx::query_scalar(
        "SELECT id FROM managed_resources WHERE source_channel_ids @> ARRAY[$1]::text[]",
    )
    .bind(&a)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    let mut older = message(&b, 2, "较老频道标题", &prefix);
    older.published = Some(newest.published.unwrap() - chrono::Duration::days(10));
    crawl::persist_message(&mut tx, &b, &older, &source)
        .await
        .unwrap();
    let row = sqlx::query("SELECT name,source_channel_ids FROM managed_resources WHERE id=$1")
        .bind(&id)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(row.get::<String, _>("name"), "最新标题");
    assert_eq!(
        row.get::<Vec<String>, _>("source_channel_ids"),
        vec![a.clone(), b.clone()]
    );
    sqlx::query("UPDATE managed_resources SET name='人工标题' WHERE id=$1")
        .bind(&id)
        .execute(&mut *tx)
        .await
        .unwrap();
    let mut newer = message(&b, 3, "新采集标题", &prefix);
    newer.published = Some(newest.published.unwrap() + chrono::Duration::days(1));
    crawl::persist_message(&mut tx, &b, &newer, &source)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT name FROM managed_resources WHERE id=$1")
            .bind(&id)
            .fetch_one(&mut *tx)
            .await
            .unwrap(),
        "新采集标题"
    );
    let changed = message(&a, 1, "新链接独立资源", &format!("new_{prefix}"));
    crawl::persist_message(&mut tx, &a, &changed, &source)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM managed_resources WHERE source_channel_ids @> ARRAY[$1]::text[]"
        )
        .bind(&a)
        .fetch_one(&mut *tx)
        .await
        .unwrap(),
        2
    );
    sqlx::query("DELETE FROM managed_resources WHERE id=$1")
        .bind(&id)
        .execute(&mut *tx)
        .await
        .unwrap();
    crawl::persist_message(&mut tx, &a, &newest, &source)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM managed_resources WHERE source_channel_ids @> ARRAY[$1]::text[]"
        )
        .bind(&a)
        .fetch_one(&mut *tx)
        .await
        .unwrap(),
        2,
        "a deleted link can be collected again"
    );
    sqlx::query("DELETE FROM crawl_message_tasks WHERE channel_id=ANY($1)")
        .bind(vec![a.clone(), b.clone()])
        .execute(&mut *tx)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM managed_resources WHERE source_channel_ids @> ARRAY[$1]::text[]"
        )
        .bind(&a)
        .fetch_one(&mut *tx)
        .await
        .unwrap(),
        2
    );
    tx.rollback().await.unwrap();
}

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test and PANSOU_TEST_REDIS_URL"]
async fn failed_message_content_is_durable_and_admin_only() {
    let url = std::env::var("PANSOU_TEST_DATABASE_URL").unwrap();
    assert!(url::Url::parse(&url).unwrap().path().ends_with("_test"));
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .connect(&url)
        .await
        .unwrap();
    db::init_db(&pool).await.unwrap();
    let state = Arc::new(AppState::new(
        pool.clone(),
        RedisStore::connect(&std::env::var("PANSOU_TEST_REDIS_URL").unwrap())
            .await
            .unwrap(),
    ));
    let unique = uuid::Uuid::new_v4().simple().to_string();
    let channel = format!("failure_{unique}");
    sqlx::query("INSERT INTO crawl_channels(id,name,enabled,transform) VALUES($1,$1,false,$2)")
        .bind(&channel)
        .bind(DSL)
        .execute(&pool)
        .await
        .unwrap();
    let source = crawl::source_for(&pool, &channel).await.unwrap();
    let links = (0..13)
        .map(|i| format!("<a href=\"https://pan.quark.cn/s/{unique}{i}\">网盘{i}</a><br>"))
        .collect::<String>();
    let html = format!(
        r#"<div class="tgme_widget_message" data-post="{channel}/77"><div class="tgme_widget_message_text">资源合集 &amp; 原文<br>提取码：abcd<br>{links}<script>alert('unsafe')</script></div><time datetime="2026-10-06T01:02:03Z"></time></div>"#
    );
    let published = chrono::DateTime::parse_from_rfc3339("2026-10-06T01:02:03Z")
        .unwrap()
        .with_timezone(&Utc);
    for _ in 0..2 {
        assert_eq!(
            ingest(
                &state,
                &channel,
                &source,
                telegram::Message {
                    id: 77,
                    html: html.clone(),
                    published: Some(published),
                }
            )
            .await,
            (0, true)
        );
    }
    let captured = telegram::messages(&html, &channel).unwrap().remove(0).html;
    let row = sqlx::query("SELECT raw_html,published_at,error_message FROM crawl_message_tasks WHERE channel_id=$1 AND message_id=77")
        .bind(&channel).fetch_one(&pool).await.unwrap();
    assert_eq!(row.get::<String, _>("raw_html"), captured);
    assert_eq!(
        row.get::<chrono::DateTime<Utc>, _>("published_at"),
        published
    );
    assert_eq!(
        row.get::<String, _>("error_message"),
        "聚合消息缺少明确资源边界，需要调整规则"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM crawl_message_tasks WHERE channel_id=$1"
        )
        .bind(&channel)
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
    // Unhandled errors survive the ordinary daily task cleanup.
    sqlx::query(
        "UPDATE crawl_message_tasks SET task_at=now()-interval '3 days' WHERE channel_id=$1",
    )
    .bind(&channel)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("SELECT prune_crawl_tasks($1)")
        .bind(&channel)
        .execute(&pool)
        .await
        .unwrap();
    let username = format!("failure_admin_{unique}");
    sqlx::query("INSERT INTO users(username,username_normalized,password_hash,role) VALUES($1,$1,$2,'admin')")
        .bind(&username).bind(auth::hash_password(&unique).unwrap()).execute(&pool).await.unwrap();
    let session = state.auth().login(&username, &unique).await.unwrap().0;
    let router = build_router(state.clone());
    let path = format!("/api/admin/crawl/channels/{channel}/messages/77");
    assert_eq!(
        call(&router, "GET", &path, None, Value::Null).await.0,
        StatusCode::UNAUTHORIZED
    );
    let (status, body) = call(&router, "GET", &path, Some(&session.token), Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let detail = serde_json::from_str::<Value>(&body).unwrap()["data"].clone();
    assert_eq!(detail["rawHtml"], captured);
    assert_eq!(detail["publishedAt"], "2026-10-06T01:02:03Z");
    assert_eq!(detail["messageUrl"], format!("https://t.me/{channel}/77"));
    let text = detail["rawText"].as_str().unwrap();
    assert!(text.starts_with("资源合集 & 原文\n提取码：abcd\n"));
    assert!(text.contains(&format!("https://pan.quark.cn/s/{unique}12")));
    assert!(!text.contains("alert('unsafe')"));
    assert_eq!(
        call(
            &router,
            "GET",
            "/api/admin/crawl/channels/missing/messages/77",
            Some(&session.token),
            Value::Null
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    sqlx::query("INSERT INTO crawl_message_tasks(channel_id,message_id,status,error_message) VALUES($1,78,'failed','legacy error')")
        .bind(&channel).execute(&pool).await.unwrap();
    let (_, body) = call(
        &router,
        "GET",
        &format!("/api/admin/crawl/channels/{channel}/messages/78"),
        Some(&session.token),
        Value::Null,
    )
    .await;
    let legacy = serde_json::from_str::<Value>(&body).unwrap()["data"].clone();
    assert!(legacy["rawHtml"].is_null());
    assert!(legacy["rawText"].is_null());
    assert_eq!(legacy["errorMessage"], "legacy error");
    // Actual transform errors use the same durable capture path.
    let mut invalid_source = source.clone();
    invalid_source.transform = "{".into();
    assert_eq!(
        ingest(
            &state,
            &channel,
            &invalid_source,
            message(&channel, 79, "规则出错", "invalid")
        )
        .await,
        (0, true)
    );
    assert!(sqlx::query_scalar::<_,bool>("SELECT raw_html IS NOT NULL AND error_message IS NOT NULL FROM crawl_message_tasks WHERE channel_id=$1 AND message_id=79")
        .bind(&channel).fetch_one(&pool).await.unwrap());
    // Retry submission retains the snapshot until the message is processed again.
    sqlx::query("UPDATE crawl_channels SET enabled=true WHERE id=$1")
        .bind(&channel)
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = call(
        &router,
        "POST",
        &format!("/api/admin/crawl/channels/{channel}/messages/action"),
        Some(&session.token),
        json!({"action":"retry","ids":[77]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT raw_html FROM crawl_message_tasks WHERE channel_id=$1 AND message_id=77"
        )
        .bind(&channel)
        .fetch_one(&pool)
        .await
        .unwrap(),
        captured
    );
    assert_eq!(
        ingest(
            &state,
            &channel,
            &source,
            message(&channel, 77, "重试成功", "recovered")
        )
        .await,
        (1, false)
    );
    let row = sqlx::query("SELECT status,error_message,raw_html FROM crawl_message_tasks WHERE channel_id=$1 AND message_id=77")
        .bind(&channel).fetch_one(&pool).await.unwrap();
    assert_eq!(row.get::<String, _>("status"), "parsed");
    assert!(row.get::<Option<String>, _>("error_message").is_none());
    assert!(row.get::<Option<String>, _>("raw_html").is_none());
    state.auth().revoke_session(&session).await.unwrap();
}

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test and PANSOU_TEST_REDIS_URL"]
async fn hot_search_admin_respects_shortlist_capacity() {
    let url = std::env::var("PANSOU_TEST_DATABASE_URL").unwrap();
    assert!(url::Url::parse(&url).unwrap().path().ends_with("_test"));
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .connect(&url)
        .await
        .unwrap();
    db::init_db(&pool).await.unwrap();
    sqlx::query("TRUNCATE hot_searches")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO hot_searches(term,source,status) SELECT 'manual-'||i,'manual',CASE WHEN i=1 THEN 'blocked' ELSE 'approved' END FROM generate_series(1,30) i")
        .execute(&pool).await.unwrap();
    let logs_before = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM search_logs")
        .fetch_one(&pool)
        .await
        .unwrap();
    let state = Arc::new(AppState::new(
        pool.clone(),
        RedisStore::connect(&std::env::var("PANSOU_TEST_REDIS_URL").unwrap())
            .await
            .unwrap(),
    ));
    let unique = uuid::Uuid::new_v4().simple().to_string();
    let username = format!("shortlist_admin_{unique}");
    sqlx::query("INSERT INTO users(username,username_normalized,password_hash,role) VALUES($1,$1,$2,'admin')")
        .bind(&username).bind(auth::hash_password(&unique).unwrap()).execute(&pool).await.unwrap();
    let session = state.auth().login(&username, &unique).await.unwrap().0;
    let router = build_router(state.clone());
    let token = Some(session.token.as_str());
    let (status, body) = call(
        &router,
        "GET",
        "/api/admin/hot-searches?pageSize=100",
        token,
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["data"]["total"],
        30
    );
    let (_, body) = call(
        &router,
        "GET",
        "/api/hot-searches?limit=100",
        None,
        Value::Null,
    )
    .await;
    let terms = serde_json::from_str::<Value>(&body).unwrap();
    assert_eq!(terms["data"]["hotSearches"].as_array().unwrap().len(), 29);
    let (status, body) = call(
        &router,
        "POST",
        "/api/admin/hot-searches",
        token,
        json!({"term":"extra","source":"manual"}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    // Existing curated entries remain editable at capacity.
    assert_eq!(
        call(
            &router,
            "POST",
            "/api/admin/hot-searches",
            token,
            json!({"term":"manual-2","score":10,"source":"manual"})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &router,
            "DELETE",
            "/api/admin/hot-searches/manual-30",
            token,
            Value::Null
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &router,
            "POST",
            "/api/admin/hot-searches",
            token,
            json!({"term":"extra","source":"manual"})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM hot_searches")
            .fetch_one(&pool)
            .await
            .unwrap(),
        30
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM search_logs")
            .fetch_one(&pool)
            .await
            .unwrap(),
        logs_before
    );
    state.auth().revoke_session(&session).await.unwrap();
}

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test and PANSOU_TEST_REDIS_URL"]
async fn search_pages_bound_payload_and_preserve_order_scope_and_logs() {
    use redis::AsyncCommands;
    let url = std::env::var("PANSOU_TEST_DATABASE_URL").unwrap();
    assert!(url::Url::parse(&url).unwrap().path().ends_with("_test"));
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .connect(&url)
        .await
        .unwrap();
    db::init_db(&pool).await.unwrap();
    sqlx::query("UPDATE resource_sources SET enabled=false")
        .execute(&pool)
        .await
        .unwrap();
    let state = Arc::new(AppState::new(
        pool.clone(),
        RedisStore::connect(&std::env::var("PANSOU_TEST_REDIS_URL").unwrap())
            .await
            .unwrap(),
    ));
    let unique = uuid::Uuid::new_v4().simple().to_string();
    let keyword = format!("分页{unique}");
    let channel = format!("page_{unique}");
    sqlx::query("INSERT INTO crawl_channels(id,name,enabled,transform) VALUES($1,$1,false,$2)")
        .bind(&channel)
        .bind(DSL)
        .execute(&pool)
        .await
        .unwrap();
    let description = "中文😀简介".repeat(30);
    sqlx::query("INSERT INTO managed_resources(id,name,description,origin,source_channel_ids,published_at) SELECT $1||'-'||lpad(i::text,3,'0'),CASE WHEN i<=140 THEN $2 ELSE $2||i END,$3,'telegram',ARRAY[$1::text],CASE WHEN i%3=0 THEN NULL ELSE '2026-10-01'::timestamptz+(i%2)*interval '1 day' END FROM generate_series(1,273) i")
        .bind(&channel).bind(&keyword).bind(&description).execute(&pool).await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    for i in 1..=273 {
        let id = format!("{channel}-{i:03}");
        crate::resource_links::replace(
            &mut tx,
            &id,
            &[crate::models::Link {
                r#type: if i <= 140 { "mobile" } else { "quark" }.into(),
                url: if i <= 140 {
                    format!("https://yun.139.com/shareweb/#/w/i/{id}")
                } else {
                    format!("https://pan.quark.cn/s/{id}")
                },
                password: Some("secret".into()),
            }],
        )
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
    let session = state.auth().issue(true).await.unwrap();
    let other = state.auth().issue(true).await.unwrap();
    let request: crate::models::SearchRequest =
        serde_json::from_value(json!({"kw":keyword})).unwrap();
    let expected = local_index::query(&state, std::slice::from_ref(&channel), &keyword)
        .await
        .unwrap();
    assert_eq!(expected.len(), 200);
    let expected = crate::link_resolution::project(&state, &session, &request, None, &expected)
        .await
        .unwrap()
        .into_iter()
        .map(|r| r["dedupKey"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    let router = build_router(state.clone());
    async fn send(
        router: &Router,
        token: &str,
        body: Value,
        accept: &str,
        gzip: bool,
    ) -> axum::response::Response {
        let mut builder = Request::builder()
            .method("POST")
            .uri("/api/search")
            .header("content-type", "application/json")
            .header("accept", accept)
            .header("authorization", format!("Bearer {token}"));
        if gzip {
            builder = builder.header("accept-encoding", "gzip");
        }
        let mut req = builder.body(Body::from(body.to_string())).unwrap();
        req.extensions_mut().insert(ConnectInfo(
            format!(
                "127.0.{}.{}:41234",
                token.as_bytes()[0],
                token.as_bytes()[1]
            )
            .parse::<SocketAddr>()
            .unwrap(),
        ));
        router.clone().oneshot(req).await.unwrap()
    }
    async fn read(response: axum::response::Response) -> Value {
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], "private, no-store");
        assert!(
            response.headers()["vary"]
                .to_str()
                .unwrap()
                .contains("Accept")
        );
        serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap()).unwrap()
    }
    let first = read(
        send(
            &router,
            &session.token,
            json!({"kw":keyword}),
            "application/json, text/event-stream",
            false,
        )
        .await,
    )
    .await;
    let log_id = first["data"]["searchLogId"].as_i64().unwrap();
    let first_cursor = first["data"]["nextCursor"].as_str().unwrap().to_owned();
    let mut page = first.clone();
    let mut seen = vec![];
    let mut sizes = vec![];
    loop {
        let data = &page["data"];
        assert_eq!(data["pageSize"], 50);
        let rows = data["results"].as_array().unwrap();
        sizes.push(rows.len());
        for row in rows {
            assert_eq!(row["description"].as_str().unwrap().chars().count(), 60);
            assert!(!row.to_string().contains("pan.quark.cn"));
            assert!(!row.to_string().contains("secret"));
            seen.push(row["dedupKey"].as_str().unwrap().to_owned());
        }
        assert_eq!(data["total"], rows.len());
        assert_eq!(data["searchLogId"], log_id);
        if data["hasMore"] == false {
            assert!(data["nextCursor"].is_null());
            break;
        }
        page = read(
            send(
                &router,
                &session.token,
                json!({"kw":keyword,"cursor":data["nextCursor"]}),
                "application/json",
                false,
            )
            .await,
        )
        .await;
    }
    assert_eq!(sizes, vec![50, 50, 50, 50]);
    assert_eq!(
        seen, expected,
        "exact matches, timestamp ties and NULL dates must retain stable ordering without gaps"
    );
    let context = first["data"]["searchContext"].as_str().unwrap();
    for (cloud, count) in [("mobile", 140usize), ("quark", 133usize)] {
        let mut body = json!({"kw":keyword,"cloudType":cloud,"searchContext":context});
        let mut ids = std::collections::HashSet::new();
        let mut cloud_cursor = None;
        loop {
            let filtered = read(
                send(
                    &router,
                    &session.token,
                    body.clone(),
                    "application/json",
                    false,
                )
                .await,
            )
            .await;
            assert_eq!(filtered["data"]["searchLogId"], log_id);
            let rows = filtered["data"]["results"].as_array().unwrap();
            assert!(rows.len() <= 50);
            for r in rows {
                assert!(
                    r["links"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|l| l["type"] == cloud)
                );
                assert!(ids.insert(r["dedupKey"].as_str().unwrap().to_owned()));
            }
            if filtered["data"]["hasMore"] == false {
                break;
            }
            let cursor = filtered["data"]["nextCursor"].as_str().unwrap().to_owned();
            cloud_cursor = Some(cursor.clone());
            body["cursor"] = json!(cursor);
        }
        assert_eq!(ids.len(), count);
        assert_eq!(
            send(
                &router,
                &session.token,
                json!({"kw":keyword,"cursor":cloud_cursor.unwrap()}),
                "application/json",
                false
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        send(
            &router,
            &other.token,
            json!({"kw":keyword,"cloudType":"mobile","searchContext":context}),
            "application/json",
            false
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        send(
            &router,
            &session.token,
            json!({"kw":"另一个关键词","cloudType":"mobile","searchContext":context}),
            "application/json",
            false
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    let no_provider = read(
        send(
            &router,
            &session.token,
            json!({"kw":keyword,"cloudType":"baidu","searchContext":context}),
            "application/json",
            false,
        )
        .await,
    )
    .await;
    assert_eq!(no_provider["data"]["results"], json!([]));
    assert_eq!(no_provider["data"]["hasMore"], false);
    let retry = read(
        send(
            &router,
            &session.token,
            json!({"kw":keyword,"cursor":first_cursor}),
            "application/json",
            false,
        )
        .await,
    )
    .await;
    assert_eq!(retry["data"]["results"].as_array().unwrap().len(), 50);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM search_logs WHERE keyword=$1")
            .bind(&keyword)
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i32>("SELECT result_count FROM search_logs WHERE id=$1")
            .bind(log_id)
            .fetch_one(&pool)
            .await
            .unwrap(),
        200
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT score FROM hot_searches WHERE term=$1")
            .bind(&keyword)
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(sqlx::query_scalar::<_,String>("SELECT description FROM managed_resources WHERE source_channel_ids @> ARRAY[$1::text] LIMIT 1").bind(&channel).fetch_one(&pool).await.unwrap(),description);
    for (token, kw) in [
        (&other.token, keyword.clone()),
        (&session.token, "另一个关键词".into()),
    ] {
        assert_eq!(
            send(
                &router,
                token,
                json!({"kw":kw,"cursor":first_cursor}),
                "application/json",
                false
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
    }
    // Compress JSON in the app even without a reverse proxy; leave SSE uncompressed.
    let extra_session = state.auth().issue(true).await.unwrap();
    let compressed = send(
        &router,
        &extra_session.token,
        json!({"kw":keyword}),
        "application/json",
        true,
    )
    .await;
    assert_eq!(compressed.status(), StatusCode::OK);
    assert_eq!(compressed.headers()["content-encoding"], "gzip");
    let compressed = to_bytes(compressed.into_body(), 1024 * 1024).await.unwrap();
    assert_eq!(&compressed[..2], &[0x1f, 0x8b]);
    assert!(compressed.len() < first.to_string().len());
    let sse = send(
        &router,
        &extra_session.token,
        json!({"kw":keyword}),
        "text/event-stream",
        true,
    )
    .await;
    assert!(!sse.headers().contains_key("content-encoding"));
    assert_eq!(sse.headers()["x-accel-buffering"], "no");
    use futures::StreamExt;
    let mut chunks = sse.into_body().into_data_stream();
    let mut batches = Vec::new();
    let mut previous_batch = None;
    let mut events = Vec::new();
    while let Some(chunk) = chunks.next().await {
        let text = String::from_utf8(chunk.unwrap().to_vec()).unwrap();
        let event = text
            .lines()
            .find_map(|line| line.strip_prefix("data: "))
            .unwrap();
        let event: Value = serde_json::from_str(event).unwrap();
        if let Some(rows) = event["results"].as_array() {
            if let Some(previous) = previous_batch {
                assert!(
                    tokio::time::Instant::now().duration_since(previous)
                        >= std::time::Duration::from_millis(490)
                );
            }
            previous_batch = Some(tokio::time::Instant::now());
            batches.push(rows.len());
            for row in rows {
                assert!(row.as_object().unwrap().keys().all(|k| {
                    [
                        "name",
                        "description",
                        "datetime",
                        "dedupKey",
                        "resultRef",
                        "links",
                    ]
                    .contains(&k.as_str())
                }));
                assert!(row["links"].as_array().unwrap().iter().all(|l| {
                    l.as_object()
                        .unwrap()
                        .keys()
                        .all(|k| ["type", "linkRef"].contains(&k.as_str()))
                }));
            }
        }
        events.push(event);
    }
    assert_eq!(batches, vec![50, 50, 50, 50]);
    assert_eq!(events.last().unwrap()["total"], 200);
    // Dropping the stream stops paging and releases the search concurrency slot.
    let canceled = send(
        &router,
        &extra_session.token,
        json!({"kw":keyword}),
        "text/event-stream",
        false,
    )
    .await;
    let mut chunks = canceled.into_body().into_data_stream();
    let start = String::from_utf8(chunks.next().await.unwrap().unwrap().to_vec()).unwrap();
    let start: Value = serde_json::from_str(
        start
            .lines()
            .find_map(|l| l.strip_prefix("data: "))
            .unwrap(),
    )
    .unwrap();
    let canceled_log = start["searchLogId"].as_i64().unwrap();
    chunks.next().await.unwrap().unwrap();
    drop(chunks);
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
    assert_eq!(
        sqlx::query_scalar::<_, i32>("SELECT result_count FROM search_logs WHERE id=$1")
            .bind(canceled_log)
            .fetch_one(&pool)
            .await
            .unwrap(),
        50
    );
    let _: () = state
        .redis
        .connection()
        .unwrap()
        .del(format!("pansou:search-page:v1:{first_cursor}"))
        .await
        .unwrap();
    assert_eq!(
        send(
            &router,
            &session.token,
            json!({"kw":keyword,"cursor":first_cursor}),
            "application/json",
            false
        )
        .await
        .status(),
        StatusCode::GONE
    );
    let empty = read(
        send(
            &router,
            &extra_session.token,
            json!({"kw":format!("不存在{unique}")}),
            "application/json",
            false,
        )
        .await,
    )
    .await;
    assert_eq!(empty["data"]["results"], json!([]));
    assert_eq!(empty["data"]["hasMore"], false);
    // A configured live source still streams, but cannot exceed the public 200-row budget.
    let items = (0..240).map(|i| json!({"title":format!("实时资源{i}"),"description":"实时😀简介".repeat(30),"url":format!("https://pan.quark.cn/s/live-{unique}-{i}")})).collect::<Vec<_>>();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let mock = tokio::spawn(
        axum::serve(
            listener,
            Router::new().route(
                "/",
                axum::routing::get(move || {
                    let items = items.clone();
                    async move { axum::Json(json!({"items":items})) }
                }),
            ),
        )
        .into_future(),
    );
    let live_id = format!("livepage_{unique}");
    sqlx::query("INSERT INTO resource_sources(id,name,url,method,format,transform) VALUES($1,$1,$2,'GET','json',$3)")
        .bind(&live_id).bind(format!("http://{addr}/")).bind(r#"{"kind":"json","items":"$.items[*]","fields":{"name":"title","description":"description","url":"url"}}"#).execute(&pool).await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    crate::outbound::save(
        &mut tx,
        crate::outbound::Owner::Source(&live_id),
        &crate::outbound::Policy::direct(),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let live = send(
        &router,
        &extra_session.token,
        json!({"kw":format!("只搜上游{unique}"),"source_ids":[live_id]}),
        "application/json, text/event-stream",
        true,
    )
    .await;
    assert_eq!(live.status(), StatusCode::OK);
    assert!(!live.headers().contains_key("content-encoding"));
    assert!(
        live.headers()["content-type"]
            .to_str()
            .unwrap()
            .contains("text/event-stream")
    );
    let live = String::from_utf8(
        to_bytes(live.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    let events = live
        .lines()
        .filter_map(|l| l.strip_prefix("data: "))
        .map(|l| serde_json::from_str::<Value>(l).unwrap())
        .collect::<Vec<_>>();
    let rows = events
        .iter()
        .filter_map(|e| e["results"].as_array())
        .flatten()
        .collect::<Vec<_>>();
    assert_eq!(rows.len(), 200, "{live}");
    assert!(
        rows.iter()
            .all(|r| r["description"].as_str().unwrap().chars().count() == 60)
    );
    assert_eq!(events.last().unwrap()["total"], 200);
    mock.abort();
    sqlx::query("UPDATE resource_sources SET enabled=false WHERE id=$1")
        .bind(&live_id)
        .execute(&pool)
        .await
        .unwrap();
    state.auth().revoke_session(&extra_session).await.unwrap();
    state.auth().revoke_session(&session).await.unwrap();
    state.auth().revoke_session(&other).await.unwrap();
}
