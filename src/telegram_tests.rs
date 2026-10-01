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
    sqlx::query("TRUNCATE crawl_page_failures,crawl_jobs,resource_occurrences,source_messages,crawl_channels,managed_resources CASCADE").execute(&pool).await.unwrap();
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
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM source_messages WHERE channel_id=$1")
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
    assert!(
        !sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM source_messages WHERE channel_id=$1 AND message_id=999)"
        )
        .bind(&channel)
        .fetch_one(&pool)
        .await
        .unwrap()
    );
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
    assert_eq!(ingest(&state, &channel, &source, same).await, (0, false));
    let occurrence_xmin: String = sqlx::query_scalar("SELECT xmin::text FROM resource_occurrences WHERE channel_id=$1 AND message_id=101")
        .bind(&channel).fetch_one(&pool).await.unwrap();
    let revision: i64 = sqlx::query_scalar("SELECT revision FROM config_revisions WHERE scope='local-index'")
        .fetch_one(&pool).await.unwrap();
    sqlx::query("UPDATE source_messages SET parse_version='force-reparse-test' WHERE channel_id=$1 AND message_id=101")
        .bind(&channel).execute(&pool).await.unwrap();
    let mut unchanged = message(&channel, 101, "兰香如故", "test-a");
    unchanged.published = sqlx::query_scalar("SELECT published_at FROM source_messages WHERE channel_id=$1 AND message_id=101")
        .bind(&channel).fetch_one(&pool).await.unwrap();
    assert_eq!(ingest(&state, &channel, &source, unchanged).await, (1, false));
    assert_eq!(sqlx::query_scalar::<_, String>("SELECT xmin::text FROM resource_occurrences WHERE channel_id=$1 AND message_id=101")
        .bind(&channel).fetch_one(&pool).await.unwrap(), occurrence_xmin);
    assert_eq!(sqlx::query_scalar::<_, i64>("SELECT revision FROM config_revisions WHERE scope='local-index'")
        .fetch_one(&pool).await.unwrap(), revision);
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
    assert_eq!(
        local_index::query(&state, std::slice::from_ref(&channel), "更换")
            .await
            .unwrap()[0]
            .id,
        resource.id
    );
    // Same canonical share, different authorized channel text: never leak private presentation.
    sqlx::query("INSERT INTO crawl_channels(id,enabled) VALUES($1,false)")
        .bind(&private)
        .execute(&pool)
        .await
        .unwrap();
    ingest(
        &state,
        &private,
        &source,
        message(&private, 300, "私有标题不能泄露", "new-share"),
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
        call(&router, "POST", "/api/admin/resources", Some(&session.token),
            json!({"name":"invalid types fixture","cloud_types":{"not":"an array"}})).await.0,
        StatusCode::BAD_REQUEST,
    );
    for path in [
        "/api/admin/crawl/channels",
        "/api/admin/crawl/jobs",
        "/api/search/json?kw=x",
    ] {
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
    sqlx::query("INSERT INTO source_template_settings(id,url_template,method,format,transform) VALUES(1,'https://t.me/s/{{channel}}','GET','html',$1) ON CONFLICT(id) DO UPDATE SET transform=EXCLUDED.transform").bind(DSL).execute(&pool).await.unwrap();
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
    let (status, detail) = call(
        &router,
        "GET",
        &format!("/api/admin/crawl/channels/{channel}/messages/101"),
        Some(&session.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    let detail: Value = serde_json::from_str(&detail).unwrap();
    assert_eq!(detail["data"]["messageId"], 101);
    assert!(!detail["data"]["stored"].as_array().unwrap().is_empty());
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
    for item in std::iter::once(&detail["data"]).chain(messages["data"]["items"].as_array().unwrap()) {
        for removed in ["rawHtml", "rawText", "summary"] {
            assert!(item.get(removed).is_none(), "removed field {removed}: {item}");
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
        message(&channel, 101, "采集不覆盖手动内容", "new-share"),
    )
    .await;
    assert_eq!(
        local_index::query(&state, std::slice::from_ref(&channel), "管理员修订")
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
            "SELECT manual_override AND NOT enabled FROM managed_resources WHERE id=$1"
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
    let (status, cancel) = call(
        &router,
        "POST",
        &format!("/api/admin/crawl/jobs/{job}/cancel"),
        Some(&session.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{cancel}");
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
    // A custom search performs HTTP against submitted channels, does not ingest and uses RAM-only capabilities.
    sqlx::query("INSERT INTO source_template_settings(id,url_template,method,format,transform) VALUES(1,'https://t.me/s/{{channel}}','GET','html',$1) ON CONFLICT(id) DO UPDATE SET transform=EXCLUDED.transform").bind(DSL).execute(&pool).await.unwrap();
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
    // Search projection works with Redis disconnected; DB catalog facts are not required.
    let isolated = AppState::new(pool.clone(), RedisStore::disconnected());
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
