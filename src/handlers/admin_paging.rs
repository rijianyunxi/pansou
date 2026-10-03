use crate::error::ApiError;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize, Serialize)]
pub(super) struct PageCursor {
    kind: String,
    filters: Vec<String>,
    page_size: i64,
    pub at: DateTime<Utc>,
    pub id: String,
}

impl PageCursor {
    pub fn parse(
        raw: Option<&str>,
        kind: &str,
        filters: &[String],
        page_size: i64,
    ) -> Result<Option<Self>, ApiError> {
        let Some(raw) = raw else {
            return Ok(None);
        };
        if raw.len() > 4096 {
            return Err(ApiError::BadRequest("分页游标过长".into()));
        }
        let cursor: Self =
            serde_json::from_str(raw).map_err(|_| ApiError::BadRequest("分页游标无效".into()))?;
        if cursor.kind != kind
            || cursor.filters != filters
            || cursor.page_size != page_size
            || cursor.id.is_empty()
        {
            return Err(ApiError::BadRequest("分页游标与筛选条件不匹配".into()));
        }
        Ok(Some(cursor))
    }

    pub fn next(
        kind: &str,
        filters: Vec<String>,
        page_size: i64,
        at: DateTime<Utc>,
        id: String,
    ) -> Value {
        let raw = serde_json::to_string(&Self {
            kind: kind.into(),
            filters,
            page_size,
            at,
            id,
        })
        .expect("serializable cursor");
        // Long search terms still work with page-number fallback; never emit a
        // continuation token that parse() would subsequently reject.
        if raw.len() <= 4096 {
            Value::String(raw)
        } else {
            Value::Null
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{app::AppState, db, redis_store::RedisStore};
    use axum::{
        Router,
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use serde_json::json;
    use std::sync::Arc;
    use tower::ServiceExt;
    use uuid::Uuid;

    async fn get(
        router: &Router,
        token: &str,
        path: &str,
        params: &[(&str, String)],
    ) -> (StatusCode, Value) {
        let query = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(params.iter().map(|(k, v)| (*k, v.as_str())))
            .finish();
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("{path}?{query}"))
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        (
            status,
            serde_json::from_slice(&to_bytes(response.into_body(), 1_000_000).await.unwrap())
                .unwrap(),
        )
    }
    fn ids(response: &Value) -> Vec<Value> {
        response["data"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["id"].clone())
            .collect()
    }

    #[tokio::test]
    #[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test and PANSOU_TEST_REDIS_URL"]
    async fn resource_and_log_cursors_preserve_filters_ties_and_permissions() {
        let database = std::env::var("PANSOU_TEST_DATABASE_URL").unwrap();
        assert!(
            url::Url::parse(&database)
                .unwrap()
                .path()
                .ends_with("_test")
        );
        let redis = std::env::var("PANSOU_TEST_REDIS_URL").unwrap();
        assert_ne!(url::Url::parse(&redis).unwrap().path(), "/0");
        let pool = db::connect(&database).await.unwrap();
        db::init_db(&pool).await.unwrap();
        let state = Arc::new(AppState::new(
            pool.clone(),
            RedisStore::connect(&redis).await.unwrap(),
        ));
        let username = format!("paging_{}", Uuid::new_v4().simple());
        let user: i64 = sqlx::query_scalar("INSERT INTO users(username,username_normalized,password_hash,role,nickname,last_login_ip) VALUES($1,$1,$2,'admin','分页用户','192.0.2.77') RETURNING id")
            .bind(&username).bind(crate::auth::hash_password("fixture").unwrap()).fetch_one(&pool).await.unwrap();
        let session = state.auth().login(&username, "fixture").await.unwrap().0;
        let anon = state.auth().issue(true).await.unwrap();
        let router = crate::app::build_router(state.clone());
        let marker = format!("分页{}", Uuid::new_v4().simple());
        for i in 0..23 {
            sqlx::query("INSERT INTO managed_resources(id,name,links_json,updated_at,deleted_at) VALUES($1,$2,'[{\"type\":\"quark\",\"url\":\"https://pan.quark.cn/s/fixture\"}]','2026-01-01',CASE WHEN $3 THEN now() END)")
                .bind(format!("{marker}_{i:02}")).bind(&marker).bind(i == 22).execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO search_logs(user_id,session_id,keyword,ip,search_scope,created_at) VALUES($1,'paging-session',$2,'unknown',$3,'2026-01-01')")
                .bind(user).bind(&marker).bind(if i % 2 == 0 {"all"} else {"telegram"}).execute(&pool).await.unwrap();
        }
        for (path, params, expected) in [
            (
                "/api/admin/resources",
                vec![
                    ("q", marker.clone()),
                    ("cloudType", "quark".into()),
                    ("pageSize", "5".into()),
                ],
                22,
            ),
            (
                "/api/admin/search-logs",
                vec![("q", marker.clone()), ("pageSize", "5".into())],
                23,
            ),
        ] {
            let (status, first) = get(&router, &session.token, path, &params).await;
            assert_eq!(status, StatusCode::OK, "{first}");
            assert_eq!(first["data"]["total"], expected);
            let token = first["data"]["nextCursor"].as_str().unwrap().to_owned();
            let mut next_params = params.clone();
            next_params.push(("page", "2".into()));
            let (_, direct) = get(&router, &session.token, path, &next_params).await;
            next_params.push(("before", token.clone()));
            let (_, next) = get(&router, &session.token, path, &next_params).await;
            assert_eq!(ids(&direct), ids(&next));
            assert!(ids(&first).iter().all(|id| !ids(&next).contains(id)));
            assert_eq!(
                get(&router, &anon.token, path, &next_params).await.0,
                StatusCode::UNAUTHORIZED
            );
            let mut wrong = next_params.clone();
            wrong[0].1 = "different".into();
            assert_eq!(
                get(&router, &session.token, path, &wrong).await.0,
                StatusCode::BAD_REQUEST
            );
            wrong = next_params.clone();
            wrong[params.len() - 1].1 = "10".into();
            assert_eq!(
                get(&router, &session.token, path, &wrong).await.0,
                StatusCode::BAD_REQUEST
            );
            let mut seen = ids(&first);
            let mut cursor = Some(token);
            let mut page = 2;
            while let Some(before) = cursor {
                let mut query = params.clone();
                query.push(("page", page.to_string()));
                query.push(("before", before));
                let (status, result) = get(&router, &session.token, path, &query).await;
                assert_eq!(status, StatusCode::OK, "{result}");
                for id in ids(&result) {
                    assert!(!seen.contains(&id));
                    seen.push(id);
                }
                cursor = result["data"]["nextCursor"].as_str().map(str::to_owned);
                page += 1;
            }
            assert_eq!(seen.len(), expected as usize);
            let mut malformed = params.clone();
            malformed.push(("before", "not-json".into()));
            assert_eq!(
                get(&router, &session.token, path, &malformed).await.0,
                StatusCode::BAD_REQUEST
            );
            // New rows above the anchor do not shift the next page.
            if path.ends_with("resources") {
                sqlx::query("INSERT INTO managed_resources(id,name,links_json) VALUES($1,$2,'[{\"type\":\"quark\",\"url\":\"https://pan.quark.cn/s/new\"}]')")
                    .bind(format!("{marker}_new")).bind(&marker).execute(&pool).await.unwrap();
            } else {
                sqlx::query("INSERT INTO search_logs(user_id,keyword,ip,search_scope) VALUES($1,$2,'unknown','all')").bind(user).bind(&marker).execute(&pool).await.unwrap();
            }
            assert_eq!(
                ids(&get(&router, &session.token, path, &next_params).await.1),
                ids(&next)
            );
        }
        // Dynamic filters retain username/nickname search and fallback-IP semantics.
        for (params, expected) in [
            (vec![("q", username.clone())], 24),
            (vec![("q", "分页用户".into())], 24),
            (
                vec![
                    ("ip", "192.0.2.77".into()),
                    ("searchScope", "telegram".into()),
                    ("userId", user.to_string()),
                    ("sessionId", "paging-session".into()),
                ],
                11,
            ),
            (
                vec![
                    ("q", marker.clone()),
                    ("from", "1767225600".into()),
                    ("to", "1767225600".into()),
                ],
                23,
            ),
        ] {
            let (status, result) =
                get(&router, &session.token, "/api/admin/search-logs", &params).await;
            assert_eq!(status, StatusCode::OK, "{result}");
            assert_eq!(result["data"]["total"], expected, "{result}");
        }
        let (_, first) = get(
            &router,
            &session.token,
            "/api/admin/search-logs",
            &[("pageSize", "5".into())],
        )
        .await;
        let mut invalid: Value =
            serde_json::from_str(first["data"]["nextCursor"].as_str().unwrap()).unwrap();
        invalid["id"] = json!("invalid-number");
        assert_eq!(
            get(
                &router,
                &session.token,
                "/api/admin/search-logs",
                &[("pageSize", "5".into()), ("before", invalid.to_string())]
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        sqlx::query("DELETE FROM managed_resources WHERE name=$1")
            .bind(&marker)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM search_logs WHERE keyword=$1")
            .bind(&marker)
            .execute(&pool)
            .await
            .unwrap();
        state.auth().revoke_session(&session).await.unwrap();
        state.auth().revoke_session(&anon).await.unwrap();
        sqlx::query("DELETE FROM users WHERE id=$1")
            .bind(user)
            .execute(&pool)
            .await
            .unwrap();
    }
}
