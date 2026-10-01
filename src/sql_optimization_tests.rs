//! Opt-in SQL contract tests; all mutations roll back in a disposable database.
use crate::{db, resource_clean};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Row, Transaction};

async fn compare_search(tx: &mut Transaction<'_, Postgres>, scope: &[String], keywords: &[&str]) {
    for keyword in keywords {
        let keyword = keyword.to_lowercase();
        let grams = resource_clean::grams(&keyword);
        let longest = grams.iter().map(|g| g.chars().count()).max().unwrap_or(0);
        let grams: Vec<_> = grams
            .into_iter()
            .filter(|g| g.chars().count() == longest)
            .take(8)
            .collect();
        let expected: Vec<Value> =
            sqlx::query(include_str!("queries/telegram_search_reference.sql"))
                .bind(&keyword)
                .bind(None::<String>)
                .bind(scope)
                .fetch_all(&mut **tx)
                .await
                .unwrap()
                .into_iter()
                .map(|r| r.get("item"))
                .collect();
        let rows = if let Some(gram) = grams.first() {
            sqlx::query(include_str!("queries/telegram_search_gram.sql"))
                .bind(&keyword)
                .bind(gram)
                .bind(scope)
                .bind(&grams[1..])
                .fetch_all(&mut **tx)
                .await
                .unwrap()
        } else {
            sqlx::query(include_str!("queries/telegram_search.sql"))
                .bind(&keyword)
                .bind(None::<String>)
                .bind(scope)
                .fetch_all(&mut **tx)
                .await
                .unwrap()
        };
        let actual: Vec<Value> = rows.into_iter().map(|r| r.get("item")).collect();
        assert_eq!(actual, expected, "keyword={keyword}, scope={scope:?}");
    }
}

async fn compare_cloud_types(tx: &mut Transaction<'_, Postgres>) {
    let expected: Vec<(String, i64)> = sqlx::query_as(
        "SELECT cloud_type,count(*) FROM (SELECT DISTINCT r.id,t.cloud_type FROM managed_resources r CROSS JOIN LATERAL jsonb_array_elements_text(r.cloud_types_json) t(cloud_type) WHERE r.deleted_at IS NULL) types GROUP BY cloud_type ORDER BY cloud_type",
    ).fetch_all(&mut **tx).await.unwrap();
    let actual: Vec<(String, i64)> = sqlx::query_as(
        "SELECT cloud_type,resource_count FROM resource_cloud_type_counts ORDER BY cloud_type",
    )
    .fetch_all(&mut **tx)
    .await
    .unwrap();
    assert_eq!(actual, expected);
}

