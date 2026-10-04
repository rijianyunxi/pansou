use super::*;

async fn state() -> AppState {
    let database = std::env::var("PANSOU_TEST_DATABASE_URL").unwrap();
    assert!(
        url::Url::parse(&database)
            .unwrap()
            .path()
            .ends_with("_test")
    );
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(16)
        .connect(&database)
        .await
        .unwrap();
    crate::db::init_db(&pool).await.unwrap();
    AppState::new(pool, crate::redis_store::RedisStore::disconnected())
}

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test"]
async fn checks_and_sync_do_not_wait_for_crawl_and_blocked_aggregates_are_durable() {
    let state = state().await;
    let link = Link {
        r#type: "quark".into(),
        url: format!("https://pan.quark.cn/s/{}", Uuid::new_v4().simple()),
        password: None,
    };
    let resource = format!("concurrency-{}", Uuid::new_v4());
    crate::resource_links::fixture(&state.pool, &resource, "concurrency fixture", json!([link]))
        .await;
    let link_id = owned_id(&state, &resource, &link).await.unwrap();
    let mut index = state.pool.begin().await.unwrap();
    crate::crawl::lock_index(&mut index).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        record(
            &state,
            link_id,
            &json!({"status":"valid"}),
            &ProviderPolicy::default(),
        )
        .await
        .unwrap();
    })
    .await
    .expect("link work must not acquire the crawl revision lock");
    index.rollback().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i16>("SELECT link_validity FROM managed_resources WHERE id=$1")
            .bind(&resource)
            .fetch_one(&state.pool)
            .await
            .unwrap(),
        1
    );

    let mut edit = state.pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM managed_resources WHERE id=$1 FOR NO KEY UPDATE")
        .bind(&resource)
        .fetch_one(&mut *edit)
        .await
        .unwrap();
    tokio::time::timeout(
        Duration::from_secs(3),
        record(
            &state,
            link_id,
            &json!({"status":"invalid"}),
            &ProviderPolicy::default(),
        ),
    )
    .await
    .expect("a locked resource must not block observation persistence")
    .unwrap();
    assert!(
        sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM link_aggregate_queue WHERE resource_id=$1)"
        )
        .bind(&resource)
        .fetch_one(&state.pool)
        .await
        .unwrap()
    );
    edit.rollback().await.unwrap();
    refresh_pending_aggregates(&state).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i16>("SELECT link_validity FROM managed_resources WHERE id=$1")
            .bind(&resource)
            .fetch_one(&state.pool)
            .await
            .unwrap(),
        0
    );
    assert!(
        !sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM link_aggregate_queue WHERE resource_id=$1)"
        )
        .bind(&resource)
        .fetch_one(&state.pool)
        .await
        .unwrap()
    );
}

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test"]
async fn one_schedule_reservation_and_concurrent_observations_converge() {
    let state = state().await;
    let task = format!("test-{}", Uuid::new_v4());
    let (one, two) = tokio::join!(
        crate::runtime::schedule_slot(&state, &task, 30),
        crate::runtime::schedule_slot(&state, &task, 30)
    );
    assert_ne!(one.unwrap(), two.unwrap());
    let links: Vec<Link> = (0..2)
        .map(|_| Link {
            r#type: "quark".into(),
            url: format!("https://pan.quark.cn/s/{}", Uuid::new_v4().simple()),
            password: None,
        })
        .collect();
    let resource = format!("parallel-{}", Uuid::new_v4());
    crate::resource_links::fixture(&state.pool, &resource, "parallel fixture", json!(links)).await;
    let left = owned_id(&state, &resource, &links[0]).await.unwrap();
    let right = owned_id(&state, &resource, &links[1]).await.unwrap();
    let policy = ProviderPolicy::default();
    let valid = json!({"status":"valid"});
    let invalid = json!({"status":"invalid"});
    for _ in 0..10 {
        tokio::time::timeout(Duration::from_secs(3), async {
            let (a, b) = tokio::join!(
                record(&state, left, &valid, &policy),
                record(&state, right, &invalid, &policy)
            );
            a.unwrap();
            b.unwrap();
        })
        .await
        .unwrap();
    }
    refresh_pending_aggregates(&state).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i16>("SELECT link_validity FROM managed_resources WHERE id=$1")
            .bind(&resource)
            .fetch_one(&state.pool)
            .await
            .unwrap(),
        1
    );
}

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test"]
async fn a_panicking_lane_does_not_cancel_a_sibling_and_records_failure() {
    let state = state().await;
    *state.worker_settings.lock().await = Some((
        std::time::Instant::now(),
        crate::runtime::WorkerSettings::default(),
    ));
    let name = format!("panic-fixture-{}", Uuid::new_v4());
    let panic_name = name.clone();
    let panics = std::sync::atomic::AtomicUsize::new(0);
    let sibling_ran = std::sync::atomic::AtomicBool::new(false);
    tokio::join!(
        crate::runtime::lane(
            &state,
            crate::runtime::WorkerKind::LinkMaintenance,
            &panic_name,
            1,
            || async {
                panics.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                panic!("fixture panic");
                #[allow(unreachable_code)]
                Ok::<usize, ApiError>(0)
            }
        ),
        async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            sibling_ran.store(true, std::sync::atomic::Ordering::SeqCst);
            state.shutdown.cancel();
        }
    );
    assert_eq!(panics.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert!(sibling_ran.load(std::sync::atomic::Ordering::SeqCst));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT failures FROM worker_lane_metrics WHERE lane=$1")
            .bind(name)
            .fetch_one(&state.pool)
            .await
            .unwrap(),
        1
    );
}

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test"]
async fn expiry_drains_multiple_pages_and_retires_only_undelivered_artifacts() {
    let state = state().await;
    let link = Link {
        r#type: "quark".into(),
        url: format!("https://pan.quark.cn/s/{}", Uuid::new_v4().simple()),
        password: None,
    };
    let link_id = register(&state, &link).await.unwrap();
    let subject = format!("expiry-{}", Uuid::new_v4());
    let keys: Vec<Uuid> = (0..205).map(|_| Uuid::new_v4()).collect();
    // Malformed snapshots must complete safely rather than pinning LIMIT 100.
    sqlx::query("INSERT INTO link_resolve_requests(id,request_key,subject_key,request_fingerprint,link_id,authorization_json,status,deadline_at) SELECT key,key,$1,key::text,$2,'{}'::jsonb,'running',now()-interval '100 days' FROM unnest($3::uuid[]) key")
        .bind(&subject).bind(link_id).bind(&keys).execute(&state.pool).await.unwrap();
    let authorization = json!({"linkRef":"link","snapshot":{"links":{"link":link}}});
    sqlx::query("UPDATE link_resolve_requests SET authorization_json=$2 WHERE request_key=ANY($1)")
        .bind(&keys[..2])
        .bind(authorization)
        .execute(&state.pool)
        .await
        .unwrap();
    let shares = [Uuid::new_v4(), Uuid::new_v4()];
    for index in 0..2 {
        sqlx::query("INSERT INTO link_share_cache(id,link_id,input_version,target_account_key,account_revision,policy_revision,target_dir,state,retention_seconds,cleanup_after,share_url,ownership_manifest_json) VALUES($1,$2,1,$3,1,1,'fixture','ready',86400,now()+interval '1 day','https://pan.quark.cn/s/owned',$4)")
            .bind(shares[index]).bind(link_id).bind(format!("account-{index}"))
            .bind(json!({"writerRequestKey":keys[index],"everDelivered":index==1,"stage":"ready"}))
            .execute(&state.pool).await.unwrap();
        sqlx::query("INSERT INTO link_cleanup_jobs(share_cache_id,run_after) VALUES($1,now()+interval '1 day')")
            .bind(shares[index]).execute(&state.pool).await.unwrap();
        sqlx::query("UPDATE link_resolve_requests SET share_cache_id=$2 WHERE request_key=$1")
            .bind(keys[index])
            .bind(shares[index])
            .execute(&state.pool)
            .await
            .unwrap();
    }
    let mut drained = false;
    for _ in 0..10 {
        if housekeeping(&state).await.unwrap() < 100 {
            drained = true;
            break;
        }
    }
    assert!(drained);
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM link_resolve_requests WHERE subject_key=$1 AND status='completed'"
        )
        .bind(&subject)
        .fetch_one(&state.pool)
        .await
        .unwrap(),
        205
    );
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM link_resolve_requests WHERE subject_key=$1 AND response_json->>'reasonCode'='authorization_unavailable'").bind(&subject).fetch_one(&state.pool).await.unwrap(),203);
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT state FROM link_share_cache WHERE id=$1")
            .bind(shares[0])
            .fetch_one(&state.pool)
            .await
            .unwrap(),
        "expiring"
    );
    assert!(
        sqlx::query_scalar::<_, bool>(
            "SELECT run_after<=now() FROM link_cleanup_jobs WHERE share_cache_id=$1"
        )
        .bind(shares[0])
        .fetch_one(&state.pool)
        .await
        .unwrap()
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT state FROM link_share_cache WHERE id=$1")
            .bind(shares[1])
            .fetch_one(&state.pool)
            .await
            .unwrap(),
        "ready"
    );
    assert!(
        sqlx::query_scalar::<_, bool>(
            "SELECT run_after>now() FROM link_cleanup_jobs WHERE share_cache_id=$1"
        )
        .bind(shares[1])
        .fetch_one(&state.pool)
        .await
        .unwrap()
    );
}

