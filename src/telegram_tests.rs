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
use std::{
    net::SocketAddr,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use tower::ServiceExt;

const DSL: &str = r#"{"kind":"html","item_selector":".tgme_widget_message","fields":{"name":".tgme_widget_message_text","description":".tgme_widget_message_text","datetime":"time::datetime","links":".tgme_widget_message_text a::href"}}"#;
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
    sqlx::query(
        "INSERT INTO crawl_channels(id,name,managed,transform) VALUES($1,'测试 TG',true,$2)",
    )
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
    let sync = crawl::enqueue(&pool, &channel, "sync", 20).await.unwrap();
    assert!(crawl::enqueue(&pool, &channel, "sync", 20).await.is_err());
    let backfill = crawl::enqueue(&pool, &channel, "backfill", 20)
        .await
        .unwrap();
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
    let limited = crawl::enqueue(&pool, &channel, "review", 5).await.unwrap();
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
    assert_eq!(payload["data"]["results"][0]["id"], resource.id);
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
    assert!(sse.contains("兰香如故更换分享"));
    assert!(!sse.contains("plugin:"));
    assert_eq!(
        network_before,
        requests.load(Ordering::SeqCst),
        "search must not fetch TG"
    );
    // Custom mode uses the server-saved channels, never a request-injected channel.
    sqlx::query("INSERT INTO source_template_settings(id,url_template,method,format,transform) VALUES(1,'https://t.me/s/{{channel}}','GET','html',$1) ON CONFLICT(id) DO UPDATE SET transform=EXCLUDED.transform").bind(DSL).execute(&pool).await.unwrap();
    let (status, saved) = call(
        &router,
        "POST",
        "/api/account/channels",
        Some(&session.token),
        json!({"channels":[format!("@{channel}")]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(
        serde_json::from_str::<Value>(&saved).unwrap()["channels"][0],
        channel
    );
    let (status, custom) = call(
        &router,
        "POST",
        "/api/search",
        Some(&session.token),
        json!({"kw":"兰香","channels":[private]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{custom}");
    assert!(custom.contains("兰香如故更换分享"));
    assert!(!custom.contains("私有标题"));
    assert_eq!(network_before, requests.load(Ordering::SeqCst));
    // Disabling a system source makes it immediately invisible.
    sqlx::query("UPDATE resource_sources SET enabled=false WHERE id=$1")
        .bind(&source_id)
        .execute(&pool)
        .await
        .unwrap();
    let (status, disabled) = call(
        &router,
        "POST",
        "/api/search",
        Some(&session.token),
        json!({"kw":"兰香","source_ids":[source_id]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{disabled}");
    assert!(!disabled.contains("兰香如故更换分享"));
    sqlx::query("UPDATE resource_sources SET enabled=true WHERE id=$1")
        .bind(&source_id)
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
    assert_eq!(records[0]["id"], resource.id);
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
    assert_eq!(mixed["data"]["results"][0]["id"], resource.id);
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
    assert!(first.contains("\"total\":2"));
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
        before_cached,
        requests.load(Ordering::SeqCst),
        "live-only search should use cache"
    );
    assert_eq!(cached.matches("快来源重复资源").count(), 2);
    assert!(cached.contains("\"total\":2"));
    let (status, list) = call(
        &router,
        "GET",
        "/api/admin/crawl/channels",
        Some(&session.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let (status, preview) = call(
        &router,
        "POST",
        &format!("/api/admin/crawl/channels/{channel}/messages/101/preview"),
        Some(&session.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert!(serde_json::from_str::<Value>(&preview).unwrap()["data"]["results"].is_array());
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
    let job = crawl::enqueue(&pool, &channel, "reparse", 1).await.unwrap();
    let (status, pause) = call(
        &router,
        "PUT",
        &format!("/api/admin/crawl/channels/{channel}"),
        Some(&session.token),
        json!({"id":channel,"name":"测试 TG","description":"","enabled":false,"intervalSeconds":600,"expectedVersion":1,"transform":DSL,"outbound":crate::outbound::read(&pool,crate::outbound::Owner::Channel(&channel)).await.unwrap().unwrap(),"bindings":[]}),
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
    // Recover a worker crash/expired lease without losing durable task progress.
    sqlx::query(
        "UPDATE crawl_channels SET enabled=true,next_sync_at=now()+interval '1 day' WHERE id=$1",
    )
    .bind(&channel)
    .execute(&pool)
    .await
    .unwrap();
    let recovery = crawl::enqueue(&pool, &channel, "reparse", 1).await.unwrap();
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
        network_before,
        requests.load(Ordering::SeqCst),
        "reparse uses stored raw only"
    );
    state.auth().revoke_session(&session).await.unwrap();
    state.auth().revoke_session(&anon).await.unwrap();
    server.abort();
    pool.close().await;
}

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test and PANSOU_TEST_REDIS_URL"]
async fn workbench_owned_policy_and_message_contracts() {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();
    let url = std::env::var("PANSOU_TEST_DATABASE_URL").unwrap();
    assert!(url::Url::parse(&url).unwrap().path().ends_with("_test"));
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .connect(&url)
        .await
        .unwrap();
    db::init_db(&pool).await.unwrap();
    let redis = RedisStore::connect(&std::env::var("PANSOU_TEST_REDIS_URL").unwrap())
        .await
        .unwrap();
    let state = Arc::new(AppState::new(pool.clone(), redis));
    let router = build_router(state.clone());
    let id = uuid::Uuid::new_v4().simple().to_string();
    let username = format!("qa_{id}");
    sqlx::query("INSERT INTO users(username,username_normalized,password_hash,role) VALUES($1,$1,$2,'admin')").bind(&username).bind(auth::hash_password(&id).unwrap()).execute(&pool).await.unwrap();
    let token = state.auth().login(&username, &id).await.unwrap().0.token;
    let channel = format!("qa_{}", &id[..10]);
    let node_id = format!("node_{id}");
    let (code, b) = call(
        &router,
        "POST",
        "/api/admin/proxies",
        Some(&token),
        json!({"id":node_id,"name":"QA节点","baseUrl":"http://127.0.0.1:9"}),
    )
    .await;
    assert_eq!(code, StatusCode::OK, "{b}");
    let mut policy = crate::outbound::Policy {
        nodes: vec![crate::outbound::NodeWeight {
            node_id: node_id.clone(),
            weight: 10,
        }],
        ..crate::outbound::Policy::direct()
    };
    let body = json!({"id":channel,"name":"QA频道","description":"","enabled":true,"intervalSeconds":600,"transform":DSL,"outbound":policy,"expectedVersion":0,"bindings":[],"publish":true});
    let path = format!("/api/admin/crawl/channels/{channel}");
    let (code, b) = call(
        &router,
        "POST",
        "/api/admin/crawl/channels",
        Some(&token),
        body.clone(),
    )
    .await;
    assert_eq!(code, StatusCode::OK, "{b}");
    let (code, _) = call(
        &router,
        "POST",
        "/api/admin/crawl/channels",
        Some(&token),
        body.clone(),
    )
    .await;
    assert_eq!(code, StatusCode::CONFLICT);
    let (_, data) = call(&router, "GET", &path, Some(&token), Value::Null).await;
    let data: Value = serde_json::from_str(&data).unwrap();
    assert!(data["data"]["published"].as_bool().unwrap());
    policy.version = 1;
    let (code, refs) = call(
        &router,
        "GET",
        &format!("/api/admin/proxies/{node_id}/references"),
        Some(&token),
        Value::Null,
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    assert!(refs.contains(&channel));
    assert_eq!(
        call(
            &router,
            "DELETE",
            &format!("/api/admin/proxies/{node_id}"),
            Some(&token),
            Value::Null
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let src = crawl::source_for(&pool, &channel).await.unwrap();
    ingest(
        &state,
        &channel,
        &src,
        message(&channel, 101, "QA资源", "share"),
    )
    .await;
    // Forced reparse of identical resource data keeps resource, link and gram tuples intact.
    let resource_id=sqlx::query_scalar::<_,String>("SELECT resource_id FROM resource_occurrences WHERE channel_id=$1 AND message_id=101 LIMIT 1").bind(&channel).fetch_one(&pool).await.unwrap();
    let tuple_snapshot = |id: String, pool: sqlx::PgPool| async move {
        sqlx::query_scalar::<_,Value>("SELECT jsonb_build_object('resource',(SELECT ctid::text FROM managed_resources WHERE id=$1),'links',(SELECT jsonb_agg(jsonb_build_array(identity,ctid::text) ORDER BY identity) FROM resource_links WHERE resource_id=$1),'grams',(SELECT jsonb_agg(jsonb_build_array(gram,ctid::text) ORDER BY gram) FROM resource_grams WHERE resource_id=$1))").bind(id).fetch_one(&pool).await.unwrap()
    };
    let (_, description_only) = call(
        &router,
        "GET",
        "/api/admin/resources?q=%E7%8B%AC%E7%AB%8B%E7%9A%84%E8%B5%84%E6%BA%90%E7%AE%80%E4%BB%8B",
        Some(&token),
        Value::Null,
    )
    .await;
    let description_only: Value = serde_json::from_str(&description_only).unwrap();
    assert!(
        !description_only["data"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == resource_id),
        "admin filtering must match names only"
    );
    let tuples_before = tuple_snapshot(resource_id.clone(), pool.clone()).await;
    sqlx::query("UPDATE source_messages SET parse_version='force-regression' WHERE channel_id=$1 AND message_id=101").bind(&channel).execute(&pool).await.unwrap();
    let mut identical_message = message(&channel, 101, "QA资源", "share");
    identical_message.published = sqlx::query_scalar::<_, Option<chrono::DateTime<chrono::Utc>>>(
        "SELECT published_at FROM source_messages WHERE channel_id=$1 AND message_id=101",
    )
    .bind(&channel)
    .fetch_one(&pool)
    .await
    .unwrap();
    ingest(&state, &channel, &src, identical_message).await;
    assert_eq!(
        tuples_before,
        tuple_snapshot(resource_id, pool.clone()).await,
        "unchanged data must not rewrite resource/link/gram tuples"
    );
    let (_, batch) = call(
        &router,
        "GET",
        "/api/admin/crawl/channels?pageSize=100",
        Some(&token),
        Value::Null,
    )
    .await;
    let batch: Value = serde_json::from_str(&batch).unwrap();
    let summary = batch["data"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == channel)
        .unwrap();
    assert_eq!(summary["messageCount"], 1);
    assert_eq!(summary["resourceCount"], 1);
    for (method, url, body) in [
        (
            "PUT",
            "/api/admin/proxies/direct",
            json!({"name":"illegal","baseUrl":"http://localhost:9"}),
        ),
        ("DELETE", "/api/admin/proxies/direct", Value::Null),
        ("POST", "/api/admin/proxies/direct/reset", Value::Null),
    ] {
        assert_eq!(
            call(&router, method, url, Some(&token), body).await.0,
            StatusCode::BAD_REQUEST,
            "built-in direct is immutable"
        );
    }
    let before = sqlx::query_scalar::<_, i64>(
        "SELECT revision FROM config_revisions WHERE scope='local-index'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let (code, detail) = call(
        &router,
        "GET",
        &format!("{path}/messages/101"),
        Some(&token),
        Value::Null,
    )
    .await;
    assert_eq!(code, StatusCode::OK, "{detail}");
    assert!(serde_json::from_str::<Value>(&detail).unwrap()["data"]["stored"].is_array());
    let (code, preview) = call(
        &router,
        "POST",
        &format!("{path}/messages/101/preview"),
        Some(&token),
        json!({}),
    )
    .await;
    assert_eq!(code, StatusCode::OK, "{preview}");
    let preview: Value = serde_json::from_str(&preview).unwrap();
    assert_eq!(preview["data"]["status"], "parsed");
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT revision FROM config_revisions WHERE scope='local-index'"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        before
    );
    let list = call(
        &router,
        "GET",
        &format!("{path}/messages"),
        Some(&token),
        Value::Null,
    )
    .await;
    assert!(
        list.1.contains("QA资源"),
        "summary must contain message body, not channel header"
    );
    let request_key = format!("request-{id}");
    let job_body = json!({"kind":"sync","maxPages":2,"requestKey":request_key});
    let first = call(
        &router,
        "POST",
        &format!("{path}/jobs"),
        Some(&token),
        job_body.clone(),
    )
    .await;
    assert_eq!(first.0, StatusCode::OK, "{}", first.1);
    let repeated = call(
        &router,
        "POST",
        &format!("{path}/jobs"),
        Some(&token),
        job_body.clone(),
    )
    .await;
    assert_eq!(
        serde_json::from_str::<Value>(&first.1).unwrap()["data"]["id"],
        serde_json::from_str::<Value>(&repeated.1).unwrap()["data"]["id"]
    );
    assert_eq!(
        call(
            &router,
            "POST",
            &format!("{path}/jobs"),
            Some(&token),
            json!({"kind":"sync","maxPages":3,"requestKey":request_key})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let template = call(
        &router,
        "GET",
        "/api/settings/source-template",
        Some(&token),
        Value::Null,
    )
    .await;
    let template: Value = serde_json::from_str(&template.1).unwrap();
    let template_body = json!({"transform":DSL,"version":template["data"]["version"]});
    assert_eq!(
        call(
            &router,
            "PUT",
            "/api/settings/source-template",
            Some(&token),
            template_body.clone()
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &router,
            "PUT",
            "/api/settings/source-template",
            Some(&token),
            template_body
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(
            &router,
            "GET",
            "/api/admin/crawl/jobs?cursor=invalid",
            Some(&token),
            Value::Null
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    for mid in [201, 202] {
        ingest(
            &state,
            &channel,
            &src,
            message(&channel, mid, "复核消息", "review_share"),
        )
        .await;
    }
    sqlx::query("UPDATE source_messages SET parse_status='review',published_at='2026-09-30T01:00:00Z' WHERE channel_id=$1 AND message_id IN (201,202)").bind(&channel).execute(&pool).await.unwrap();
    let rev = call(
        &router,
        "GET",
        &format!("/api/admin/crawl/review?channel={channel}&limit=1"),
        Some(&token),
        Value::Null,
    )
    .await;
    assert_eq!(rev.0, StatusCode::OK, "{}", rev.1);
    let rev: Value = serde_json::from_str(&rev.1).unwrap();
    let cur = rev["data"]["nextCursor"].as_str().unwrap();
    assert!(cur.parse::<i64>().is_err(), "cursor must be opaque");
    assert_eq!(rev["data"]["items"][0]["messageId"], 202);
    let next = call(
        &router,
        "GET",
        &format!("/api/admin/crawl/review?channel={channel}&limit=1&cursor={cur}"),
        Some(&token),
        Value::Null,
    )
    .await;
    assert_eq!(next.0, StatusCode::OK, "{}", next.1);
    assert_eq!(
        serde_json::from_str::<Value>(&next.1).unwrap()["data"]["items"][0]["messageId"],
        201
    );
    let (code, _) = call(
        &router,
        "GET",
        "/api/admin/crawl/jobs?limit=0",
        Some(&token),
        Value::Null,
    )
    .await;
    assert_eq!(code, StatusCode::BAD_REQUEST);
    let (code, b) = call(
        &router,
        "POST",
        &format!("{path}/messages/101/reparse"),
        Some(&token),
        Value::Null,
    )
    .await;
    assert_eq!(code, StatusCode::OK, "{b}");
    assert_eq!(
        call(
            &router,
            "POST",
            &format!("{path}/messages/101/reparse"),
            Some(&token),
            Value::Null
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let mut changed = body;
    changed["expectedVersion"] = json!(1);
    changed["outbound"] = json!(policy);
    changed["enabled"] = json!(false);
    let (code, b) = call(&router, "PUT", &path, Some(&token), changed.clone()).await;
    assert_eq!(code, StatusCode::OK, "{b}");
    assert_eq!(
        call(&router, "PUT", &path, Some(&token), changed).await.0,
        StatusCode::CONFLICT
    );
    assert!(
        sqlx::query_scalar::<_, bool>("SELECT enabled FROM resource_sources WHERE channel_id=$1")
            .bind(&channel)
            .fetch_one(&pool)
            .await
            .unwrap(),
        "pause must not unpublish"
    );
    let (code, sources) = call(
        &router,
        "GET",
        "/api/settings/sources",
        Some(&token),
        Value::Null,
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    assert!(!sources.contains(&format!("tg-{channel}")));
    let (code, b) = call(
        &router,
        "PUT",
        "/api/settings/search",
        Some(&token),
        json!({"sources":[]}),
    )
    .await;
    assert_eq!(code, StatusCode::OK, "{b}");
    assert!(
        sqlx::query_scalar::<_, bool>("SELECT enabled FROM resource_sources WHERE channel_id=$1")
            .bind(&channel)
            .fetch_one(&pool)
            .await
            .unwrap(),
        "live configuration save must preserve TG publish"
    );
    // Single-message reparse must not touch another stored message or perform HTTP.
    ingest(
        &state,
        &channel,
        &src,
        message(&channel, 102, "另一条资源", "other_share"),
    )
    .await;
    let untouched = sqlx::query_scalar::<_, chrono::DateTime<chrono::Utc>>(
        "SELECT updated_at FROM source_messages WHERE channel_id=$1 AND message_id=102",
    )
    .bind(&channel)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE crawl_channels SET enabled=true,next_sync_at=now()+interval '1 day' WHERE id=$1",
    )
    .bind(&channel)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE crawl_jobs SET status=CASE WHEN kind='reparse_message' THEN 'queued' ELSE 'cancelled' END WHERE channel_id=$1 AND status='paused'").bind(&channel).execute(&pool).await.unwrap();
    crawl::tick(&state).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT status FROM crawl_jobs WHERE channel_id=$1 AND kind='reparse_message'"
        )
        .bind(&channel)
        .fetch_one(&pool)
        .await
        .unwrap(),
        "completed"
    );
    assert_eq!(
        sqlx::query_scalar::<_, chrono::DateTime<chrono::Utc>>(
            "SELECT updated_at FROM source_messages WHERE channel_id=$1 AND message_id=102"
        )
        .bind(&channel)
        .fetch_one(&pool)
        .await
        .unwrap(),
        untouched,
        "single reparse must leave other message intact"
    );
    sqlx::query(
        "UPDATE proxy_nodes SET daily_limit=1,quota_day=CURRENT_DATE,quota_used=0 WHERE id=$1",
    )
    .bind(&node_id)
    .execute(&pool)
    .await
    .unwrap();
    let owner = crate::outbound::Owner::Channel(&channel);
    let mut plans = Vec::new();
    for _ in 0..8 {
        let mut plan = crate::outbound::Plan::load(&pool, owner, "GET")
            .await
            .unwrap();
        let p = pool.clone();
        plans.push(tokio::spawn(async move {
            plan.next(&p).await.unwrap().is_some()
        }));
    }
    let mut reserved = 0;
    for p in plans {
        reserved += usize::from(p.await.unwrap());
    }
    assert_eq!(reserved, 1, "global quota reservation is atomic");
    // Direct participates only when selected, in the same weighted priority order.
    let mut p = crate::outbound::read(&pool, owner).await.unwrap().unwrap();
    p.nodes.push(crate::outbound::NodeWeight {
        node_id: crate::outbound::DIRECT.into(),
        weight: 0,
    });
    let mut tx = pool.begin().await.unwrap();
    crate::outbound::save(&mut tx, owner, &p).await.unwrap();
    tx.commit().await.unwrap();
    let mut unavailable = crate::outbound::Plan::load(&pool, owner, "GET")
        .await
        .unwrap();
    assert!(matches!(unavailable.next(&pool).await.unwrap(), Some(None)));
    assert!(unavailable.next(&pool).await.unwrap().is_none());
    sqlx::query("UPDATE proxy_nodes SET daily_limit=0 WHERE id=$1")
        .bind(&node_id)
        .execute(&pool)
        .await
        .unwrap();
    let mut ordered = crate::outbound::Plan::load(&pool, owner, "GET")
        .await
        .unwrap();
    assert!(matches!(ordered.next(&pool).await.unwrap(), Some(Some(_))));
    assert!(matches!(ordered.next(&pool).await.unwrap(), Some(None)));
    assert!(ordered.next(&pool).await.unwrap().is_none());
    let mut post = crate::outbound::Plan::load(&pool, owner, "POST")
        .await
        .unwrap();
    assert!(matches!(post.next(&pool).await.unwrap(), Some(Some(_))));
    assert!(
        post.next(&pool).await.unwrap().is_none(),
        "POST must not be replayed even when direct is selected"
    );
    p = crate::outbound::read(&pool, owner).await.unwrap().unwrap();
    p.nodes
        .iter_mut()
        .find(|n| n.node_id == crate::outbound::DIRECT)
        .unwrap()
        .weight = 20;
    let mut tx = pool.begin().await.unwrap();
    crate::outbound::save(&mut tx, owner, &p).await.unwrap();
    tx.commit().await.unwrap();
    let mut direct_first = crate::outbound::Plan::load(&pool, owner, "GET")
        .await
        .unwrap();
    assert!(matches!(
        direct_first.next(&pool).await.unwrap(),
        Some(None)
    ));
    assert!(matches!(
        direct_first.next(&pool).await.unwrap(),
        Some(Some(_))
    ));
    let mut inherited = crate::outbound::Policy {
        nodes: vec![],
        version: 0,
        inherit: true,
    };
    inherited.version = crate::outbound::read(&pool, owner)
        .await
        .unwrap()
        .unwrap()
        .version;
    let mut tx = pool.begin().await.unwrap();
    crate::outbound::save(&mut tx, owner, &inherited)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    sqlx::query("DELETE FROM outbound_policies WHERE default_key='telegram'")
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        crate::outbound::Plan::load(&pool, owner, "GET")
            .await
            .is_err()
    );
}
