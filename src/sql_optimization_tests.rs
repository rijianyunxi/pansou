//! Opt-in SQL contract tests; all mutations roll back in a disposable database.
use crate::{db, resource_clean};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Transaction};

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test"]
async fn hot_search_counts_increment_atomically_without_overriding_moderation() {
    let url = std::env::var("PANSOU_TEST_DATABASE_URL").unwrap();
    assert!(url::Url::parse(&url).unwrap().path().ends_with("_test"));
    let pool = db::connect(&url).await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    let schema = format!("hot_search_{}", uuid::Uuid::new_v4().simple());
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
        "INSERT INTO hot_searches(term,normalized_term,score,last_searched) VALUES('已有热词','已有热词',4,'2026-09-27');
         INSERT INTO hot_searches(term,score,last_searched,status,source,pinned,manual_weight)
           SELECT status,50,'2026-09-27',status,'manual',true,9 FROM unnest(ARRAY['blocked','hidden','pending']) status;
         INSERT INTO search_logs(keyword,ip,search_scope,created_at)
           SELECT '已有热词','127.0.0.1','system','2026-09-26'::timestamptz FROM generate_series(1,4);
         INSERT INTO search_logs(keyword,ip,search_scope,created_at)
           SELECT term,'127.0.0.1','system','2026-10-01'::timestamptz + i * interval '1 second'
           FROM unnest(ARRAY['已有热词','新热词','blocked','hidden','pending']) term CROSS JOIN generate_series(1,3) i;
         INSERT INTO search_logs(keyword,ip,search_scope) VALUES('   ','127.0.0.1','system');"
    ).execute(&mut *tx).await.unwrap();
    for term in ["blocked", "blocked", "New Term", "New Term"] {
        let id: i64 = sqlx::query_scalar(include_str!("queries/create_search_log.sql"))
            .bind("test-session")
            .bind(None::<i64>)
            .bind(term)
            .bind("127.0.0.1")
            .bind("system")
            .bind(json!([]))
            .bind(json!([]))
            .bind(term.to_lowercase())
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        // Completing a search does not cause a second popularity increment.
        sqlx::query("UPDATE search_logs SET status='completed' WHERE id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    let blocked: Value =
        sqlx::query_scalar("SELECT to_jsonb(h) FROM hot_searches h WHERE term='blocked'")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(blocked["score"], 52);
    assert_eq!(blocked["status"], "blocked");
    assert_eq!(blocked["source"], "manual");
    assert_eq!(blocked["pinned"], true);
    assert_eq!(blocked["manual_weight"], 9);
    let new_term: (String, i64, String) = sqlx::query_as(
        "SELECT normalized_term,score,status FROM hot_searches WHERE term='New Term'",
    )
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert_eq!(new_term, ("new term".into(), 2, "approved".into()));
    let logs: i64 =
        sqlx::query_scalar("SELECT count(*) FROM search_logs WHERE session_id='test-session'")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(logs, 4);

    // A log failure must leave its popularity unchanged.
    sqlx::raw_sql("SAVEPOINT invalid_search")
        .execute(&mut *tx)
        .await
        .unwrap();
    let result = sqlx::query_scalar::<_, i64>(include_str!("queries/create_search_log.sql"))
        .bind("invalid-session")
        .bind(i64::MAX)
        .bind("New Term")
        .bind("127.0.0.1")
        .bind("system")
        .bind(json!([]))
        .bind(json!([]))
        .bind("new term")
        .fetch_one(&mut *tx)
        .await;
    assert!(result.is_err());
    sqlx::raw_sql("ROLLBACK TO SAVEPOINT invalid_search")
        .execute(&mut *tx)
        .await
        .unwrap();
    let score: i64 = sqlx::query_scalar("SELECT score FROM hot_searches WHERE term='New Term'")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(score, 2);
    tx.rollback().await.unwrap();
}

async fn compare_search(tx: &mut Transaction<'_, Postgres>, scope: &[String], keywords: &[&str]) {
    for keyword in keywords {
        let keyword = keyword.to_lowercase();
        let all = resource_clean::grams(&keyword);
        let longest = all.iter().map(|g| g.chars().count()).max().unwrap_or(0);
        let grams: Vec<_> = all
            .into_iter()
            .filter(|g| g.chars().count() == longest)
            .take(8)
            .collect();
        let expected: Vec<Value> =
            sqlx::query_scalar(include_str!("queries/telegram_search_reference.sql"))
                .bind(&keyword)
                .bind(scope)
                .fetch_all(&mut **tx)
                .await
                .unwrap();
        let actual: Vec<Value> = sqlx::query_scalar(include_str!("queries/telegram_search.sql"))
            .bind(&keyword)
            .bind(&grams)
            .bind(scope)
            .fetch_all(&mut **tx)
            .await
            .unwrap();
        assert_eq!(actual, expected, "keyword={keyword}, scope={scope:?}");
    }
}

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test"]
async fn direct_resource_search_matches_oracle_and_invalidates_only_content_changes() {
    let url = std::env::var("PANSOU_TEST_DATABASE_URL").unwrap();
    assert!(url::Url::parse(&url).unwrap().path().ends_with("_test"));
    let pool: PgPool = db::connect(&url).await.unwrap();
    db::init_db(&pool).await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    let prefix = uuid::Uuid::new_v4().simple().to_string();
    let public = format!("public_{prefix}");
    let private = format!("private_{prefix}");
    for i in 0..260i64 {
        let title = match i % 6 {
            0 => "三体",
            1 => "三体 4K",
            2 => "电影 资料",
            3 => "!!!",
            4 => "a !!! b",
            _ => "流浪地球",
        };
        let channels = if i % 7 == 0 {
            vec![private.clone()]
        } else {
            vec![public.clone(), private.clone()]
        };
        sqlx::query("INSERT INTO managed_resources(id,name,description,origin,source_channel_ids,published_at) VALUES($1,$2,'description-only','telegram',$3,to_timestamp($4))")
            .bind(format!("{prefix}_{i}")).bind(title).bind(channels).bind(1700000000.0+i as f64)
            .execute(&mut *tx).await.unwrap();
    }
    let keywords = [
        "三体",
        "三",
        "!!!",
        "电影 资料",
        "a !!! b",
        "流浪地球",
        "4k",
        "description-only",
        "",
    ];
    compare_search(&mut tx, &[public.clone()], &keywords).await;
    compare_search(&mut tx, &[private.clone()], &keywords).await;
    compare_search(&mut tx, &[public.clone(), private.clone()], &keywords).await;
    let id = format!("{prefix}_0");
    let before: i64 =
        sqlx::query_scalar("SELECT revision FROM config_revisions WHERE scope='local-index'")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    sqlx::query("UPDATE managed_resources SET name=name WHERE id=$1")
        .bind(&id)
        .execute(&mut *tx)
        .await
        .unwrap();
    let after: i64 =
        sqlx::query_scalar("SELECT revision FROM config_revisions WHERE scope='local-index'")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(before, after);
    sqlx::query("UPDATE managed_resources SET link_validity=1 WHERE id=$1")
        .bind(&id)
        .execute(&mut *tx)
        .await
        .unwrap();
    let after: i64 =
        sqlx::query_scalar("SELECT revision FROM config_revisions WHERE scope='local-index'")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(before, after);
    sqlx::query("UPDATE managed_resources SET name='新标题',enabled=false WHERE id=$1")
        .bind(&id)
        .execute(&mut *tx)
        .await
        .unwrap();
    compare_search(&mut tx, &[public.clone()], &["三体", "新标题"]).await;
    sqlx::query("UPDATE managed_resources SET enabled=true WHERE id=$1")
        .bind(&id)
        .execute(&mut *tx)
        .await
        .unwrap();
    compare_search(&mut tx, &[public], &["三体", "新标题"]).await;
    let grams: Vec<String> =
        sqlx::query_scalar("SELECT name_grams FROM managed_resources WHERE id=$1")
            .bind(&id)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(grams, resource_clean::grams("新标题"));
    tx.rollback().await.unwrap();
}
