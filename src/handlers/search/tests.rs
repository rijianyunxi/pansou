#[tokio::test]
async fn custom_channels_use_builtin_parser_without_default_configuration() {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .acquire_timeout(std::time::Duration::from_millis(100))
        .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
        .unwrap();
    let state = crate::app::AppState::new(pool, crate::redis_store::RedisStore::disconnected());
    let channels = vec!["https://t.me/s/Test_channel".to_owned()];
    let sources = super::load_sources(&state, None, Some(&channels))
        .await
        .unwrap();
    assert!(sources.local_channels.is_empty());
    assert_eq!(sources.live_sources.len(), 1);
    let source = &sources.live_sources[0];
    assert_eq!(source.id, "custom:test_channel");
    assert_eq!(source.transform, crate::telegram::BUILTIN_TRANSFORM);
    let html = r#"<div class="tgme_widget_message"><div class="tgme_widget_message_text">示例资源 <a href="https://pan.quark.cn/s/example">网盘</a></div></div>"#;
    let results = crate::transform::apply(&source.transform, html, "html", "", &source.id).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].links[0].url, "https://pan.quark.cn/s/example");
}
use super::sources::SearchSources;
use super::*;
use crate::models::Link;

fn result(id: &str, name: &str) -> SearchResult {
    SearchResult {
        id: id.into(),
        name: name.into(),
        description: None,
        datetime: None,
        cloud_types: vec!["quark".into()],
        links: vec![Link {
            r#type: "quark".into(),
            url: "https://pan.quark.cn/s/same-share".into(),
            password: None,
        }],
        tags: None,
        images: None,
    }
}

#[test]
fn search_keeps_local_first_and_leaves_duplicates_to_clients() {
    let local = result("local", "采集标题");
    let live = result("live", "外部标题");
    let output = finalize_search(vec![local, live.clone(), live], vec![], true);
    assert_eq!(output.total, 3);
    assert_eq!(output.results[0].id, "local");
    assert_eq!(output.results[1].id, "live");
    assert_eq!(output.results[2].id, "live");
    let payload = search_json_payload(output, None);
    assert_eq!(payload["data"]["results"].as_array().unwrap().len(), 3);
    assert_eq!(payload["data"]["total"], 3);
    assert_eq!(payload["data"]["sources"], json!([]));
}

#[test]
fn local_only_json_has_flat_results_without_source_metadata() {
    let payload = search_json_payload(
        finalize_search(vec![result("local", "采集标题")], vec![], true),
        Some(7),
    );
    assert_eq!(payload["data"]["total"], 1);
    assert_eq!(payload["data"]["searchLogId"], 7);
    assert_eq!(payload["data"]["sources"], json!([]));
    assert_eq!(payload["data"]["results"][0]["name"], "采集标题");
    for key in [
        "priority",
        "sourceId",
        "proxyNodes",
        "transformMs",
        "elapsedMs",
    ] {
        assert!(payload["data"]["results"][0].get(key).is_none());
    }
}