#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test"]
async fn projections_metadata_and_real_change_invalidation_match_original_contract() {
    let url = std::env::var("PANSOU_TEST_DATABASE_URL").unwrap();
    assert!(url::Url::parse(&url).unwrap().path().ends_with("_test"));
    let pool: PgPool = db::connect(&url).await.unwrap();
    db::init_db(&pool).await.unwrap();
    let stats = crate::admin_stats::AdminStats::default();
    for cloud_type in ["mobile", "quark", "missing-provider-fixture"] {
        let expected: i64 = sqlx::query_scalar("SELECT count(*) FROM managed_resources WHERE deleted_at IS NULL AND cloud_types_json ? $1")
            .bind(cloud_type).fetch_one(&pool).await.unwrap();
        assert_eq!(
            stats.resource_total(&pool, "", cloud_type).await.unwrap(),
            expected
        );
    }
    let mut tx = pool.begin().await.unwrap();
    let prefix = uuid::Uuid::new_v4().simple().to_string();
    let public = format!("public_{prefix}");
    let private = format!("private_{prefix}");
    let moved = format!("moved_{prefix}");
    for channel in [&public, &private, &moved] {
        sqlx::query("INSERT INTO crawl_channels(id,name) VALUES($1,$1)")
            .bind(channel)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    let mut ids = Vec::new();
    for i in 0..260i64 {
        let id = format!("{prefix}_{i:03}");
        let title = match i {
            0 => "电影 资料 !!!".to_owned(),
            1 => "电影".to_owned(),
            5 => "纯!!!符号".to_owned(),
            6 => "a !!! b".to_owned(),
            _ => format!("电影资料 {i:03}"),
        };
        sqlx::query("INSERT INTO managed_resources(id,name,origin,cloud_types_json,search_text) VALUES($1,$2,'telegram',$3,$2)")
            .bind(&id).bind(&title).bind(json!(["quark","quark","baidu"]))
            .execute(&mut *tx).await.unwrap();
        for (channel, name) in [
            (&public, title.clone()),
            (&private, format!("私密标题 {i:03}")),
        ] {
            sqlx::query("INSERT INTO source_messages(channel_id,message_id,raw_html,raw_hash,parse_version,parse_status,published_at) VALUES($1,$2,'','test','test','parsed',to_timestamp($3))")
                .bind(channel).bind(i+1).bind((1_700_000_000+i) as f64)
                .execute(&mut *tx).await.unwrap();
            let item = json!({"id":"incorrect_snapshot_id","name":name,"description":"only display, not searchable","cloud_types":["quark"],"links":[],"tags":["secret-tag"],"images":[]});
            sqlx::query("INSERT INTO resource_occurrences(channel_id,message_id,resource_id,result_json) VALUES($1,$2,$3,$4)")
                .bind(channel).bind(i+1).bind(&id).bind(item).execute(&mut *tx).await.unwrap();
        }
        let grams = resource_clean::grams(&format!("{title} 私密标题 {i:03}"));
        sqlx::query("INSERT INTO resource_grams(resource_id,gram) SELECT $1,unnest($2::text[]) ON CONFLICT DO NOTHING")
            .bind(&id).bind(grams).execute(&mut *tx).await.unwrap();
        ids.push(id);
    }
    let keywords = [
        "电影",
        "资料",
        "电影资料",
        "电影 资料",
        "!!!",
        "a !!! b",
        "影",
        "不存在",
        "only display",
        "secret-tag",
        "",
    ];
    compare_search(&mut tx, std::slice::from_ref(&public), &keywords).await;
    compare_search(
        &mut tx,
        &[public.clone(), private.clone()],
        &["电影", "私密标题", ""],
    )
    .await;
    compare_search(&mut tx, std::slice::from_ref(&moved), &["电影", "!!!", ""]).await;
    compare_cloud_types(&mut tx).await;

    // Zero-row UPDATE, identical UPDATE/JSON and ON CONFLICT do not invalidate.
    let before: i64 =
        sqlx::query_scalar("SELECT revision FROM config_revisions WHERE scope='local-index'")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    sqlx::query("UPDATE managed_resources SET name=name WHERE false")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE managed_resources SET name=name WHERE id=$1")
        .bind(&ids[0])
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO managed_resources(id,name) VALUES($1,'ignored') ON CONFLICT DO NOTHING",
    )
    .bind(&ids[0])
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query("UPDATE resource_occurrences SET result_json=result_json WHERE resource_id=$1")
        .bind(&ids[0])
        .execute(&mut *tx)
        .await
        .unwrap();
    let after: i64 =
        sqlx::query_scalar("SELECT revision FROM config_revisions WHERE scope='local-index'")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(after, before);

    sqlx::query(
        "UPDATE managed_resources SET name='人工电影标题',manual_override=true WHERE id=$1",
    )
    .bind(&ids[0])
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query("UPDATE managed_resources SET enabled=false WHERE id=$1")
        .bind(&ids[3])
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE managed_resources SET deleted_at=now() WHERE id=$1")
        .bind(&ids[4])
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE source_messages SET parse_status='failed' WHERE channel_id=$1 AND message_id=3",
    )
    .bind(&public)
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE source_messages SET published_at=NULL WHERE channel_id=$1 AND message_id=8",
    )
    .bind(&public)
    .execute(&mut *tx)
    .await
    .unwrap();
    compare_search(
        &mut tx,
        std::slice::from_ref(&public),
        &["电影", "资料", "人工", "!!!", ""],
    )
    .await;
    compare_cloud_types(&mut tx).await;
    sqlx::query("UPDATE source_messages SET parse_status='parsed',published_at=now() WHERE channel_id=$1 AND message_id=3")
        .bind(&public).execute(&mut *tx).await.unwrap();
    sqlx::query("UPDATE managed_resources SET deleted_at=NULL,cloud_types_json='[\"custom-provider\",\"custom-provider\"]' WHERE id=$1")
        .bind(&ids[4]).execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO source_messages(channel_id,message_id,raw_html,raw_hash,parse_version,parse_status) VALUES($1,6,'','test','test','parsed')")
        .bind(&moved).execute(&mut *tx).await.unwrap();
    sqlx::query(
        "UPDATE resource_occurrences SET channel_id=$2 WHERE channel_id=$1 AND message_id=6",
    )
    .bind(&public)
    .bind(&moved)
    .execute(&mut *tx)
    .await
    .unwrap();
    compare_search(&mut tx, std::slice::from_ref(&public), &keywords).await;
    compare_search(&mut tx, std::slice::from_ref(&moved), &["!!!", ""]).await;
    sqlx::query("DELETE FROM managed_resources WHERE id=$1")
        .bind(&ids[4])
        .execute(&mut *tx)
        .await
        .unwrap();
    compare_cloud_types(&mut tx).await;
    compare_search(&mut tx, std::slice::from_ref(&public), &["电影", ""]).await;
    tx.rollback().await.unwrap();
    assert!(
        !sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM resource_search_documents WHERE resource_id=$1)"
        )
        .bind(&ids[0])
        .fetch_one(&pool)
        .await
        .unwrap()
    );
}
