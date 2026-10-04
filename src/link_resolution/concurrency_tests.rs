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
    let link_id = register(&state, &link).await.unwrap();
    let resource = format!("concurrency-{}", Uuid::new_v4());
    sqlx::query(
        "INSERT INTO managed_resources(id,name,links_json) VALUES($1,'concurrency fixture',$2)",
    )
    .bind(&resource)
    .bind(json!([link]))
    .execute(&state.pool)
    .await
    .unwrap();
    let mut index = state.pool.begin().await.unwrap();
    crate::crawl::lock_index(&mut index).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        sync_batch(&state).await.unwrap();
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
    let left = register(&state, &links[0]).await.unwrap();
    let right = register(&state, &links[1]).await.unwrap();
    let resource = format!("parallel-{}", Uuid::new_v4());
    sqlx::query(
        "INSERT INTO managed_resources(id,name,links_json) VALUES($1,'parallel fixture',$2)",
    )
    .bind(&resource)
    .bind(json!(links))
    .execute(&state.pool)
    .await
    .unwrap();
    sync_batch(&state).await.unwrap();
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
            crate::runtime::WorkerKind::LinkSync,
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
