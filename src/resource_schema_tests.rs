//! Resource input snapshots and catalog observations have distinct ownership.
use crate::{app::AppState, db, redis_store::RedisStore};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::Arc;
use uuid::Uuid;

async fn test_pool() -> PgPool {
    let url = std::env::var("PANSOU_TEST_DATABASE_URL").unwrap();
    assert!(url::Url::parse(&url).unwrap().path().ends_with("_test"));
    let pool = db::connect(&url).await.unwrap();
    db::init_db(&pool).await.unwrap();
    pool
}

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test and PANSOU_TEST_REDIS_URL"]
async fn admin_edits_derive_types_and_do_not_persist_forged_observations() {
    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;
    let pool = test_pool().await;
    let redis = std::env::var("PANSOU_TEST_REDIS_URL").unwrap();
    assert_ne!(url::Url::parse(&redis).unwrap().path(), "/0");
    let state = Arc::new(AppState::new(
        pool.clone(),
        RedisStore::connect(&redis).await.unwrap(),
    ));
    let username = format!("schema_admin_{}", Uuid::new_v4().simple());
    sqlx::query("INSERT INTO users(username,username_normalized,password_hash,role) VALUES($1,$1,$2,'admin')")
        .bind(&username).bind(crate::auth::hash_password("fixture").unwrap()).execute(&pool).await.unwrap();
    let session = state.auth().login(&username, "fixture").await.unwrap().0;
    let router = crate::app::build_router(state.clone());
    async fn call(
        router: &axum::Router,
        token: &str,
        method: &str,
        path: &str,
        body: Value,
    ) -> (StatusCode, Value) {
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }
    let id = format!("schema_resource_{}", Uuid::new_v4().simple());
    let link = crate::models::Link {
        r#type: "quark".into(),
        url: format!("https://pan.quark.cn/s/{}", Uuid::new_v4().simple()),
        password: Some("1234".into()),
    };
    let request = json!({"id":id,"name":"Schema resource","cloud_types":["phantom"],"links":[{"type":"baidu","url":link.url,"password":link.password,"validity":1,"checkStatus":"valid","checkMessage":"forged upstream secret","createdAt":"1900-01-01"}]});
    let (status, created) = call(
        &router,
        &session.token,
        "POST",
        "/api/admin/resources",
        request,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["data"]["resource"]["cloud_types"], json!(["quark"]));
    assert!(created["data"]["resource"].get("tags").is_none());
    let stored: Value =
        sqlx::query_scalar("SELECT resource_links_json(id) FROM managed_resources WHERE id=$1")
            .bind(&id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(stored, json!([link]));
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM resource_links")
        .fetch_one(&pool)
        .await
        .unwrap();
    let path = format!("/api/admin/resources/{id}");
    let (status, unchecked) = call(&router, &session.token, "GET", &path, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert!(unchecked["data"]["resource"].get("tags").is_none());
    let (status, listed) = call(
        &router,
        &session.token,
        "GET",
        "/api/admin/resources?cloudType=quark",
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert!(
        listed["data"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item.get("tags").is_none())
    );
    assert_eq!(
        unchecked["data"]["resource"]["links"][0]["checkStatus"],
        "unchecked"
    );
    assert!(unchecked["data"]["resource"]["links"][0]["createdAt"].is_string());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM resource_links")
            .fetch_one(&pool)
            .await
            .unwrap(),
        before,
        "reading a resource must not register links"
    );
    let catalog_id: Uuid =
        sqlx::query_scalar("SELECT id FROM resource_links WHERE resource_id=$1 AND position=0")
            .bind(&id)
            .fetch_one(&pool)
            .await
            .unwrap();
    sqlx::query("UPDATE resource_links SET validity=1,checked_at=now(),valid_until=now()-interval '1 second',last_attempt_at=now(),last_error_code='rate_limited' WHERE id=$1")
        .bind(catalog_id).execute(&pool).await.unwrap();
    // Simulate a paused worker with a stale resource aggregate.
    sqlx::query("UPDATE managed_resources SET link_validity=1 WHERE id=$1")
        .bind(&id)
        .execute(&pool)
        .await
        .unwrap();
    let (_, expired) = call(&router, &session.token, "GET", &path, Value::Null).await;
    let resource = &expired["data"]["resource"];
    assert_eq!(resource["linkValidity"], -1);
    assert_eq!(resource["checkStatus"], "unchecked");
    assert_eq!(resource["links"][0]["checkStatus"], "unknown");
    assert_eq!(resource["links"][0]["checkMessage"], "检测结果已过期");
    assert!(resource["links"][0]["createdAt"].is_string());
    sqlx::query("UPDATE resource_links SET validity=0,valid_until=now()+interval '1 hour',last_error_code='original_invalid' WHERE id=$1")
        .bind(catalog_id).execute(&pool).await.unwrap();
    let (_, invalid) = call(&router, &session.token, "GET", &path, Value::Null).await;
    assert_eq!(invalid["data"]["resource"]["linkValidity"], 0);
    assert_eq!(
        invalid["data"]["resource"]["links"][0]["checkMessage"],
        "分享链接已失效"
    );
    let (status,edited) = call(&router,&session.token,"PUT",&path,json!({"name":"Edited","links":[{"type":"guangya","url":"https://www.guangyapan.com/s/new"}]})).await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!(
        edited["data"]["resource"]["cloud_types"],
        json!(["guangya"])
    );
    let (status, invalid_shape) = call(
        &router,
        &session.token,
        "PUT",
        &path,
        json!({"name":"Bad","links":{}}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{invalid_shape}");
    let (status, deleted) = call(
        &router,
        &session.token,
        "POST",
        "/api/admin/resources/batch-delete",
        json!({"ids":[id,id,"missing-resource"]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{deleted}");
    assert_eq!(deleted["data"]["count"], 1);
    assert!(
        !sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM managed_resources WHERE id=$1)"
        )
        .bind(&id)
        .fetch_one(&pool)
        .await
        .unwrap()
    );
    let (_, missing) = call(&router, &session.token, "GET", &path, Value::Null).await;
    assert!(missing["data"]["resource"].is_null());
    sqlx::query("DELETE FROM resource_links WHERE id=$1")
        .bind(catalog_id)
        .execute(&pool)
        .await
        .unwrap();
    state.auth().revoke_session(&session).await.unwrap();
}

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test"]
async fn baseline_has_only_current_resource_schema_and_builtin_defaults() {
    let pool = test_pool().await;
    let mut tx = pool.begin().await.unwrap();
    let schema = format!("baseline_{}", Uuid::new_v4().simple());
    sqlx::raw_sql(&format!(
        "CREATE SCHEMA {schema}; SET LOCAL search_path TO {schema},public"
    ))
    .execute(&mut *tx)
    .await
    .unwrap();
    for migration in sqlx::migrate!("./migrations").iter() {
        sqlx::raw_sql(&migration.sql)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    for obsolete in [
        "resource_occurrences",
        "resource_search_documents",
        "resource_search_occurrences",
        "resource_grams",
        "source_messages",
        "channel_statistics",
        "channel_resource_references",
        "resource_cloud_type_counts",
        "crawl_message_task_resources",
        "proxy_groups",
        "proxy_routes",
        "proxy_group_nodes",
        "source_template_settings",
        "cloud_account_aliases",
        "search_setting_sources",
        "system_settings",
        "search_settings",
        "link_catalog",
        "resource_link_bindings",
        "link_sync_queue",
        "wechat_mini_settings",
    ] {
        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2)")
            .bind(&schema).bind(obsolete).fetch_one(&mut *tx).await.unwrap();
        assert!(!exists, "obsolete table {obsolete}");
    }
    let columns:i64=sqlx::query_scalar("SELECT count(*) FROM information_schema.columns WHERE table_schema=$1 AND table_name='managed_resources' AND column_name IN('search_text','manual_override','deleted_at','tags_json','cloud_types_json','links_json','links_revision')")
        .bind(&schema).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(columns, 0);
    let resources: i64 = sqlx::query_scalar("SELECT count(*) FROM managed_resources")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(resources, 0);
    let providers:i64=sqlx::query_scalar("SELECT count(*) FROM cloud_provider_policies WHERE NOT delivery_enabled AND target_dir IS NULL").fetch_one(&mut *tx).await.unwrap();
    assert_eq!(providers, 5);
    let nodes: Vec<String> = sqlx::query_scalar("SELECT id FROM proxy_nodes")
        .fetch_all(&mut *tx)
        .await
        .unwrap();
    assert_eq!(nodes, vec!["direct"]);
    tx.rollback().await.unwrap();
}

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test"]
async fn baseline_resource_triggers_generate_search_terms_and_cascade_deletion() {
    let pool = test_pool().await;
    let mut tx = pool.begin().await.unwrap();
    let id = format!("baseline_resource_{}", Uuid::new_v4().simple());
    sqlx::query("INSERT INTO managed_resources(id,name) VALUES($1,'三体全集')")
        .bind(&id)
        .execute(&mut *tx)
        .await
        .unwrap();
    let grams: Vec<String> =
        sqlx::query_scalar("SELECT name_grams FROM managed_resources WHERE id=$1")
            .bind(&id)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert!(grams.contains(&"三体".into()));
    let revision: i64 =
        sqlx::query_scalar("SELECT revision FROM config_revisions WHERE scope='local-index'")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    sqlx::query("UPDATE managed_resources SET name=name WHERE id=$1")
        .bind(&id)
        .execute(&mut *tx)
        .await
        .unwrap();
    let unchanged: i64 =
        sqlx::query_scalar("SELECT revision FROM config_revisions WHERE scope='local-index'")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(revision, unchanged);
    sqlx::query("UPDATE managed_resources SET name='新资源' WHERE id=$1")
        .bind(&id)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO link_aggregate_queue(resource_id) VALUES($1)")
        .bind(&id)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("DELETE FROM managed_resources WHERE id=$1")
        .bind(&id)
        .execute(&mut *tx)
        .await
        .unwrap();
    let queued: i64 =
        sqlx::query_scalar("SELECT count(*) FROM link_aggregate_queue WHERE resource_id=$1")
            .bind(&id)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(queued, 0);
    tx.rollback().await.unwrap();
}

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test"]
async fn crawl_task_schema_rejects_ignored_status() {
    let pool = test_pool().await;
    let mut tx = pool.begin().await.unwrap();
    let schema = format!("ignored_tasks_{}", Uuid::new_v4().simple());
    sqlx::raw_sql(&format!(
        "CREATE SCHEMA {schema}; SET LOCAL search_path TO {schema},public"
    ))
    .execute(&mut *tx)
    .await
    .unwrap();
    for migration in sqlx::migrate!("./migrations").iter() {
        sqlx::raw_sql(&migration.sql)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    sqlx::raw_sql(
        "INSERT INTO crawl_channels(id,name) VALUES('cleanup','清理测试');
         INSERT INTO crawl_message_tasks(channel_id,message_id,status)
           VALUES('cleanup',1,'failed'),('cleanup',2,'parsed'),('cleanup',3,'empty');",
    )
    .execute(&mut *tx)
    .await
    .unwrap();
    let error = sqlx::query("INSERT INTO crawl_message_tasks(channel_id,message_id,status) VALUES('cleanup',4,'ignored')")
        .execute(&mut *tx).await.unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("23514")
    );
    tx.rollback().await.unwrap();
}

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test"]
async fn unused_settings_cleanup_preserves_real_configuration_and_resource_content() {
    let pool = test_pool().await;
    let mut tx = pool.begin().await.unwrap();
    let schema = format!("settings_cleanup_{}", Uuid::new_v4().simple());
    sqlx::raw_sql(&format!(
        "CREATE SCHEMA {schema}; SET LOCAL search_path TO {schema},public"
    ))
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!("../migrations/044_schema.sql"))
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::raw_sql("UPDATE search_settings SET updated_at='2026-10-01'; INSERT INTO policy_settings(key,value_json) VALUES('defaultConcurrency','7'); UPDATE system_settings SET default_concurrency=3; INSERT INTO managed_resources(id,name) VALUES('kept','保留资源');")
        .execute(&mut *tx).await.unwrap();
    let before: Value =
        sqlx::query_scalar("SELECT to_jsonb(r) FROM managed_resources r WHERE id='kept'")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    sqlx::raw_sql(include_str!("../migrations/046_remove_unused_settings.sql"))
        .execute(&mut *tx)
        .await
        .unwrap();
    let after: Value =
        sqlx::query_scalar("SELECT to_jsonb(r) FROM managed_resources r WHERE id='kept'")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(before, after);
    let concurrency: Value =
        sqlx::query_scalar("SELECT value_json FROM policy_settings WHERE key='defaultConcurrency'")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(concurrency, json!(7));
    let stamp: chrono::DateTime<chrono::Utc> = sqlx::query_scalar(
        "SELECT updated_at FROM policy_settings WHERE key='search-settings-meta'",
    )
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert_eq!(stamp.date_naive().to_string(), "2026-10-01");
    tx.rollback().await.unwrap();
}

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test"]
async fn wechat_config_migration_preserves_secret_timestamp_and_canonical_policy() {
    let pool = test_pool().await;
    let mut tx = pool.begin().await.unwrap();
    let schema = format!("config_merge_{}", Uuid::new_v4().simple());
    sqlx::raw_sql(&format!(
        "CREATE SCHEMA {schema}; SET LOCAL search_path TO {schema},public"
    ))
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!("../migrations/044_schema.sql"))
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::raw_sql(include_str!("../migrations/046_remove_unused_settings.sql"))
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::raw_sql("INSERT INTO wechat_mini_settings(id,app_id,secret,qr_page,env_version,updated_at) VALUES(1,'fixture-app','fixture-secret','pages/custom','trial','2026-10-01'); INSERT INTO policy_settings(key,value_json) VALUES('show_hot_search','false'),('showHotSearch','true'),('show_auth_buttons','false');")
        .execute(&mut *tx).await.unwrap();
    sqlx::raw_sql(include_str!("../migrations/047_unify_wechat_settings.sql"))
        .execute(&mut *tx)
        .await
        .unwrap();
    let value: Value =
        sqlx::query_scalar("SELECT value_json FROM policy_settings WHERE key='wechat-mini'")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(
        value,
        json!({"appId":"fixture-app","secret":"fixture-secret","qrPage":"pages/custom","envVersion":"trial"})
    );
    let date: String = sqlx::query_scalar(
        "SELECT updated_at::date::text FROM policy_settings WHERE key='wechat-mini'",
    )
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert_eq!(date, "2026-10-01");
    let hot: Value =
        sqlx::query_scalar("SELECT value_json FROM policy_settings WHERE key='showHotSearch'")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    let auth: Value =
        sqlx::query_scalar("SELECT value_json FROM policy_settings WHERE key='showAuthButtons'")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(hot, json!(true));
    assert_eq!(auth, json!(false));
    let old: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM policy_settings WHERE key LIKE '%\\_%' ESCAPE '\\'",
    )
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert_eq!(old, 0);
    tx.rollback().await.unwrap();
}

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test"]
async fn policy_partial_saves_preserve_concurrent_edits_and_unmodified_timestamps() {
    let pool = test_pool().await;
    let current = crate::policy::load(&pool).await.unwrap();
    let a = if current.default_concurrency == 7 {
        8
    } else {
        7
    };
    let b = if current.session_days == 40 { 41 } else { 40 };
    sqlx::query("INSERT INTO policy_settings(key,value_json,updated_at) VALUES('showHotSearch',$1,'2026-10-01') ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at")
        .bind(json!(current.show_hot_search)).execute(&pool).await.unwrap();
    let mut gate = pool.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(734810,1)")
        .execute(&mut *gate)
        .await
        .unwrap();
    let p1 = pool.clone();
    let p2 = pool.clone();
    let first = tokio::spawn(async move {
        crate::policy::save(&p1, &json!({"defaultConcurrency":a}))
            .await
            .unwrap()
    });
    let second = tokio::spawn(async move {
        crate::policy::save(&p2, &json!({"sessionDays":b}))
            .await
            .unwrap()
    });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(
        !first.is_finished() && !second.is_finished(),
        "partial saves must wait for the transaction lock"
    );
    gate.commit().await.unwrap();
    first.await.unwrap();
    second.await.unwrap();
    let saved = crate::policy::load(&pool).await.unwrap();
    assert_eq!(saved.default_concurrency, a);
    assert_eq!(saved.session_days, b);
    let date: String = sqlx::query_scalar(
        "SELECT updated_at::date::text FROM policy_settings WHERE key='showHotSearch'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(date, "2026-10-01");
    let before: Value =
        sqlx::query_scalar("SELECT jsonb_agg(to_jsonb(s) ORDER BY key) FROM policy_settings s")
            .fetch_one(&pool)
            .await
            .unwrap();
    crate::policy::save(&pool, &json!({"defaultConcurrency":a}))
        .await
        .unwrap();
    let after: Value =
        sqlx::query_scalar("SELECT jsonb_agg(to_jsonb(s) ORDER BY key) FROM policy_settings s")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(before, after);
    crate::policy::save(&pool, &serde_json::to_value(current).unwrap())
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test and PANSOU_TEST_REDIS_URL"]
async fn unified_wechat_settings_preserve_blank_secret_and_hide_it_from_responses() {
    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;
    let pool = test_pool().await;
    let redis = std::env::var("PANSOU_TEST_REDIS_URL").unwrap();
    assert_ne!(url::Url::parse(&redis).unwrap().path(), "/0");
    let state = Arc::new(AppState::new(
        pool.clone(),
        RedisStore::connect(&redis).await.unwrap(),
    ));
    let username = format!("wechat_config_{}", Uuid::new_v4().simple());
    sqlx::query("INSERT INTO users(username,username_normalized,password_hash,role) VALUES($1,$1,$2,'admin')")
        .bind(&username).bind(crate::auth::hash_password("fixture").unwrap()).execute(&pool).await.unwrap();
    let session = state.auth().login(&username, "fixture").await.unwrap().0;
    let router = crate::app::build_router(state);
    for body in [
        json!({"appId":"fixture-app","secret":"private-fixture","qrPage":"pages/custom","envVersion":"trial"}),
        json!({"appId":"next-app","secret":"","qrPage":"pages/login/index","envVersion":"release"}),
    ] {
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/settings/wechat")
                    .header("authorization", format!("Bearer {}", session.token))
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        let reply: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(reply["data"]["secretConfigured"], json!(true));
        assert_eq!(reply["data"]["appId"], body["appId"]);
        assert!(!String::from_utf8_lossy(&bytes).contains("private-fixture"));
        assert!(reply["data"].get("secret").is_none());
    }
    let secret: String = sqlx::query_scalar(
        "SELECT value_json->>'secret' FROM policy_settings WHERE key='wechat-mini'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(secret, "private-fixture");
    sqlx::query("DELETE FROM policy_settings WHERE key='wechat-mini'")
        .execute(&pool)
        .await
        .unwrap();
}
