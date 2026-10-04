use super::*;
use crate::{app::build_router, auth, db, redis_store::RedisStore};
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use std::{
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};
use tower::ServiceExt;
use uuid::Uuid;

async fn call(
    router: &axum::Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let response = router
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (
        status,
        serde_json::from_slice(&body)
            .unwrap_or_else(|_| json!({"message":String::from_utf8_lossy(&body)})),
    )
}

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test and PANSOU_TEST_REDIS_URL"]
async fn monitor_and_worker_controls_follow_runtime_architecture() {
    let url = std::env::var("PANSOU_TEST_DATABASE_URL").unwrap();
    assert!(url::Url::parse(&url).unwrap().path().ends_with("_test"));
    let pool = db::connect(&url).await.unwrap();
    db::init_db(&pool).await.unwrap();
    let redis = RedisStore::connect(&std::env::var("PANSOU_TEST_REDIS_URL").unwrap())
        .await
        .unwrap();
    let state = Arc::new(AppState::new(pool.clone(), redis));
    let router = build_router(state.clone());
    let id = Uuid::new_v4().simple().to_string();
    let username = format!("runtime_{id}");
    sqlx::query("INSERT INTO users(username,username_normalized,password_hash,role) VALUES($1,$1,$2,'admin')")
        .bind(&username).bind(auth::hash_password(&id).unwrap()).execute(&pool).await.unwrap();
    let (admin, _) = state.auth().login(&username, &id).await.unwrap();
    let anon = state.auth().issue(true).await.unwrap();
    assert_eq!(
        call(&router, "GET", "/api/monitor", None, Value::Null)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &router,
            "GET",
            "/api/monitor",
            Some(&anon.token),
            Value::Null
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &router,
            "PUT",
            "/api/admin/runtime/workers/crawl",
            Some(&anon.token),
            json!({"enabled":false})
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &router,
            "PUT",
            "/api/admin/runtime/workers/unknown",
            Some(&admin.token),
            json!({"enabled":false})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(
            &router,
            "PUT",
            "/api/admin/runtime/workers/crawl",
            Some(&admin.token),
            json!({"enabled":"false"})
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    sqlx::query("UPDATE users SET role='user' WHERE username=$1")
        .bind(&username)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        call(
            &router,
            "GET",
            "/api/monitor",
            Some(&admin.token),
            Value::Null
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &router,
            "PUT",
            "/api/admin/runtime/workers/crawl",
            Some(&admin.token),
            json!({"enabled":false})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    sqlx::query("UPDATE users SET role='admin' WHERE username=$1")
        .bind(&username)
        .execute(&pool)
        .await
        .unwrap();

    let channel = format!("runtime_{}", &id[..12]);
    let tg = format!("tg_{id}");
    let live = format!("live_{id}");
    sqlx::query("INSERT INTO crawl_channels(id) VALUES($1)")
        .bind(&channel)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO resource_sources(id,name,url,method,format,transform,kind,channel_id) VALUES($1,'TG','https://t.me/s/test','GET','html','','telegram',$2)").bind(&tg).bind(&channel).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO resource_sources(id,name,url,method,format,transform,kind) VALUES($1,'Live','https://example.invalid','GET','json','','live')").bind(&live).execute(&pool).await.unwrap();
    for source in [&live, &tg] {
        sqlx::query("INSERT INTO source_health(source_id,snapshot_json) VALUES($1,$2)")
            .bind(source).bind(json!({"isHealthy":true,"requestCount":1,"successCount":1,"zeroResultCount":1,"lastSuccessTime":Utc::now().timestamp_millis()})).execute(&pool).await.unwrap();
    }
    assert_eq!(
        call(
            &router,
            "PUT",
            "/api/admin/runtime/workers/crawl",
            Some(&admin.token),
            json!({"enabled":false})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &router,
            "PUT",
            "/api/admin/runtime/workers/cleanup",
            Some(&admin.token),
            json!({"enabled":false})
        )
        .await
        .0,
        StatusCode::OK
    );
    let settings = runtime::settings(&state).await.unwrap();
    assert!(!settings.crawl_enabled && !settings.link_enabled);
    let check_policy_before = sqlx::query_scalar::<_, Value>(
        "SELECT value_json FROM policy_settings WHERE key='link-check'",
    )
    .fetch_optional(&pool)
    .await
    .unwrap();
    // Each lane is persisted independently and really stops taking batches.
    let lanes = [
        ("link-sync", WorkerKind::LinkSync, "syncEnabled"),
        ("link-check", WorkerKind::LinkCheck, "checkEnabled"),
        (
            "link-maintenance",
            WorkerKind::LinkMaintenance,
            "maintenanceEnabled",
        ),
    ];
    for (endpoint, kind, flag) in lanes {
        let (status, body) = call(
            &router,
            "PUT",
            &format!("/api/admin/runtime/workers/{endpoint}"),
            Some(&admin.token),
            json!({"enabled":false}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(!runtime::enabled(&state, kind).await.unwrap());
        let fresh = AppState::new(pool.clone(), state.redis.clone());
        assert!(
            !runtime::enabled(&fresh, kind).await.unwrap(),
            "independent pause survives a fresh process state"
        );
        for (other, other_kind, _) in lanes {
            if other != endpoint {
                assert!(runtime::enabled(&state, other_kind).await.unwrap());
            }
        }
        let (_, monitor) = call(
            &router,
            "GET",
            "/api/monitor",
            Some(&admin.token),
            Value::Null,
        )
        .await;
        assert_eq!(monitor["data"]["workers"]["links"][flag], false);
        let paused_state = Arc::new(AppState::new(pool.clone(), state.redis.clone()));
        let ticks = AtomicUsize::new(0);
        let cancel_state = paused_state.clone();
        let cancel = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            cancel_state.shutdown.cancel();
        });
        runtime::lane(&paused_state, kind, "test-independent-pause", 1, || async {
            ticks.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .await;
        cancel.await.unwrap();
        assert_eq!(
            ticks.load(Ordering::SeqCst),
            0,
            "{endpoint} must not run while independently paused"
        );
        let (status, _) = call(
            &router,
            "PUT",
            &format!("/api/admin/runtime/workers/{endpoint}"),
            Some(&admin.token),
            json!({"enabled":true}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let resumed_state = Arc::new(AppState::new(pool.clone(), state.redis.clone()));
        runtime::lane(
            &resumed_state,
            kind,
            "test-independent-resume",
            1,
            || async {
                ticks.fetch_add(1, Ordering::SeqCst);
                resumed_state.shutdown.cancel();
                Ok(())
            },
        )
        .await;
        assert_eq!(ticks.load(Ordering::SeqCst), 1);
    }
    // Concurrent updates merge just their own keys, never overwrite sibling controls.
    let (sync_update, check_update) = tokio::join!(
        call(
            &router,
            "PUT",
            "/api/admin/runtime/workers/link-sync",
            Some(&admin.token),
            json!({"enabled":false})
        ),
        call(
            &router,
            "PUT",
            "/api/admin/runtime/workers/link-check",
            Some(&admin.token),
            json!({"enabled":false})
        )
    );
    assert_eq!(sync_update.0, StatusCode::OK);
    assert_eq!(check_update.0, StatusCode::OK);
    let saved = runtime::settings(&state).await.unwrap();
    assert!(
        !saved.link_sync_enabled
            && !saved.link_check_enabled
            && !saved.link_enabled
            && !saved.crawl_enabled
    );
    assert!(saved.link_schedule_enabled && saved.link_maintenance_enabled);
    let check_policy_after = sqlx::query_scalar::<_, Value>(
        "SELECT value_json FROM policy_settings WHERE key='link-check'",
    )
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert_eq!(
        check_policy_before, check_policy_after,
        "runtime switches must not alter detection policy"
    );
    for endpoint in ["link-sync", "link-check"] {
        assert_eq!(
            call(
                &router,
                "PUT",
                &format!("/api/admin/runtime/workers/{endpoint}"),
                Some(&admin.token),
                json!({"enabled":true})
            )
            .await
            .0,
            StatusCode::OK
        );
    }
    let sync_state = Arc::new(AppState::new(pool.clone(), state.redis.clone()));
    let independent = Arc::new(AtomicUsize::new(0));
    let sync_ticks = independent.clone();
    runtime::lane(
        &sync_state,
        runtime::WorkerKind::LinkSync,
        "local-sync-independent",
        1,
        || async {
            sync_ticks.fetch_add(1, Ordering::SeqCst);
            sync_state.shutdown.cancel();
            Ok(())
        },
    )
    .await;
    assert_eq!(
        independent.load(Ordering::SeqCst),
        1,
        "cleanup pause must not pause local synchronization"
    );
    assert_eq!(
        call(
            &router,
            "PUT",
            "/api/admin/runtime/workers/link-sync",
            Some(&admin.token),
            json!({"enabled":false})
        )
        .await
        .0,
        StatusCode::OK
    );
    let (status, body) = call(
        &router,
        "PUT",
        "/api/admin/runtime/workers/link-schedule",
        Some(&admin.token),
        json!({"enabled":false}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let saved = runtime::settings(&state).await.unwrap();
    assert!(!saved.link_schedule_enabled && !saved.link_enabled && !saved.crawl_enabled);
    assert!(
        !runtime::enabled(&state, runtime::WorkerKind::LinkSchedule)
            .await
            .unwrap()
    );
    assert!(
        !runtime::enabled(&state, runtime::WorkerKind::Links)
            .await
            .unwrap()
    );
    for kind in [
        WorkerKind::LinkSync,
        WorkerKind::LinkCheck,
        WorkerKind::LinkMaintenance,
    ] {
        assert!(!runtime::enabled(&state, kind).await.unwrap());
    }
    let paused_state = Arc::new(AppState::new(pool.clone(), state.redis.clone()));
    let paused_ticks = Arc::new(AtomicUsize::new(0));
    let ticks = paused_ticks.clone();
    let timer_state = paused_state.clone();
    let cancel = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        timer_state.shutdown.cancel();
    });
    runtime::lane(
        &paused_state,
        runtime::WorkerKind::LinkSync,
        "link-sync",
        1,
        || async {
            ticks.fetch_add(1, Ordering::SeqCst);
            Ok(())
        },
    )
    .await;
    cancel.await.unwrap();
    assert_eq!(
        paused_ticks.load(Ordering::SeqCst),
        0,
        "global pause must stop new link batches"
    );
    let (_, paused_monitor) = call(
        &router,
        "GET",
        "/api/monitor",
        Some(&admin.token),
        Value::Null,
    )
    .await;
    assert_eq!(
        paused_monitor["data"]["workers"]["links"]["scheduleEnabled"],
        false
    );
    let (status, _) = call(
        &router,
        "PUT",
        "/api/admin/runtime/workers/link-schedule",
        Some(&admin.token),
        json!({"enabled":true}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        runtime::enabled(&state, runtime::WorkerKind::LinkSchedule)
            .await
            .unwrap()
    );
    assert!(
        !runtime::enabled(&state, runtime::WorkerKind::Links)
            .await
            .unwrap(),
        "resuming scheduling must preserve independent cleanup pause"
    );
    assert!(
        !runtime::enabled(&state, WorkerKind::LinkSync)
            .await
            .unwrap(),
        "total resume preserves independent sync pause"
    );
    assert!(
        runtime::enabled(&state, WorkerKind::LinkCheck)
            .await
            .unwrap()
    );
    assert!(
        runtime::enabled(&state, WorkerKind::LinkMaintenance)
            .await
            .unwrap()
    );
    assert_eq!(
        call(
            &router,
            "PUT",
            "/api/admin/runtime/workers/link-sync",
            Some(&admin.token),
            json!({"enabled":true})
        )
        .await
        .0,
        StatusCode::OK
    );
    let resumed_state = Arc::new(AppState::new(pool.clone(), state.redis.clone()));
    runtime::lane(
        &resumed_state,
        runtime::WorkerKind::LinkSync,
        "link-sync",
        1,
        || async {
            paused_ticks.fetch_add(1, Ordering::SeqCst);
            resumed_state.shutdown.cancel();
            Ok(())
        },
    )
    .await;
    assert_eq!(paused_ticks.load(Ordering::SeqCst), 1);
    let fresh_state = AppState::new(pool.clone(), state.redis.clone());
    assert!(
        !runtime::settings(&fresh_state).await.unwrap().crawl_enabled,
        "pause must survive a new process state"
    );
    let (_, crawl_overview) = call(
        &router,
        "GET",
        "/api/admin/crawl/overview",
        Some(&admin.token),
        Value::Null,
    )
    .await;
    assert_eq!(crawl_overview["data"]["workerEnabled"], false);
    let (status, overview) = call(
        &router,
        "GET",
        "/api/monitor",
        Some(&admin.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{overview}");
    let overview = &overview["data"];
    assert_eq!(overview["workers"]["crawl"]["enabled"], false);
    assert!(overview["crawl"]["review"].is_number());
    assert!(overview["links"]["queues"]["cleanup"]["blocked"].is_number());
    assert!(overview["links"]["deliveryStats"]["fallback"].is_number());
    let sources = overview["sources"].as_array().unwrap();
    assert!(sources.iter().all(|s| s["kind"] == "live"));
    assert!(!sources.iter().any(|s| s["id"] == tg));
    assert_eq!(
        sources.iter().find(|s| s["id"] == live).unwrap()["health"]["healthy"],
        true
    );

    // A paused loop leaves work untouched; resuming through the API starts the same loop.
    let ticks = Arc::new(AtomicUsize::new(0));
    let lane_state = state.clone();
    let lane_ticks = ticks.clone();
    let lane = tokio::spawn(async move {
        runtime::lane(&lane_state, WorkerKind::Crawl, "test", 1, || async {
            lane_ticks.fetch_add(1, Ordering::SeqCst);
            lane_state.shutdown.cancel();
            Ok(())
        })
        .await;
    });
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(ticks.load(Ordering::SeqCst), 0);
    let heartbeat = runtime::Heartbeat::start(state.clone(), WorkerKind::Crawl);
    tokio::time::timeout(Duration::from_secs(3), async {
        while worker_status(&state, WorkerKind::Crawl, false).await["state"] != "online" {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let (_, updated) = call(
        &router,
        "PUT",
        "/api/admin/runtime/workers/crawl",
        Some(&admin.token),
        json!({"enabled":true}),
    )
    .await;
    assert_eq!(
        updated["data"]["settings"]["linkEnabled"], false,
        "one switch must preserve the other"
    );
    tokio::time::timeout(Duration::from_secs(3), lane)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(ticks.load(Ordering::SeqCst), 1);
    heartbeat.finish().await;
    tokio::time::timeout(Duration::from_secs(3), async {
        while worker_status(&state, WorkerKind::Crawl, true).await["state"] != "offline" {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();

    assert_eq!(
        call(
            &router,
            "POST",
            "/api/admin/monitor/reset",
            Some(&admin.token),
            Value::Null
        )
        .await
        .0,
        StatusCode::OK
    );
    assert!(
        !sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM source_health WHERE source_id=$1)"
        )
        .bind(&live)
        .fetch_one(&pool)
        .await
        .unwrap()
    );
    assert!(
        sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM source_health WHERE source_id=$1)"
        )
        .bind(&tg)
        .fetch_one(&pool)
        .await
        .unwrap()
    );
    // Activation is explicit; parameter saves cannot copy a stale enable flag back.
    sqlx::query("UPDATE policy_settings SET value_json=value_json || '{\"enabled\":false}'::jsonb WHERE key='link-check'")
        .execute(&pool).await.unwrap();
    let (status, ordinary_resume) = call(
        &router,
        "PUT",
        "/api/admin/runtime/workers/link-check",
        Some(&admin.token),
        json!({"enabled":true}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(ordinary_resume["data"]["checksEnabled"], false);
    for (endpoint, body) in [
        ("link-check", json!({"enabled":false,"activateChecks":true})),
        ("cleanup", json!({"enabled":true,"activateChecks":true})),
    ] {
        assert_eq!(
            call(
                &router,
                "PUT",
                &format!("/api/admin/runtime/workers/{endpoint}"),
                Some(&admin.token),
                body
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    let before_activation: Value =
        sqlx::query_scalar("SELECT value_json FROM policy_settings WHERE key='link-check'")
            .fetch_one(&pool)
            .await
            .unwrap();
    let (status, activated) = call(
        &router,
        "PUT",
        "/api/admin/runtime/workers/link-check",
        Some(&admin.token),
        json!({"enabled":true,"activateChecks":true}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{activated}");
    assert_eq!(activated["data"]["checksEnabled"], true);
    let after_activation: Value =
        sqlx::query_scalar("SELECT value_json FROM policy_settings WHERE key='link-check'")
            .fetch_one(&pool)
            .await
            .unwrap();
    let mut expected = before_activation;
    expected["enabled"] = json!(true);
    assert_eq!(
        after_activation, expected,
        "activation must preserve budgets and caching parameters"
    );
    assert!(
        !runtime::settings(&state).await.unwrap().link_enabled,
        "activation must not change cleanup pause"
    );
    // Activation above resumed this lane. Establish an independent pause
    // before asserting that a provider-policy save preserves it.
    let (status, paused) = call(
        &router,
        "PUT",
        "/api/admin/runtime/workers/link-check",
        Some(&admin.token),
        json!({"enabled":false}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{paused}");
    assert!(!runtime::settings(&state).await.unwrap().link_check_enabled);
    // Per-provider policy lives in its own row and must never touch worker switches.
    let provider_policy = json!({
        "enabled": false,
        "targetDir": null,
        "targetDirName": "",
        "retentionSeconds": null,
        "deliveryMinRemainingSeconds": 300,
        "platformShareDays": 7,
        "checkIntervalSeconds": 5,
        "checkValidSeconds": 900,
        "checkInvalidSeconds": 3600,
        "checkDailyBudget": 500,
        "revision": 1
    });
    let (status, saved) = call(
        &router,
        "PUT",
        "/api/settings/cloud-providers/quark",
        Some(&admin.token),
        provider_policy,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["data"]["checkDailyBudget"], 500);
    assert_eq!(saved["data"]["revision"], 2);
    assert!(
        !runtime::settings(&state).await.unwrap().link_check_enabled,
        "saving provider policy must not resume an independent pause"
    );
    // Detection parameters and delivery directories are still validated.
    assert_eq!(
        call(
            &router,
            "PUT",
            "/api/settings/cloud-providers/quark",
            Some(&admin.token),
            json!({"checkIntervalSeconds": 1})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(
            &router,
            "PUT",
            "/api/settings/cloud-providers/quark",
            Some(&admin.token),
            json!({"enabled": true, "targetDir": "/", "retentionSeconds": 86400, "deliveryMinRemainingSeconds": 300, "platformShareDays": 7})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    // Clearing the delivery half keeps the detection parameters and the row.
    let (status, cleared) = call(
        &router,
        "DELETE",
        "/api/settings/cloud-providers/quark/delivery",
        Some(&admin.token),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{cleared}");
    assert_eq!(cleared["data"]["enabled"], false);
    assert_eq!(cleared["data"]["checkDailyBudget"], 500);
    let policy: Value = sqlx::query_scalar(
        "DELETE FROM policy_settings WHERE key='link-check' RETURNING value_json",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        call(
            &router,
            "PUT",
            "/api/admin/runtime/workers/link-check",
            Some(&admin.token),
            json!({"enabled":true,"activateChecks":true})
        )
        .await
        .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert!(
        !runtime::settings(&state).await.unwrap().link_check_enabled,
        "failed activation must roll back the lane update"
    );
    sqlx::query("INSERT INTO policy_settings(key,value_json) VALUES('link-check',$1)")
        .bind(policy)
        .execute(&pool)
        .await
        .unwrap();
}
