use super::*;
#[test]
fn query_validation_is_category_specific() {
    assert!(
        validate(
            "sync",
            &TaskQuery {
                status: Some("failed".into()),
                ..Default::default()
            }
        )
        .is_err()
    );
    assert!(
        validate(
            "maintenance",
            &TaskQuery {
                provider: Some("quark".into()),
                ..Default::default()
            }
        )
        .is_err()
    );
    assert!(
        validate(
            "checks",
            &TaskQuery {
                before: Some("bad".into()),
                ..Default::default()
            }
        )
        .is_err()
    );
    assert!(validate("unknown", &TaskQuery::default()).is_err());
    assert!(validate("resolve", &TaskQuery::default()).is_ok());
    for page in [0, -1, 100001] {
        assert!(
            validate(
                "checks",
                &TaskQuery {
                    page: Some(page),
                    ..Default::default()
                }
            )
            .is_err()
        );
    }
    for page_size in [0, -1, 11, 51] {
        assert!(
            validate(
                "checks",
                &TaskQuery {
                    page_size: Some(page_size),
                    ..Default::default()
                }
            )
            .is_err()
        );
    }
    for page_size in [10, 20, 30, 50] {
        assert!(
            validate(
                "checks",
                &TaskQuery {
                    page: Some(2),
                    page_size: Some(page_size),
                    ..Default::default()
                }
            )
            .is_ok()
        );
    }
}

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test"]
async fn check_task_queries_match_reference_with_overlaps_and_stale_providers() {
    let database = std::env::var("PANSOU_TEST_DATABASE_URL").unwrap();
    assert!(
        url::Url::parse(&database)
            .unwrap()
            .path()
            .ends_with("_test")
    );
    let pool = crate::db::connect(&database).await.unwrap();
    crate::db::init_db(&pool).await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    // Distinct links permit every combination without violating active-job
    // uniqueness. Overlapping attention reasons and equal timestamps are
    // intentional; neither may duplicate rows or destabilize pagination.
    for provider in ["quark", "baidu"] {
        for status in ["queued", "running", "completed", "failed"] {
            for kind in ["original", "reshared"] {
                for lease in [None, Some(-60_i64), Some(0), Some(3600)] {
                    let link = Uuid::new_v4();
                    let failed = kind == "original" && lease != Some(3600);
                    sqlx::query("INSERT INTO link_catalog(id,provider,identity,original_url,input_fingerprint,failure_count) VALUES($1,$2,$3,'https://example.invalid/test',$3,$4)")
                        .bind(link).bind(provider).bind(link.to_string()).bind(i32::from(failed))
                        .execute(&mut *tx).await.unwrap();
                    let cache = if kind == "reshared" {
                        let id = Uuid::new_v4();
                        sqlx::query("INSERT INTO link_share_cache(id,link_id,input_version,target_account_key,account_revision,policy_revision,target_dir,state,retention_seconds,cleanup_after) VALUES($1,$2,1,'test',1,1,'test','deleted',60,now())")
                            .bind(id).bind(link).execute(&mut *tx).await.unwrap();
                        Some(id)
                    } else {
                        None
                    };
                    sqlx::query("INSERT INTO link_check_jobs(link_id,input_version,kind,share_cache_id,status,lease_until,created_at) VALUES($1,1,$2,$3,$4,now()+$5::bigint*interval '1 second','2026-01-01'::timestamptz)")
                        .bind(link).bind(kind).bind(cache).bind(status).bind(lease)
                        .execute(&mut *tx).await.unwrap();
                    // Provider edits legitimately leave historical/running
                    // queue snapshots stale. Filtering must still use c.
                    sqlx::query("UPDATE link_catalog SET provider=$2 WHERE id=$1")
                        .bind(link)
                        .bind(if provider == "quark" {
                            "baidu"
                        } else {
                            "quark"
                        })
                        .execute(&mut *tx)
                        .await
                        .unwrap();
                }
            }
        }
    }
    let stale: i64 = sqlx::query_scalar("SELECT count(*) FROM link_check_jobs j JOIN link_catalog c ON c.id=j.link_id WHERE j.provider<>c.provider")
        .fetch_one(&mut *tx).await.unwrap();
    assert!(stale > 0);
    let projection = "'id',j.id::text,'createdAt',j.created_at,'provider',c.provider,'status',j.status,'kind',j.kind";
    for mode in ["force_custom_plan", "force_generic_plan"] {
        sqlx::query(&format!("SET LOCAL plan_cache_mode='{mode}'"))
            .execute(&mut *tx)
            .await
            .unwrap();
        for provider in ["", "quark", "baidu", "uc"] {
            for status in [
                "all",
                "attention",
                "queued",
                "running",
                "completed",
                "failed",
            ] {
                let reference: Vec<Value> = sqlx::query_scalar(&format!(
                    "SELECT jsonb_build_object({projection}) FROM link_check_jobs j JOIN link_catalog c ON c.id=j.link_id WHERE ($1='' OR c.provider=$1) AND ($2='all' OR $2='attention' AND (j.status='failed' OR c.failure_count>0 OR j.status='running' AND j.lease_until<=now()) OR j.status=$2) ORDER BY j.created_at DESC,j.id DESC"))
                    .bind(provider).bind(status).fetch_all(&mut *tx).await.unwrap();
                let mut q = TaskQuery {
                    provider: Some(provider.into()),
                    status: Some(status.into()),
                    page_size: Some(10),
                    ..Default::default()
                };
                for page in [1, 2, 100] {
                    q.page = Some(page);
                    let (total, actual) = check_task_page(&mut tx, &q, None, projection)
                        .await
                        .unwrap();
                    let expected: Vec<Value> = reference
                        .iter()
                        .skip(((page - 1) * 10) as usize)
                        .take(11)
                        .cloned()
                        .collect();
                    assert_eq!(total, reference.len() as i64, "{mode}/{provider}/{status}");
                    assert_eq!(actual, expected, "{mode}/{provider}/{status}/page={page}");
                }
                if let Some(last) = reference.get(9) {
                    q.page = None;
                    let cursor = Cursor {
                        kind: "checks".into(),
                        at: serde_json::from_value(last["createdAt"].clone()).unwrap(),
                        id: last["id"].as_str().unwrap().into(),
                    };
                    let (total, actual) =
                        check_task_page(&mut tx, &q, Some(&cursor), projection)
                            .await
                            .unwrap();
                    assert_eq!(total, reference.len() as i64);
                    assert_eq!(
                        actual,
                        reference
                            .iter()
                            .skip(10)
                            .take(11)
                            .cloned()
                            .collect::<Vec<_>>()
                    );
                }
            }
        }
    }
    tx.rollback().await.unwrap();
}

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test and PANSOU_TEST_REDIS_URL"]
async fn task_center_lists_filters_paginates_and_fences_rechecks() {
    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;
    async fn call(
        router: &axum::Router,
        method: &str,
        path: &str,
        token: Option<&str>,
    ) -> (StatusCode, Value) {
        let mut r = Request::builder().method(method).uri(path);
        if let Some(t) = token {
            r = r.header("authorization", format!("Bearer {t}"));
        }
        let out = router
            .clone()
            .oneshot(r.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let code = out.status();
        let body = to_bytes(out.into_body(), 1024 * 1024).await.unwrap();
        (code, serde_json::from_slice(&body).unwrap())
    }
    let database = std::env::var("PANSOU_TEST_DATABASE_URL").unwrap();
    assert!(
        url::Url::parse(&database)
            .unwrap()
            .path()
            .ends_with("_test")
    );
    let redis_url = std::env::var("PANSOU_TEST_REDIS_URL").unwrap();
    assert!(!matches!(
        url::Url::parse(&redis_url).unwrap().path(),
        "" | "/" | "/0"
    ));
    let pool = crate::db::connect(&database).await.unwrap();
    crate::db::init_db(&pool).await.unwrap();
    let state = Arc::new(AppState::new(
        pool.clone(),
        crate::redis_store::RedisStore::connect(&redis_url)
            .await
            .unwrap(),
    ));
    let router = crate::app::build_router(state.clone());
    let unique = Uuid::new_v4().simple().to_string();
    let username = format!("tasks_{unique}");
    let admin:i64=sqlx::query_scalar("INSERT INTO users(username,username_normalized,password_hash,role) VALUES($1,$1,$2,'admin') RETURNING id")
        .bind(&username).bind(crate::auth::hash_password(&unique).unwrap()).fetch_one(&pool).await.unwrap();
    let (session, _) = state.auth().login(&username, &unique).await.unwrap();
    let token = Some(session.token.as_str());
    let member = format!("member_{unique}");
    sqlx::query("INSERT INTO users(username,username_normalized,password_hash,role) VALUES($1,$1,$2,'user')").bind(&member).bind(crate::auth::hash_password(&unique).unwrap()).execute(&pool).await.unwrap();
    let (member_session, _) = state.auth().login(&member, &unique).await.unwrap();
    assert_eq!(
        call(
            &router,
            "GET",
            "/api/admin/tasks/checks",
            Some(&member_session.token)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    for kind in [
        "crawl",
        "sync",
        "checks",
        "resolve",
        "operations",
        "maintenance",
    ] {
        assert_eq!(
            call(&router, "GET", &format!("/api/admin/tasks/{kind}"), None)
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
    }
    let channel = format!("tasks_{}", &unique[..16]);
    sqlx::query("INSERT INTO crawl_channels(id) VALUES($1)")
        .bind(&channel)
        .execute(&pool)
        .await
        .unwrap();
    let crawl:i64=sqlx::query_scalar("INSERT INTO crawl_jobs(channel_id,kind,status,last_error) VALUES($1,'sync','failed','credential=DO_NOT_EXPOSE') RETURNING id").bind(&channel).fetch_one(&pool).await.unwrap();
    let resource = format!("task-resource-{unique}");
    sqlx::query("INSERT INTO managed_resources(id,name) VALUES($1,'任务中心模拟资源')")
        .bind(&resource)
        .execute(&pool)
        .await
        .unwrap();
    let link = Uuid::new_v4();
    sqlx::query("INSERT INTO link_catalog(id,provider,identity,original_url,input_fingerprint,next_check_at,failure_count,last_error_code) VALUES($1,'quark',$2,'https://pan.quark.cn/s/test',$2,now(),1,'check_failed')")
        .bind(link).bind(&unique).execute(&pool).await.unwrap();
    let check:i64=sqlx::query_scalar("INSERT INTO link_check_jobs(link_id,input_version,kind) VALUES($1,1,'original') RETURNING id").bind(link).fetch_one(&pool).await.unwrap();
    sqlx::query("INSERT INTO link_resolve_requests(id,request_key,subject_key,request_fingerprint,link_id,authorization_json,status,delivery,reason_code,response_json,deadline_at) VALUES($1,$2,'private-subject',$3,$4,'{\"credential\":\"DO_NOT_EXPOSE\"}','completed','original','deadline_exceeded','{\"cookie\":\"DO_NOT_EXPOSE\"}',now())")
        .bind(Uuid::new_v4()).bind(Uuid::new_v4()).bind(&unique).bind(link).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO cloud_drive_operations(request_key,actor_id,provider,action,fingerprint,expires_at) VALUES($1,$2,'quark','save','DO_NOT_EXPOSE',now()-interval '1 second')")
        .bind(Uuid::new_v4()).bind(admin).execute(&pool).await.unwrap();
    crate::runtime::record_lane_run(
        &state,
        "link-sync",
        std::time::Duration::from_millis(12),
        &Err(ApiError::Upstream("DO_NOT_EXPOSE".into())),
    )
    .await;
    crate::runtime::record_lane_run(
        &state,
        "link-maintenance",
        std::time::Duration::from_millis(4),
        &Ok(()),
    )
    .await;
    let lane = format!("fixture-{unique}");
    for _ in 0..2 {
        crate::runtime::record_lane_run(
            &state,
            &lane,
            std::time::Duration::from_millis(1),
            &Err(ApiError::Upstream("DO_NOT_EXPOSE".into())),
        )
        .await;
    }
    let logged: i64 = sqlx::query_scalar("SELECT count(*) FROM worker_task_runs WHERE lane=$1")
        .bind(&lane)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(logged, 1);
    crate::runtime::record_lane_run(
        &state,
        &lane,
        std::time::Duration::from_millis(1),
        &Ok(()),
    )
    .await;
    let logged: i64 = sqlx::query_scalar("SELECT count(*) FROM worker_task_runs WHERE lane=$1")
        .bind(&lane)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(logged, 1);
    sqlx::query("INSERT INTO worker_task_runs(lane,status,duration_ms,created_at) VALUES($1,'failed',1,now()-interval '8 days')").bind(&lane).execute(&pool).await.unwrap();
    crate::runtime::record_lane_run(
        &state,
        "link-maintenance",
        std::time::Duration::from_millis(1),
        &Ok(()),
    )
    .await;
    let old:i64=sqlx::query_scalar("SELECT count(*) FROM worker_task_runs WHERE lane=$1 AND created_at<now()-interval '7 days'").bind(&lane).fetch_one(&pool).await.unwrap();
    assert_eq!(old, 0);
    for kind in [
        "crawl",
        "sync",
        "checks",
        "resolve",
        "operations",
        "maintenance",
    ] {
        let (code, out) =
            call(&router, "GET", &format!("/api/admin/tasks/{kind}"), token).await;
        assert_eq!(code, StatusCode::OK, "{kind}: {out}");
        assert!(
            !out["data"]["items"].as_array().unwrap().is_empty(),
            "{kind}"
        );
        let body = out.to_string();
        assert!(!body.contains("DO_NOT_EXPOSE"));
        assert!(!body.contains("authorization_json"));
        assert!(!body.contains("subject_key"));
    }
    let (_, out) = call(
        &router,
        "GET",
        "/api/admin/tasks/operations?status=uncertain",
        token,
    )
    .await;
    assert_eq!(out["data"]["items"][0]["status"], "uncertain");
    for path in [
        "/api/admin/tasks/unknown",
        "/api/admin/tasks/checks?provider=evil",
        "/api/admin/tasks/sync?status=failed",
        "/api/admin/tasks/resolve?before=bad",
    ] {
        assert_eq!(
            call(&router, "GET", path, token).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    let retry = format!("/api/admin/tasks/checks/{check}/retry");
    assert_eq!(
        call(&router, "POST", &retry, None).await.0,
        StatusCode::UNAUTHORIZED
    );
    sqlx::query("UPDATE policy_settings SET value_json=jsonb_set(value_json,'{enabled}','false') WHERE key='link-check'").execute(&pool).await.unwrap();
    assert_eq!(
        call(&router, "POST", &retry, token).await.0,
        StatusCode::CONFLICT
    );
    sqlx::query("UPDATE policy_settings SET value_json=jsonb_set(value_json,'{enabled}','true') WHERE key='link-check'").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO cloud_account_settings(provider,credential) VALUES('quark','') ON CONFLICT(provider) DO UPDATE SET credential='' ").execute(&pool).await.unwrap();
    assert_eq!(
        call(&router, "POST", &retry, token).await.0,
        StatusCode::CONFLICT
    );
    sqlx::query(
        "UPDATE cloud_account_settings SET credential='synthetic-only' WHERE provider='quark'",
    )
    .execute(&pool)
    .await
    .unwrap();
    let lease = Uuid::new_v4();
    sqlx::query("UPDATE link_check_jobs SET status='running',lease_token=$2,lease_until=now()+interval '1 minute' WHERE id=$1").bind(check).bind(lease).execute(&pool).await.unwrap();
    assert_eq!(
        call(&router, "POST", &retry, token).await.0,
        StatusCode::CONFLICT
    );
    sqlx::query("UPDATE link_check_jobs SET lease_until=NULL WHERE id=$1")
        .bind(check)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        call(&router, "POST", &retry, token).await.0,
        StatusCode::CONFLICT
    );
    sqlx::query("UPDATE link_check_jobs SET lease_until=now()-interval '1 second' WHERE id=$1")
        .bind(check)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(call(&router, "POST", &retry, token).await.0, StatusCode::OK);
    assert_eq!(call(&router, "POST", &retry, token).await.0, StatusCode::OK);
    let row =
        sqlx::query("SELECT status,lease_token,priority FROM link_check_jobs WHERE id=$1")
            .bind(check)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(row.get::<String, _>("status"), "queued");
    assert!(row.get::<Option<Uuid>, _>("lease_token").is_none());
    assert_eq!(row.get::<i32, _>("priority"), 10);
    let n:i64=sqlx::query_scalar("SELECT count(*) FROM link_check_jobs WHERE link_id=$1 AND status IN('queued','running')").bind(link).fetch_one(&pool).await.unwrap();
    assert_eq!(n, 1);
    assert_eq!(
        call(
            &router,
            "POST",
            &format!("/api/admin/crawl/jobs/{crawl}/retry"),
            token
        )
        .await
        .0,
        StatusCode::OK
    );
    for _ in 0..32 {
        sqlx::query("INSERT INTO link_check_jobs(link_id,input_version,kind,status) VALUES($1,1,'original','completed')").bind(link).execute(&pool).await.unwrap();
    }
    let (_, page) = call(
        &router,
        "GET",
        "/api/admin/tasks/checks?provider=quark",
        token,
    )
    .await;
    assert_eq!(page["data"]["items"].as_array().unwrap().len(), 30);
    assert_eq!(page["data"]["hasMore"], true);
    let total = page["data"]["total"].as_i64().unwrap();
    assert!(total > 30);
    let cache = Uuid::new_v4();
    sqlx::query("INSERT INTO link_share_cache(id,link_id,input_version,target_account_key,account_revision,policy_revision,target_dir,state,retention_seconds,cleanup_after) VALUES($1,$2,1,'fixture-account',1,1,'fixture-dir','deleted',60,now())")
        .bind(cache).bind(link).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO link_cleanup_jobs(share_cache_id,status,run_after) SELECT $1,'completed',now() FROM generate_series(1,65)")
        .bind(cache).execute(&pool).await.unwrap();
    for (endpoint, total) in [("tasks/checks", total), ("link-cleanup", 65)] {
        for page_size in [10, 20, 50] {
            let mut ids = Vec::new();
            for number in 1..=(total + page_size - 1) / page_size {
                let (code, numbered) = call(&router, "GET", &format!("/api/admin/{endpoint}?status=all&provider=quark&page={number}&pageSize={page_size}"), token).await;
                assert_eq!(code, StatusCode::OK);
                assert_eq!(numbered["data"]["total"], total);
                assert_eq!(numbered["data"]["page"], number);
                assert_eq!(numbered["data"]["pageSize"], page_size);
                let rows = numbered["data"]["items"].as_array().unwrap();
                assert_eq!(
                    rows.len() as i64,
                    page_size.min(total - (number - 1) * page_size)
                );
                for row in rows {
                    let id = row["id"].to_string();
                    assert!(!ids.contains(&id));
                    ids.push(id);
                }
            }
            assert_eq!(ids.len() as i64, total);
        }
        let (code, empty) = call(
            &router,
            "GET",
            &format!("/api/admin/{endpoint}?status=all&provider=quark&page=100&pageSize=10"),
            token,
        )
        .await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(empty["data"]["total"], total);
        assert!(empty["data"]["items"].as_array().unwrap().is_empty());
        let (code, filtered) = call(
            &router,
            "GET",
            &format!("/api/admin/{endpoint}?status=all&provider=baidu&page=1&pageSize=10"),
            token,
        )
        .await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(filtered["data"]["total"], 0);
        assert!(filtered["data"]["items"].as_array().unwrap().is_empty());
    }
    let before = page["data"]["nextCursor"].as_str().unwrap();
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("before", before)
        .finish();
    let (code, next) = call(
        &router,
        "GET",
        &format!("/api/admin/tasks/checks?{query}"),
        token,
    )
    .await;
    assert_eq!(code, StatusCode::OK);
    assert!(!next["data"]["items"].as_array().unwrap().is_empty());
    for a in page["data"]["items"].as_array().unwrap() {
        assert!(
            !next["data"]["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|b| a["id"] == b["id"])
        );
    }
    assert_eq!(
        call(
            &router,
            "GET",
            &format!("/api/admin/tasks/crawl?{query}"),
            token
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
}
