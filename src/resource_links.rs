//! Resource-owned links: content and check facts live in one row.
use crate::{error::ApiError, models::Link};
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};

pub(crate) async fn replace(
    tx: &mut Transaction<'_, Postgres>,
    resource: &str,
    links: &[Link],
) -> Result<(), ApiError> {
    let entries: Vec<Value> = links
        .iter()
        .map(|link| {
            let normalized = crate::resource_clean::normalize_link(link.clone());
            json!({
                "provider":normalized.r#type,
                "url":normalized.url,"password":normalized.password,
                "identity":crate::resource_clean::link_identity(&normalized.url),
                "linkKey":crate::link_resolution::fingerprint(&normalized)
            })
        })
        .collect();
    sqlx::query("SELECT replace_resource_links($1,$2)")
        .bind(resource)
        .bind(json!(entries))
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Build the one-time migration input with the exact Rust URL normalization.
/// Paging bounds memory and preserves all observations for alternate URL spellings.
pub(crate) async fn prepare_migration(pool: &sqlx::PgPool) -> anyhow::Result<()> {
    let old: bool = sqlx::query_scalar("SELECT to_regclass('public.link_catalog') IS NOT NULL")
        .fetch_one(pool)
        .await?;
    if !old {
        return Ok(());
    }
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(734810,48)")
        .execute(&mut *tx)
        .await?;
    sqlx::query("CREATE TABLE IF NOT EXISTS resource_link_migration_inputs(resource_id text NOT NULL,position integer NOT NULL,link_key text NOT NULL,old_key text NOT NULL,identity text NOT NULL,provider text NOT NULL,url text NOT NULL,password text,PRIMARY KEY(resource_id,position))")
        .execute(&mut *tx).await?;
    sqlx::query("TRUNCATE resource_link_migration_inputs")
        .execute(&mut *tx)
        .await?;
    let mut cursor = String::new();
    loop {
        let rows: Vec<(String, Value)> = sqlx::query_as(
            "SELECT id,links_json FROM managed_resources WHERE id>$1 ORDER BY id LIMIT 1000",
        )
        .bind(&cursor)
        .fetch_all(&mut *tx)
        .await?;
        if rows.is_empty() {
            break;
        }
        let mut inputs = Vec::new();
        for (id, value) in &rows {
            let links: Vec<Link> = serde_json::from_value(value.clone())?;
            for (position, link) in links.iter().enumerate() {
                let mut normalized = link.clone();
                normalized.r#type = crate::resource_clean::cloud_type(&link.url)
                    .unwrap_or(&link.r#type)
                    .into();
                inputs.push(json!({"resource_id":id,"position":position,"link_key":crate::link_resolution::fingerprint(&normalized),"old_key":crate::link_resolution::fingerprint(link),"identity":crate::resource_clean::link_identity(&link.url),"provider":normalized.r#type,"url":link.url,"password":link.password}));
            }
        }
        sqlx::query("INSERT INTO resource_link_migration_inputs SELECT * FROM jsonb_to_recordset($1) AS x(resource_id text,position integer,link_key text,old_key text,identity text,provider text,url text,password text)")
            .bind(json!(inputs)).execute(&mut *tx).await?;
        cursor = rows.last().unwrap().0.clone();
    }
    tx.commit().await?;
    Ok(())
}

/// One-time cleanup for rows registered before the extractor split glued
/// extraction codes off the URL ("…aKQ提取码：z2m1" and its percent-encoded
/// form, "?pwd=mckj（提取码：mckj）"). Rewrites url/password/identity and the
/// input fingerprint with the same normalization the ingest uses, then
/// reschedules the validity check. Idempotent: repaired URLs no longer match.
pub(crate) async fn repair_password_suffixes(pool: &sqlx::PgPool) -> anyhow::Result<()> {
    use sqlx::Row;
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(734810,51)")
        .execute(&mut *tx)
        .await?;
    let rows = sqlx::query(
        "SELECT id,provider,original_url,original_password FROM resource_links \
         WHERE original_url ~ '(?i)(提取码|密码|访问码|%E6%8F%90%E5%8F%96%E7%A0%81|%E5%AF%86%E7%A0%81|%E8%AE%BF%E9%97%AE%E7%A0%81|%EF%BC%88|%EF%BC%89|%28|%29)' \
         OR original_password ~ '(?i)(提取码|密码|访问码|%E6%8F%90%E5%8F%96%E7%A0%81|%E5%AF%86%E7%A0%81|%E8%AE%BF%E9%97%AE%E7%A0%81)' ORDER BY id FOR UPDATE",
    )
    .fetch_all(&mut *tx)
    .await?;
    let mut repaired = 0usize;
    for row in rows {
        let id: uuid::Uuid = row.get("id");
        let provider: String = row.get("provider");
        let url: String = row.get("original_url");
        let stored: Option<String> = row.get("original_password");
        let mut link = crate::resource_clean::normalize_link(Link {
            r#type: provider,
            url: url.clone(),
            password: stored.clone(),
        });
        // Also remove dangling glue left by earlier cleanup rounds.
        link.url = crate::resource_clean::trim_url_glue(&link.url).to_owned();
        if link.url == url && link.password == stored {
            continue;
        }
        sqlx::query("UPDATE resource_links SET original_url=$2,original_password=$3,identity=$4,input_fingerprint=$5,provider=$6,validity=-1,checked_at=NULL,valid_until=NULL,last_attempt_at=NULL,last_error_code=NULL,failure_count=0,next_check_at=now(),updated_at=now() WHERE id=$1")
            .bind(&id)
            .bind(&link.url)
            .bind(&link.password)
            .bind(crate::resource_clean::link_identity(&link.url))
            .bind(crate::link_resolution::fingerprint(&link))
            .bind(&link.r#type)
            .execute(&mut *tx)
            .await?;
        repaired += 1;
    }
    if repaired > 0 {
        sqlx::query("UPDATE config_revisions SET revision=revision+1 WHERE scope='local-index'")
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    if repaired > 0 {
        tracing::info!(repaired, "reglued extraction-code URL suffixes repaired");
    }
    Ok(())
}

#[cfg(test)]
pub(crate) async fn fixture(pool: &sqlx::PgPool, id: &str, name: &str, links: Value) {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("INSERT INTO managed_resources(id,name) VALUES($1,$2)")
        .bind(id)
        .bind(name)
        .execute(&mut *tx)
        .await
        .unwrap();
    replace(
        &mut tx,
        id,
        &serde_json::from_value::<Vec<Link>>(links).unwrap(),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
}
#[cfg(test)]
pub(crate) async fn fixture_replace(pool: &sqlx::PgPool, id: &str, links: Value) {
    let mut tx = pool.begin().await.unwrap();
    replace(
        &mut tx,
        id,
        &serde_json::from_value::<Vec<Link>>(links).unwrap(),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Row;
    #[tokio::test]
    #[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test"]
    async fn suffix_repair_preserves_ids_recovers_codes_and_resets_old_check_facts() {
        let url = std::env::var("PANSOU_TEST_DATABASE_URL").unwrap();
        assert!(url::Url::parse(&url).unwrap().path().ends_with("_test"));
        let pool = crate::db::connect(&url).await.unwrap();
        crate::db::init_db(&pool).await.unwrap();
        let run = uuid::Uuid::new_v4().simple().to_string();
        for (provider, base, suffix, stored, code) in [
            (
                "123",
                "https://www.123684.com/s/",
                "?%E6%8F%90%E5%8F%96%E7%A0%81:JZMM",
                Some(""),
                "JZMM",
            ),
            (
                "115",
                "https://115cdn.com/s/",
                "?password=yd45&#访问码：yd45",
                Some("yd45"),
                "yd45",
            ),
            (
                "tianyi",
                "https://cloud.189.cn/t/",
                "访问码：w0aa",
                None,
                "w0aa",
            ),
            (
                "xunlei",
                "https://pan.xunlei.com/s/",
                "#%ef%bc%88提取码：dexg",
                None,
                "dexg",
            ),
            (
                "baidu",
                "https://pan.baidu.com/s/1",
                "?pwd=mckj（提取码：mckj）",
                Some("mckj（提取码：mckj）"),
                "mckj",
            ),
        ] {
            let owner = format!("suffix-{provider}-{run}");
            let dirty = format!("{base}{run}{suffix}");
            fixture(
                &pool,
                &owner,
                "suffix fixture",
                json!([{ "type":provider,"url":dirty,"password":stored }]),
            )
            .await;
            // The storage boundary cleans new input before it reaches the DB.
            let expected = crate::resource_clean::normalize_link(Link {
                r#type: provider.into(),
                url: dirty.clone(),
                password: stored.map(str::to_owned),
            });
            let row = sqlx::query(
                "SELECT id,original_url,original_password FROM resource_links WHERE resource_id=$1",
            )
            .bind(&owner)
            .fetch_one(&pool)
            .await
            .unwrap();
            let id: uuid::Uuid = row.get("id");
            assert_eq!(row.get::<String, _>("original_url"), expected.url);
            assert_eq!(
                row.get::<Option<String>, _>("original_password").as_deref(),
                Some(code)
            );
            // Simulate a legacy dirty row and a previously invalid check.
            sqlx::query("UPDATE resource_links SET original_url=$2,original_password=$3,identity=$2,input_fingerprint=$4,validity=0,checked_at=now(),valid_until=now()+interval '1 hour',last_error_code='original_invalid',failure_count=3,next_check_at=now()+interval '1 day' WHERE id=$1")
                .bind(id).bind(&dirty).bind(stored).bind(format!("dirty-{provider}-{run}")).execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO link_check_jobs(link_id,input_version,kind,priority) SELECT id,input_version,'original',1 FROM resource_links WHERE id=$1 ON CONFLICT DO NOTHING")
                .bind(id).execute(&pool).await.unwrap();
            let revision_before: i64 = sqlx::query_scalar(
                "SELECT revision FROM config_revisions WHERE scope='local-index'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            repair_password_suffixes(&pool).await.unwrap();
            let revision_after: i64 = sqlx::query_scalar(
                "SELECT revision FROM config_revisions WHERE scope='local-index'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(revision_after, revision_before + 1);
            let row = sqlx::query("SELECT id,original_url,original_password,identity,input_fingerprint,validity,valid_until,last_error_code,failure_count,updated_at FROM resource_links WHERE resource_id=$1").bind(&owner).fetch_one(&pool).await.unwrap();
            assert_eq!(row.get::<uuid::Uuid, _>("id"), id);
            assert_eq!(row.get::<String, _>("original_url"), expected.url);
            assert_eq!(
                row.get::<Option<String>, _>("original_password").as_deref(),
                Some(code)
            );
            assert_eq!(
                row.get::<String, _>("identity"),
                crate::resource_clean::link_identity(&expected.url)
            );
            assert_eq!(
                row.get::<String, _>("input_fingerprint"),
                crate::link_resolution::fingerprint(&expected)
            );
            assert_eq!(row.get::<i16, _>("validity"), -1);
            assert!(
                row.get::<Option<chrono::DateTime<chrono::Utc>>, _>("valid_until")
                    .is_none()
            );
            assert!(row.get::<Option<String>, _>("last_error_code").is_none());
            assert_eq!(row.get::<i32, _>("failure_count"), 0);
            let scheduled: bool = sqlx::query_scalar("SELECT bool_and(j.run_after=c.next_check_at) FROM link_check_jobs j JOIN resource_links c ON c.id=j.link_id WHERE c.id=$1 AND j.status='queued'")
                .bind(id).fetch_one(&pool).await.unwrap();
            assert!(scheduled);
            let updated: chrono::DateTime<chrono::Utc> = row.get("updated_at");
            repair_password_suffixes(&pool).await.unwrap();
            let again: chrono::DateTime<chrono::Utc> =
                sqlx::query_scalar("SELECT updated_at FROM resource_links WHERE id=$1")
                    .bind(id)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(updated, again);
            let revision_again: i64 = sqlx::query_scalar(
                "SELECT revision FROM config_revisions WHERE scope='local-index'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(revision_again, revision_after);
        }
        sqlx::query("DELETE FROM link_check_jobs WHERE link_id IN(SELECT id FROM resource_links WHERE resource_id LIKE $1)").bind(format!("suffix-%-{run}")).execute(&pool).await.unwrap();
        sqlx::query("DELETE FROM managed_resources WHERE id LIKE $1")
            .bind(format!("suffix-%-{run}"))
            .execute(&pool)
            .await
            .unwrap();
    }
    #[tokio::test]
    #[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test"]
    async fn owned_links_are_atomic_independent_and_preserve_ids_on_reorder() {
        let url = std::env::var("PANSOU_TEST_DATABASE_URL").unwrap();
        assert!(url::Url::parse(&url).unwrap().path().ends_with("_test"));
        let pool = crate::db::connect(&url).await.unwrap();
        crate::db::init_db(&pool).await.unwrap();
        let a = format!("owned-a-{}", uuid::Uuid::new_v4());
        let b = format!("owned-b-{}", uuid::Uuid::new_v4());
        let links = vec![
            Link {
                r#type: "quark".into(),
                url: format!("https://pan.quark.cn/s/{}", uuid::Uuid::new_v4().simple()),
                password: None,
            },
            Link {
                r#type: "baidu".into(),
                url: format!("https://pan.baidu.com/s/{}", uuid::Uuid::new_v4().simple()),
                password: Some("1234".into()),
            },
        ];
        fixture(&pool, &a, "resource a", json!(links)).await;
        fixture(&pool, &b, "resource b", json!([links[0]])).await;
        let id: uuid::Uuid =
            sqlx::query_scalar("SELECT id FROM resource_links WHERE resource_id=$1 AND position=0")
                .bind(&a)
                .fetch_one(&pool)
                .await
                .unwrap();
        sqlx::query("UPDATE resource_links SET validity=1,checked_at=now(),valid_until=now()+interval '1 hour' WHERE id=$1").bind(id).execute(&pool).await.unwrap();
        let independent: i16 =
            sqlx::query_scalar("SELECT validity FROM resource_links WHERE resource_id=$1")
                .bind(&b)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(independent, -1);
        let before: Vec<(uuid::Uuid, String)> = sqlx::query_as(
            "SELECT id,xmin::text FROM resource_links WHERE resource_id=$1 ORDER BY id",
        )
        .bind(&a)
        .fetch_all(&pool)
        .await
        .unwrap();
        fixture_replace(&pool, &a, json!(links)).await;
        let after: Vec<(uuid::Uuid, String)> = sqlx::query_as(
            "SELECT id,xmin::text FROM resource_links WHERE resource_id=$1 ORDER BY id",
        )
        .bind(&a)
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(before, after);
        fixture_replace(&pool, &a, json!([links[1], links[0]])).await;
        let row = sqlx::query(
            "SELECT id,validity FROM resource_links WHERE resource_id=$1 AND position=1",
        )
        .bind(&a)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.get::<uuid::Uuid, _>("id"), id);
        assert_eq!(row.get::<i16, _>("validity"), 1);
        let mut tx = pool.begin().await.unwrap();
        replace(&mut tx, &a, &[]).await.unwrap();
        tx.rollback().await.unwrap();
        let retained: i64 =
            sqlx::query_scalar("SELECT count(*) FROM resource_links WHERE resource_id=$1")
                .bind(&a)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(retained, 2);
        sqlx::query("DELETE FROM managed_resources WHERE id=ANY($1)")
            .bind(vec![a, b])
            .execute(&pool)
            .await
            .unwrap();
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM resource_links WHERE id=$1)")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(
            !exists,
            "unreferenced links must be physically deleted with their resource"
        );
    }
}

#[cfg(test)]
mod migration_tests {
    use super::*;
    #[tokio::test]
    #[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test"]
    async fn migration_preserves_shared_facts_ids_and_corrects_provider_keys() {
        let url = std::env::var("PANSOU_TEST_DATABASE_URL").unwrap();
        assert!(url::Url::parse(&url).unwrap().path().ends_with("_test"));
        let pool = crate::db::connect(&url).await.unwrap();
        crate::db::init_db(&pool).await.unwrap();
        let mut tx = pool.begin().await.unwrap();
        let schema = format!("owned_migration_{}", uuid::Uuid::new_v4().simple());
        sqlx::raw_sql(&format!(
            "CREATE SCHEMA {schema}; SET LOCAL search_path TO {schema},public"
        ))
        .execute(&mut *tx)
        .await
        .unwrap();
        for script in [
            include_str!("../migrations/044_schema.sql"),
            include_str!("../migrations/046_remove_unused_settings.sql"),
            include_str!("../migrations/047_unify_wechat_settings.sql"),
        ] {
            sqlx::raw_sql(script).execute(&mut *tx).await.unwrap();
        }
        let old_link = Link {
            r#type: "others".into(),
            url: "https://www.guangyapan.com/s/migration-fixture".into(),
            password: Some("1234".into()),
        };
        let normalized = Link {
            r#type: "guangya".into(),
            ..old_link.clone()
        };
        let old_key = crate::link_resolution::fingerprint(&old_link);
        let key = crate::link_resolution::fingerprint(&normalized);
        let id = uuid::Uuid::new_v4();
        sqlx::query("INSERT INTO managed_resources(id,name,links_json) VALUES('a','first',$1),('b','second',$1)").bind(json!([old_link])).execute(&mut *tx).await.unwrap();
        sqlx::query("INSERT INTO link_catalog(id,provider,identity,original_url,original_password,input_fingerprint,validity,checked_at,valid_until) VALUES($1,'others',$2,$2,'1234',$3,1,now(),now()+interval '1 hour')")
            .bind(id).bind(&old_link.url).bind(&old_key).execute(&mut *tx).await.unwrap();
        sqlx::query("CREATE TABLE resource_link_migration_inputs(resource_id text NOT NULL,position integer NOT NULL,link_key text NOT NULL,old_key text NOT NULL,identity text NOT NULL,provider text NOT NULL,url text NOT NULL,password text,PRIMARY KEY(resource_id,position))").execute(&mut *tx).await.unwrap();
        sqlx::query("INSERT INTO resource_link_migration_inputs SELECT id,0,$1,$2,$3,'guangya',$3,'1234' FROM managed_resources")
            .bind(&key).bind(&old_key).bind(&old_link.url).execute(&mut *tx).await.unwrap();
        sqlx::raw_sql(include_str!("../migrations/048_resource_owned_links.sql"))
            .execute(&mut *tx)
            .await
            .unwrap();
        let rows:Vec<(uuid::Uuid,String,String,i16)>=sqlx::query_as("SELECT id,resource_id,input_fingerprint,validity FROM resource_links ORDER BY resource_id").fetch_all(&mut *tx).await.unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].0, id);
        assert_ne!(rows[1].0, id);
        for row in rows {
            assert_eq!(row.2, key);
            assert_eq!(row.3, 1);
        }
        let stored: Value = sqlx::query_scalar("SELECT resource_links_json('b')")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        assert_eq!(stored, json!([normalized]));
        tx.rollback().await.unwrap();
    }
}
