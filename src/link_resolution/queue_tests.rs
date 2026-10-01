use super::*;

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test and PANSOU_TEST_REDIS_URL"]
async fn queue_sweep_order_rescheduling_leases_and_bounded_retention() {
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
    let prefix = Uuid::new_v4().to_string();
    let ids: Vec<Uuid> = sqlx::query_scalar("INSERT INTO link_catalog(id,provider,identity,original_url,input_fingerprint,next_check_at) SELECT gen_random_uuid(),'quark',$1||i,'https://pan.quark.cn/s/fixture'||i,$1||i,now()-interval '100 days'+make_interval(secs=>i) FROM generate_series(1,700) i RETURNING id")
        .bind(&prefix).fetch_all(&mut *tx).await.unwrap();
    sqlx::query("UPDATE link_check_enqueue_cursors SET next_check_at=NULL,link_id=NULL WHERE provider='quark'")
        .execute(&mut *tx).await.unwrap();
    // The first window is already queued. It must not permanently starve later rows.
    sqlx::query("INSERT INTO link_check_jobs(link_id,input_version,kind) SELECT id,1,'original' FROM link_catalog WHERE id=ANY($1) ORDER BY next_check_at,id LIMIT 256")
        .bind(&ids).execute(&mut *tx).await.unwrap();
    let count_sql = "SELECT count(*) FROM link_check_jobs WHERE link_id=ANY($1)";
    for expected in [256i64, 512, 700, 700, 700, 700] {
        sqlx::query(include_str!("enqueue_checks.sql"))
            .bind("quark")
            .execute(&mut *tx)
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>(count_sql)
                .bind(&ids)
                .fetch_one(&mut *tx)
                .await
                .unwrap(),
            expected
        );
    }
    let ordered: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM link_catalog WHERE id=ANY($1) ORDER BY next_check_at,id",
    )
    .bind(&ids)
    .fetch_all(&mut *tx)
    .await
    .unwrap();
    let urgent = ordered[5];
    let future = ordered[4];
    sqlx::query("UPDATE link_check_jobs SET priority=10 WHERE link_id=ANY($1)")
        .bind(vec![urgent, future])
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE link_catalog SET next_check_at=now()+interval '1 day' WHERE id=$1")
        .bind(future)
        .execute(&mut *tx)
        .await
        .unwrap();
    assert!(
        sqlx::query_scalar::<_, bool>(
            "SELECT run_after>now() FROM link_check_jobs WHERE link_id=$1"
        )
        .bind(future)
        .fetch_one(&mut *tx)
        .await
        .unwrap()
    );
    let providers = vec!["quark".to_owned()];
    let token = Uuid::new_v4();
    let claimed = sqlx::query(include_str!("claim_check.sql"))
        .bind(&providers)
        .bind(token)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(claimed.get::<Uuid, _>("link_id"), urgent);
    let job_id = claimed.get::<i64, _>("id");
    // Expired lease recovery consults the latest catalog due time, not the old job.
    sqlx::query("UPDATE link_catalog SET next_check_at=now()+interval '2 days' WHERE id=$1")
        .bind(urgent)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE link_check_jobs SET lease_until=now()-interval '1 second' WHERE id=$1")
        .bind(job_id)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(include_str!("recover_checks.sql"))
        .execute(&mut *tx)
        .await
        .unwrap();
    let recovered = sqlx::query(
        "SELECT status,lease_token,run_after>now() future FROM link_check_jobs WHERE id=$1",
    )
    .bind(job_id)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert_eq!(recovered.get::<String, _>("status"), "queued");
    assert!(recovered.get::<Option<Uuid>, _>("lease_token").is_none());
    assert!(recovered.get::<bool, _>("future"));
    assert_eq!(sqlx::query("UPDATE link_check_jobs SET status='completed' WHERE id=$1 AND status='running' AND lease_token=$2")
        .bind(job_id).bind(token).execute(&mut *tx).await.unwrap().rows_affected(), 0);
    sqlx::query("UPDATE link_catalog SET next_check_at=now()-interval '1 day' WHERE id=$1")
        .bind(urgent)
        .execute(&mut *tx)
        .await
        .unwrap();
    let retry = sqlx::query(include_str!("claim_check.sql"))
        .bind(&providers)
        .bind(Uuid::new_v4())
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(retry.get::<i64, _>("id"), job_id);
    assert_eq!(
        sqlx::query_scalar::<_, i32>("SELECT attempts FROM link_check_jobs WHERE id=$1")
            .bind(job_id)
            .fetch_one(&mut *tx)
            .await
            .unwrap(),
        2
    );
    sqlx::query("UPDATE link_check_jobs SET status='completed' WHERE id=$1")
        .bind(job_id)
        .execute(&mut *tx)
        .await
        .unwrap();
    let fifo = sqlx::query(include_str!("claim_check.sql"))
        .bind(&providers)
        .bind(Uuid::new_v4())
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(fifo.get::<Uuid, _>("link_id"), ordered[0]);
    // Cleanup keeps the established seven-day retention, but bounds each transaction.
    sqlx::query("INSERT INTO link_check_jobs(link_id,input_version,kind,status,updated_at) SELECT $1,1,'original','completed',now()-interval '8 days' FROM generate_series(1,1003)")
        .bind(urgent).execute(&mut *tx).await.unwrap();
    assert_eq!(
        sqlx::query(include_str!("cleanup_checks.sql"))
            .execute(&mut *tx)
            .await
            .unwrap()
            .rows_affected(),
        1000
    );
    assert_eq!(
        sqlx::query(include_str!("cleanup_checks.sql"))
            .execute(&mut *tx)
            .await
            .unwrap()
            .rows_affected(),
        3
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM link_check_jobs WHERE link_id=$1 AND status='completed'"
        )
        .bind(urgent)
        .fetch_one(&mut *tx)
        .await
        .unwrap(),
        1
    );
    sqlx::query("INSERT INTO link_resolve_requests(id,request_key,subject_key,request_fingerprint,link_id,authorization_json,status,deadline_at,expires_at) SELECT gen_random_uuid(),gen_random_uuid(),$1,'fixture',$2,'{}','completed',now()-interval '8 days',now()-interval '1 day' FROM generate_series(1,1003)")
        .bind(&prefix).bind(urgent).execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO link_resolve_requests(id,request_key,subject_key,request_fingerprint,link_id,authorization_json,status,deadline_at) VALUES(gen_random_uuid(),gen_random_uuid(),$1,'fixture',$2,'{}','completed',now())")
        .bind(&prefix).bind(urgent).execute(&mut *tx).await.unwrap();
    assert_eq!(
        sqlx::query(include_str!("cleanup_resolves.sql"))
            .execute(&mut *tx)
            .await
            .unwrap()
            .rows_affected(),
        1000
    );
    assert_eq!(
        sqlx::query(include_str!("cleanup_resolves.sql"))
            .execute(&mut *tx)
            .await
            .unwrap()
            .rows_affected(),
        3
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM link_resolve_requests WHERE subject_key=$1"
        )
        .bind(&prefix)
        .fetch_one(&mut *tx)
        .await
        .unwrap(),
        1
    );
    for name in [
        "idx_managed_resources_search_trgm",
        "idx_resource_tg_name",
        "idx_resource_tg_date",
        "link_check_due",
    ] {
        assert!(
            !sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname=$1)"
            )
            .bind(name)
            .fetch_one(&mut *tx)
            .await
            .unwrap()
        );
    }
    tx.rollback().await.unwrap();

    // Two actual transactions must not claim the same work. These committed fixture
    // rows are removed explicitly below; all larger fixtures above were rolled back.
    let concurrent: Vec<Uuid> = sqlx::query_scalar("INSERT INTO link_catalog(id,provider,identity,original_url,input_fingerprint,next_check_at) SELECT gen_random_uuid(),'quark',$1||i,'https://pan.quark.cn/s/concurrent'||i,$1||i,now()-interval '200 days' FROM generate_series(1,2) i RETURNING id")
        .bind(Uuid::new_v4().to_string()).fetch_all(&pool).await.unwrap();
    sqlx::query("INSERT INTO link_check_jobs(link_id,input_version,kind,priority) SELECT unnest($1::uuid[]),1,'original',10")
        .bind(&concurrent).execute(&pool).await.unwrap();
    let mut a = pool.begin().await.unwrap();
    let mut b = pool.begin().await.unwrap();
    let (first, second) = tokio::join!(
        sqlx::query(include_str!("claim_check.sql"))
            .bind(&providers)
            .bind(Uuid::new_v4())
            .fetch_one(&mut *a),
        sqlx::query(include_str!("claim_check.sql"))
            .bind(&providers)
            .bind(Uuid::new_v4())
            .fetch_one(&mut *b)
    );
    let first = first.unwrap().get::<Uuid, _>("link_id");
    let second = second.unwrap().get::<Uuid, _>("link_id");
    assert_ne!(first, second);
    assert!(concurrent.contains(&first) && concurrent.contains(&second));
    a.rollback().await.unwrap();
    b.rollback().await.unwrap();
    let redis_url = std::env::var("PANSOU_TEST_REDIS_URL").unwrap();
    let redis_path = url::Url::parse(&redis_url).unwrap().path().to_owned();
    assert!(redis_path != "/0" && !redis_path.is_empty() && redis_path != "/");
    let state = AppState::new(
        pool.clone(),
        crate::redis_store::RedisStore::connect(&redis_url)
            .await
            .unwrap(),
    );
    let token = Uuid::new_v4();
    let job = sqlx::query(include_str!("claim_check.sql"))
        .bind(&providers)
        .bind(token)
        .fetch_one(&pool)
        .await
        .unwrap();
    let id: Uuid = job.get("link_id");
    let lease = (job.get("id"), token);
    let fact_sql = "SELECT validity FROM link_catalog WHERE id=$1";
    record_with_lease(
        &state,
        id,
        &json!({"status":"valid"}),
        &json!({}),
        Some((lease.0, Uuid::new_v4())),
    )
    .await
    .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i16>(fact_sql)
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap(),
        -1
    );
    record_with_lease(
        &state,
        id,
        &json!({"status":"valid"}),
        &json!({}),
        Some(lease),
    )
    .await
    .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i16>(fact_sql)
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
    sqlx::query("UPDATE link_check_jobs SET lease_until=now()-interval '1 second' WHERE id=$1")
        .bind(lease.0)
        .execute(&pool)
        .await
        .unwrap();
    record_with_lease(
        &state,
        id,
        &json!({"status":"invalid"}),
        &json!({}),
        Some(lease),
    )
    .await
    .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i16>(fact_sql)
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
    sqlx::query("DELETE FROM link_check_jobs WHERE link_id=ANY($1)")
        .bind(&concurrent)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM link_catalog WHERE id=ANY($1)")
        .bind(&concurrent)
        .execute(&pool)
        .await
        .unwrap();
}