#[test]
fn check_errors_preserve_auth_and_rate_limit_without_inventing_infrastructure_observations() {
    assert_eq!(
        check_error_value(&ApiError::CloudAuthRequired("expired".into())).unwrap()["errorKind"],
        "login"
    );
    assert_eq!(
        check_error_value(&ApiError::TooManyRequests("limited".into())).unwrap()["errorKind"],
        "rateLimit"
    );
    assert!(check_error_value(&ApiError::Internal("db".into())).is_none());
    assert!(check_error_value(&ApiError::Unavailable("redis".into())).is_none());
}

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test"]
async fn slow_provider_does_not_hold_back_a_siblings_next_check() {
    let state = state().await;
    *state.worker_settings.lock().await = Some((
        std::time::Instant::now(),
        crate::runtime::WorkerSettings::default(),
    ));
    *state.link_check_settings.lock().await = Some((std::time::Instant::now(), (false, vec![])));
    let blocked = tokio::sync::Notify::new();
    let release = tokio::sync::Notify::new();
    let fast = std::sync::atomic::AtomicUsize::new(0);
    let loops = provider_lanes(&state, |provider| {
        let blocked = &blocked;
        let release = &release;
        let fast = &fast;
        async move {
            if provider == "baidu" {
                blocked.notify_one();
                release.notified().await;
            }
            if provider == "quark" {
                fast.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
            Ok(1)
        }
    });
    let verify = async {
        blocked.notified().await;
        tokio::time::timeout(Duration::from_secs(3), async {
            while fast.load(std::sync::atomic::Ordering::SeqCst) < 3 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("fast provider must run multiple ticks while slow provider is pending");
        state.shutdown.cancel();
        release.notify_one();
    };
    tokio::join!(loops, verify);
}

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test"]
async fn redis_failure_requeues_check_without_overwriting_validity() {
    let state = state().await;
    // Keep the fixture ahead of any jobs left by other integration tests.
    sqlx::query("UPDATE link_check_jobs SET run_after=now()+interval '1 day' WHERE provider='quark' AND status='queued'")
        .execute(&state.pool).await.unwrap();
    let link = Link {
        r#type: "quark".into(),
        url: format!("https://pan.quark.cn/s/{}", Uuid::new_v4().simple()),
        password: None,
    };
    let id = register(&state, &link).await.unwrap();
    sqlx::query("UPDATE resource_links SET validity=1,valid_until=now()+interval '1 day',next_check_at=now() WHERE id=$1")
        .bind(id).execute(&state.pool).await.unwrap();
    let job: i64 = sqlx::query_scalar("INSERT INTO link_check_jobs(link_id,input_version,kind,priority,run_after) VALUES($1,1,'original',10,now()-interval '1 day') ON CONFLICT(link_id,input_version) WHERE kind='original' AND status IN('queued','running') DO UPDATE SET run_after=excluded.run_after,priority=10 RETURNING id")
        .bind(id).fetch_one(&state.pool).await.unwrap();
    assert!(matches!(
        check_provider(&state, "quark".into()).await,
        Err(ApiError::Unavailable(_) | ApiError::Internal(_))
    ));
    let row = sqlx::query("SELECT j.status,j.lease_token,j.run_after>now() AS postponed,c.validity,c.failure_count FROM link_check_jobs j JOIN resource_links c ON c.id=j.link_id WHERE j.id=$1")
        .bind(job).fetch_one(&state.pool).await.unwrap();
    assert_eq!(row.get::<String, _>("status"), "queued");
    assert!(row.get::<Option<Uuid>, _>("lease_token").is_none());
    assert!(row.get::<bool, _>("postponed"));
    assert_eq!(row.get::<i16, _>("validity"), 1);
    assert_eq!(row.get::<i32, _>("failure_count"), 0);
}

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test"]
async fn cleanup_batch_claims_only_four_and_rechecks_retention() {
    let state = state().await;
    sqlx::query(
        "UPDATE link_cleanup_jobs SET run_after=now()+interval '1 day' WHERE status='queued'",
    )
    .execute(&state.pool)
    .await
    .unwrap();
    let mut jobs = Vec::new();
    for _ in 0..5 {
        let link = Link {
            r#type: "quark".into(),
            url: format!("https://pan.quark.cn/s/{}", Uuid::new_v4().simple()),
            password: None,
        };
        let id = register(&state, &link).await.unwrap();
        let share = Uuid::new_v4();
        sqlx::query("INSERT INTO link_share_cache(id,link_id,input_version,target_account_key,account_revision,policy_revision,target_dir,state,retention_seconds,cleanup_after) VALUES($1,$2,1,'fixture',1,1,'fixture','saved',3600,now()+interval '1 hour')")
            .bind(share).bind(id).execute(&state.pool).await.unwrap();
        let job: i64 = sqlx::query_scalar("INSERT INTO link_cleanup_jobs(share_cache_id,run_after) VALUES($1,now()-interval '1 day') RETURNING id")
            .bind(share).fetch_one(&state.pool).await.unwrap();
        jobs.push(job);
    }
    assert_eq!(delivery::cleanup_batch(&state).await.unwrap(), 4);
    let postponed: i64 = sqlx::query_scalar("SELECT count(*) FROM link_cleanup_jobs WHERE id=ANY($1) AND status='queued' AND run_after>now() AND attempts=0")
        .bind(&jobs).fetch_one(&state.pool).await.unwrap();
    assert_eq!(postponed, 4);
    let due: i64 = sqlx::query_scalar("SELECT count(*) FROM link_cleanup_jobs WHERE id=ANY($1) AND status='queued' AND run_after<=now()")
        .bind(&jobs).fetch_one(&state.pool).await.unwrap();
    assert_eq!(due, 1);
    sqlx::query("DELETE FROM link_cleanup_jobs WHERE id=ANY($1)")
        .bind(&jobs)
        .execute(&state.pool)
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test"]
async fn leased_check_defers_projection_to_durable_consumers() {
    let state = state().await;
    let link = Link {
        r#type: "quark".into(),
        url: format!("https://pan.quark.cn/s/{}", Uuid::new_v4().simple()),
        password: None,
    };
    let resource = format!("deferred-{}", Uuid::new_v4());
    crate::resource_links::fixture(&state.pool, &resource, "deferred fixture", json!([link])).await;
    let id = owned_id(&state, &resource, &link).await.unwrap();
    let token = Uuid::new_v4();
    let job: i64 = sqlx::query_scalar("INSERT INTO link_check_jobs(link_id,input_version,kind,status,lease_token,lease_until) VALUES($1,1,'original','running',$2,now()+interval '90 seconds') ON CONFLICT(link_id,input_version) WHERE kind='original' AND status IN('queued','running') DO UPDATE SET status='running',lease_token=$2,lease_until=excluded.lease_until RETURNING id")
        .bind(id).bind(token).fetch_one(&state.pool).await.unwrap();
    record_with_lease(
        &state,
        id,
        &json!({"status":"valid"}),
        &ProviderPolicy::default(),
        Some((job, token)),
    )
    .await
    .unwrap();
    let row = sqlx::query("SELECT r.link_validity,c.validity,EXISTS(SELECT 1 FROM link_aggregate_queue WHERE resource_id=r.id) AS pending FROM managed_resources r CROSS JOIN resource_links c WHERE r.id=$1 AND c.id=$2")
        .bind(&resource).bind(id).fetch_one(&state.pool).await.unwrap();
    assert_eq!(row.get::<i16, _>("validity"), 1);
    assert_eq!(row.get::<i16, _>("link_validity"), -1);
    assert!(row.get::<bool, _>("pending"));
    // Maintenance must drain this queue even when link sync is independently paused.
    sqlx::query("DELETE FROM worker_schedule_slots WHERE task='link-maintenance'")
        .execute(&state.pool)
        .await
        .unwrap();
    maintenance(&state).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i16>("SELECT link_validity FROM managed_resources WHERE id=$1")
            .bind(&resource)
            .fetch_one(&state.pool)
            .await
            .unwrap(),
        1
    );
    sqlx::query("UPDATE link_check_jobs SET status='completed',lease_token=NULL,lease_until=NULL WHERE id=$1")
        .bind(job).execute(&state.pool).await.unwrap();
}
