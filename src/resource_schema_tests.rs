//! Resource input snapshots and catalog observations have distinct ownership.
use crate::{app::AppState, db, redis_store::RedisStore};
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
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
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test"]
async fn migration_preserves_snapshots_catalog_bindings_and_exact_types() {
    let pool = test_pool().await;
    let mut tx = pool.begin().await.unwrap();
    let schema = format!("resource_schema_{}", Uuid::new_v4().simple());
    sqlx::raw_sql(&format!(
        "CREATE SCHEMA {schema}; SET LOCAL search_path TO {schema},public"
    ))
    .execute(&mut *tx)
    .await
    .unwrap();
    for migration in sqlx::migrate!("./migrations")
        .iter()
        .filter(|m| m.version < 29)
    {
        sqlx::raw_sql(&migration.sql)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    let link = Uuid::new_v4();
    sqlx::raw_sql(
        "INSERT INTO crawl_channels(id,name) VALUES('public','Public'),('private','Private');
         INSERT INTO managed_resources(id,name,links_json,cloud_types_json,check_status,link_validity)
         VALUES('resource','Resource','[{\"type\":\"quark\",\"url\":\"https://pan.quark.cn/s/one\",\"password\":\"1234\"},{\"type\":\"quark\",\"url\":\"https://pan.quark.cn/s/two\"},{\"type\":\"baidu\",\"url\":\"https://pan.baidu.com/s/three\"}]',
           '[\"baidu\",\"quark\"]','valid',1),
          ('empty','Empty','[]','[\"phantom\"]','unchecked',-1);
         INSERT INTO source_messages(channel_id,message_id,raw_hash,parse_version,parse_status)
         SELECT channel,1,'hash','version','parsed' FROM unnest(ARRAY['public','private']) channel;
         INSERT INTO resource_occurrences(channel_id,message_id,resource_id,result_json)
         SELECT channel,1,'resource',jsonb_build_object('name',channel,'links',jsonb_build_array(jsonb_build_object('type','quark','url',channel)))
         FROM unnest(ARRAY['public','private']) channel;
         INSERT INTO resource_links(resource_id,identity,url,cloud_type,password)
         VALUES('resource','legacy','https://pan.quark.cn/s/one','quark','1234');"
    ).execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO link_catalog(id,provider,identity,original_url,input_fingerprint,validity,checked_at,valid_until,last_attempt_at) VALUES($1,'quark','one','https://pan.quark.cn/s/one','fingerprint',1,now(),now()+interval '1 day',now())")
        .bind(link).execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO resource_link_bindings(resource_id,scope_key,link_key,link_id,links_revision) VALUES('resource','managed','key',$1,1),('resource','occurrence:private:1','private-key',$1,1)")
        .bind(link).execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO link_check_jobs(link_id,input_version,kind) VALUES($1,1,'original')")
        .bind(link)
        .execute(&mut *tx)
        .await
        .unwrap();
    let snapshots: Vec<Value> = sqlx::query_scalar("SELECT to_jsonb(r)-ARRAY['cloud_types_json','check_status','check_message','checked_at'] FROM managed_resources r ORDER BY id")
        .fetch_all(&mut *tx).await.unwrap();
    let mut related = Vec::new();
    for table in [
        "resource_occurrences",
        "link_catalog",
        "resource_link_bindings",
        "link_check_jobs",
        "resource_search_occurrences",
        "channel_statistics",
    ] {
        let rows: Vec<Value> = sqlx::query_scalar(&format!(
            "SELECT to_jsonb(r) FROM {table} r ORDER BY to_jsonb(r)::text"
        ))
        .fetch_all(&mut *tx)
        .await
        .unwrap();
        related.push((table, rows));
    }
    sqlx::raw_sql(include_str!(
        "../migrations/029_resource_link_single_source.sql"
    ))
    .execute(&mut *tx)
    .await
    .unwrap();
    let after: Vec<Value> =
        sqlx::query_scalar("SELECT to_jsonb(r) FROM managed_resources r ORDER BY id")
            .fetch_all(&mut *tx)
            .await
            .unwrap();
    assert_eq!(after, snapshots);
    for (table, before) in related {
        let after: Vec<Value> = sqlx::query_scalar(&format!(
            "SELECT to_jsonb(r) FROM {table} r ORDER BY to_jsonb(r)::text"
        ))
        .fetch_all(&mut *tx)
        .await
        .unwrap();
        assert_eq!(after, before, "migration changed {table}");
    }
    let legacy_table: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name='resource_links')")
        .bind(&schema).fetch_one(&mut *tx).await.unwrap();
    assert!(!legacy_table);
    let old_columns: i64 = sqlx::query_scalar("SELECT count(*) FROM information_schema.columns WHERE table_schema=$1 AND table_name='managed_resources' AND column_name=ANY(ARRAY['cloud_types_json','check_status','check_message','checked_at'])")
        .bind(&schema).fetch_one(&mut *tx).await.unwrap();
    assert_eq!(old_columns, 0);
    let types: Value = sqlx::query_scalar(
        "SELECT resource_cloud_types(links_json) FROM managed_resources WHERE id='resource'",
    )
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert_eq!(types, json!(["baidu", "quark"]));
    async fn counts(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>) -> Vec<(String, i64)> {
        sqlx::query_as(
            "SELECT cloud_type,resource_count FROM resource_cloud_type_counts ORDER BY cloud_type",
        )
        .fetch_all(&mut **tx)
        .await
        .unwrap()
    }
    assert_eq!(
        counts(&mut tx).await,
        vec![("baidu".into(), 1), ("quark".into(), 1)]
    );
    let revision: i64 =
        sqlx::query_scalar("SELECT revision FROM config_revisions WHERE scope='local-index'")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    sqlx::raw_sql("UPDATE managed_resources SET links_json=links_json WHERE id='resource'; UPDATE managed_resources SET enabled=false WHERE id='resource';")
        .execute(&mut *tx).await.unwrap();
    assert_eq!(
        counts(&mut tx).await,
        vec![("baidu".into(), 1), ("quark".into(), 1)]
    );
    let new_revision: i64 =
        sqlx::query_scalar("SELECT revision FROM config_revisions WHERE scope='local-index'")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(
        new_revision,
        revision + 1,
        "no-op link edit must not invalidate"
    );
    sqlx::raw_sql("UPDATE managed_resources SET links_json='[{\"type\":\"guangya\",\"url\":\"https://www.guangyapan.com/s/new\"}]' WHERE id='resource';")
        .execute(&mut *tx).await.unwrap();
    assert_eq!(counts(&mut tx).await, vec![("guangya".into(), 1)]);
    let reset = sqlx::query("SELECT link_validity,link_validity_updated_at,links_revision FROM managed_resources WHERE id='resource'")
        .fetch_one(&mut *tx).await.unwrap();
    assert_eq!(reset.get::<i16, _>("link_validity"), -1);
    assert!(
        reset
            .get::<Option<chrono::DateTime<chrono::Utc>>, _>("link_validity_updated_at")
            .is_none()
    );
    assert_eq!(reset.get::<i64, _>("links_revision"), 2);
    sqlx::raw_sql("UPDATE managed_resources SET deleted_at=now() WHERE id='resource'")
        .execute(&mut *tx)
        .await
        .unwrap();
    assert!(counts(&mut tx).await.is_empty());
    sqlx::raw_sql("UPDATE managed_resources SET deleted_at=NULL WHERE id='resource'")
        .execute(&mut *tx)
        .await
        .unwrap();
    assert_eq!(counts(&mut tx).await, vec![("guangya".into(), 1)]);
    sqlx::raw_sql("UPDATE managed_resources SET links_json='[]' WHERE id='resource'")
        .execute(&mut *tx)
        .await
        .unwrap();
    assert!(counts(&mut tx).await.is_empty());
    tx.rollback().await.unwrap();
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
    let request = json!({"id":id,"name":"Schema resource","cloud_types":["phantom"],"links":[{"type":link.r#type,"url":link.url,"password":link.password,"validity":1,"checkStatus":"valid","checkMessage":"forged upstream secret","createdAt":"1900-01-01"}]});
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
    let stored: Value = sqlx::query_scalar("SELECT links_json FROM managed_resources WHERE id=$1")
        .bind(&id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(stored, json!([link]));
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM link_catalog")
        .fetch_one(&pool)
        .await
        .unwrap();
    let path = format!("/api/admin/resources/{id}");
    let (status, unchecked) = call(&router, &session.token, "GET", &path, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        unchecked["data"]["resource"]["links"][0]["checkStatus"],
        "unchecked"
    );
    assert!(unchecked["data"]["resource"]["links"][0]["createdAt"].is_null());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM link_catalog")
            .fetch_one(&pool)
            .await
            .unwrap(),
        before,
        "reading a resource must not register links"
    );
    let catalog_id = Uuid::new_v4();
    sqlx::query("INSERT INTO link_catalog(id,provider,identity,original_url,original_password,input_fingerprint,validity,checked_at,valid_until,last_attempt_at,last_error_code) VALUES($1,'quark','test',$2,'1234',$3,1,now(),now()-interval '1 second',now(),'rate_limited')")
        .bind(catalog_id).bind(&link.url).bind(crate::link_resolution::fingerprint(&link)).execute(&pool).await.unwrap();
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
    sqlx::query("UPDATE link_catalog SET validity=0,valid_until=now()+interval '1 hour',last_error_code='original_invalid' WHERE id=$1")
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
    sqlx::query("DELETE FROM managed_resources WHERE id=$1")
        .bind(&id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM link_catalog WHERE id=$1")
        .bind(catalog_id)
        .execute(&pool)
        .await
        .unwrap();
    state.auth().revoke_session(&session).await.unwrap();
}