#[tokio::test]
async fn custom_scope_validates_only_submitted_channels_without_resource_io() {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
        .unwrap();
    let state = AppState::new(pool, crate::redis_store::RedisStore::disconnected());
    let session = crate::auth::Session {
        token: "unit-test".into(),
        user_id: Some(1),
    };
    let mut req:SearchRequest=serde_json::from_value(json!({"kw":"x","channels":["@Example_Channel","https://t.me/s/another"],"source_ids":["ignore-system"]})).unwrap();
    resolve_custom_channels(
        &state,
        &session,
        &mut req,
        &crate::policy::UserPolicy::default(),
    )
    .await
    .unwrap();
    assert_eq!(req.channels.unwrap(), vec!["another", "example_channel"]);
    assert!(req.source_ids.is_none());
    let mut invalid: SearchRequest =
        serde_json::from_value(json!({"kw":"x","channels":["https://example.com/not-a-channel"]}))
            .unwrap();
    assert!(
        resolve_custom_channels(
            &state,
            &session,
            &mut invalid,
            &crate::policy::UserPolicy::default()
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn execution_returns_local_batch_before_polling_live_sources() {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .acquire_timeout(Duration::from_millis(500))
        .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
        .unwrap();
    let state = AppState::new(pool, crate::redis_store::RedisStore::disconnected());
    let sources = SearchSources {
        local_channels: vec![],
        live_sources: vec![Source {
            id: "live".into(),
            name: "live".into(),
            description: "".into(),
            url: "http://127.0.0.1:1/live".into(),
            method: "GET".into(),
            format: "json".into(),
            priority: 0,
            enabled: true,
            request: None,
            transform: "".into(),
        }],
    };
    let stream = source_execution_stream(
        state,
        sources,
        "test".into(),
        1,
        crate::policy::UserPolicy::default(),
    );
    futures::pin_mut!(stream);
    let (meta, results) = tokio::time::timeout(Duration::from_millis(100), stream.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(meta.is_none());
    assert!(results.is_empty());
}

#[test]
fn sse_events_use_real_line_breaks() {
    let event = encode_sse_event(3, "complete", json!({"total": 1}));
    assert_eq!(event, "id: 3\nevent: complete\ndata: {\"total\":1}\n\n");
    assert!(!event.contains("\\n"));
}
#[test]
fn sse_payload_contract_matches_main_without_source_identity() {
    let start = sse_start_payload(Some(42));
    assert_eq!(start["intervalMs"], SEARCH_SSE_INTERVAL_MS);
    assert_eq!(start["searchLogId"], 42);
    assert_eq!(start.as_object().map(serde_json::Map::len), Some(3));
    assert_eq!(start["contractVersion"], 2);

    let result = sse_result_payload(Vec::new());
    assert!(result["results"].is_array());
    assert_eq!(result.as_object().map(serde_json::Map::len), Some(1));
    assert!(result.get("sourceId").is_none());
    assert!(result.get("plugin").is_none());

    let complete = sse_complete_payload(7);
    assert_eq!(complete["total"], 7);
    assert_eq!(complete.as_object().map(serde_json::Map::len), Some(1));
    assert!(complete.get("searchLogId").is_none());
}
#[test]
fn search_json_contract_matches_public_api_shape() {
    let result = SearchResult {
        id: "result-1".into(),
        name: "demo".into(),
        description: None,
        datetime: Some("2026-09-29 12:00:00".into()),
        cloud_types: vec!["quark".into()],
        links: vec![Link {
            r#type: "quark".into(),
            url: "https://pan.quark.cn/s/demo".into(),
            password: None,
        }],
        tags: None,
        images: None,
    };
    let payload = search_json_payload(
        SearchResponse {
            total: 1,
            results: vec![result.clone()],
            sources: Some(vec![SourceMeta {
                id: "pansearch".into(),
                name: "PanSearch".into(),
                priority: 0,
                status: "success".into(),
                result_count: 1,
                elapsed_ms: 20,
                transform_ms: Some(2),
                proxy_nodes: vec![json!({"nodeId":"edge-1","status":"success"})],
                results: vec![result],
            }]),
        },
        Some(42),
    );
    assert_eq!(payload["code"], 0);
    assert_eq!(payload["message"], "success");
    assert_eq!(payload["data"]["total"], 1);
    assert_eq!(payload["data"]["searchLogId"], 42);
    assert_eq!(payload["data"]["results"][0]["id"], "result-1");
    assert!(payload["data"]["results"][0].get("priority").is_none());
    let source = &payload["data"]["sources"][0];
    for key in [
        "id",
        "name",
        "priority",
        "status",
        "resultCount",
        "elapsedMs",
        "transformMs",
        "proxyNodes",
        "results",
    ] {
        assert!(source.get(key).is_some(), "missing field: {key}");
    }
}
