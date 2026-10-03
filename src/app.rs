use crate::{
    auth::Auth, handlers, redis_store::RedisStore, search_cache::SearchCache,
    security::SecurityConfig,
};
use axum::{
    Router,
    routing::{get, post, put},
};
use sqlx::PgPool;
use std::sync::Arc;
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};

#[derive(Clone)]
pub struct AppState {
    pub admin_stats: Arc<crate::admin_stats::AdminStats>,
    pub shutdown: tokio_util::sync::CancellationToken,
    pub started_at: chrono::DateTime<chrono::Utc>,
    pub pool: PgPool,
    pub redis: RedisStore,
    pub http: reqwest::Client,
    pub crawl_http: reqwest::Client,
    pub cloud_http: reqwest::Client,
    #[cfg(test)]
    pub custom_test_base: Option<String>,
    #[cfg(test)]
    pub cloud_test_bases: Option<crate::cloud_drive::TestBases>,
    #[cfg(test)]
    pub cloud_auth_test_base: Option<String>,
    #[cfg(test)]
    pub resolve_test_timeout_seconds: Arc<std::sync::atomic::AtomicU64>,
    pub cloud_slots: Arc<tokio::sync::Semaphore>,
    // Expensive DB searches have a separate budget from outbound HTTP requests.
    pub local_search_slots: Arc<tokio::sync::Semaphore>,
    pub local_search_locks: Arc<crate::local_index::SearchLocks>,
    pub custom_link_refs: Arc<
        tokio::sync::Mutex<
            std::collections::HashMap<String, (chrono::DateTime<chrono::Utc>, String)>,
        >,
    >,
    pub search_cache: Arc<tokio::sync::Mutex<SearchCache>>,
    pub security: SecurityConfig,
}

impl AppState {
    pub fn new(pool: PgPool, redis: RedisStore) -> Self {
        Self {
            admin_stats: Arc::new(crate::admin_stats::AdminStats::default()),
            shutdown: tokio_util::sync::CancellationToken::new(),
            started_at: chrono::Utc::now(),
            pool,
            redis,
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::limited(5))
                .build()
                .expect("http client"),
            crawl_http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .expect("crawl http client"),
            cloud_http: crate::cloud_drive::transport::http_client(),
            #[cfg(test)]
            custom_test_base: None,
            #[cfg(test)]
            cloud_test_bases: None,
            #[cfg(test)]
            cloud_auth_test_base: None,
            #[cfg(test)]
            resolve_test_timeout_seconds: Arc::new(std::sync::atomic::AtomicU64::new(120)),
            cloud_slots: Arc::new(tokio::sync::Semaphore::new(4)),
            local_search_slots: Arc::new(tokio::sync::Semaphore::new(4)),
            local_search_locks: Arc::new(crate::local_index::SearchLocks::default()),
            custom_link_refs: Arc::new(tokio::sync::Mutex::new(Default::default())),
            search_cache: Arc::new(tokio::sync::Mutex::new(SearchCache::default())),
            security: SecurityConfig::from_env(),
        }
    }

    pub fn auth(&self) -> Auth {
        Auth {
            pool: self.pool.clone(),
            redis: self.redis.clone(),
        }
    }
}

fn api_router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/admin/cloud-accounts",get(handlers::cloud_accounts))
        .route("/admin/cloud-accounts/{provider}/login-sessions",post(handlers::cloud_account_start))
        .route("/admin/cloud-accounts/{provider}/login-sessions/{id}",get(handlers::cloud_account_session).delete(handlers::cloud_account_cancel))
        .route("/admin/cloud-accounts/{provider}/import",post(handlers::cloud_account_import))
        .route("/admin/cloud-accounts/{provider}/check",post(handlers::cloud_account_check))
        .route("/admin/cloud-accounts/{provider}/connection",axum::routing::delete(handlers::cloud_account_disconnect))
        .route("/admin/tasks/{kind}", get(handlers::background_tasks))
        .route("/admin/tasks/checks/{id}/retry", post(handlers::background_check_retry))
        .route("/links/resolve", post(crate::link_resolution::resolve))
        .route("/admin/link-cleanup", get(crate::link_resolution::cleanup_jobs))
        .route("/admin/link-cleanup/{id}/retry", post(crate::link_resolution::retry_cleanup))
        .route("/admin/link-cleanup/{id}/ignore", post(crate::link_resolution::ignore_cleanup))
        .route(
            "/settings/cloud-providers",
            get(crate::link_resolution::get_cloud_providers),
        )
        .route(
            "/settings/cloud-providers/{provider}",
            put(crate::link_resolution::put_cloud_provider),
        )
        .route(
            "/settings/cloud-providers/{provider}/delivery",
            axum::routing::delete(crate::link_resolution::clear_cloud_provider_delivery),
        )
        .route(
            "/links/resolve-operations/{key}",
            get(crate::link_resolution::poll),
        )
        .route("/links/status", post(crate::link_resolution::statuses))
        .route(
            "/resources/status",
            post(crate::link_resolution::resource_statuses),
        )
        .route("/admin/cloud-drive/check", post(handlers::cloud_check))
        .route("/admin/cloud-drive/save", post(handlers::cloud_save))
        .route(
            "/admin/cloud-drive/existing",
            post(handlers::cloud_existing),
        )
        .route("/admin/cloud-drive/list", post(handlers::cloud_list))
        .route("/admin/cloud-drive/ping", post(handlers::cloud_ping))
        .route(
            "/admin/cloud-drive/delete-preview",
            post(handlers::cloud_delete_preview),
        )
        .route("/admin/cloud-drive/delete", post(handlers::cloud_delete))
        .route(
            "/admin/cloud-drive/operations/{key}",
            get(handlers::cloud_operation_get),
        )
        .route("/admin/crawl/overview", get(handlers::crawl_overview))
        .route(
            "/admin/runtime/workers/{kind}",
            axum::routing::put(handlers::runtime_worker_update),
        )
        .route(
            "/admin/crawl/default-outbound",
            get(handlers::crawl_default_get).put(handlers::crawl_default_put),
        )
        .route(
            "/admin/crawl/channels",
            get(handlers::crawl_channels).post(handlers::crawl_channel_create),
        )
        .route(
            "/admin/crawl/channels/{channel}",
            get(handlers::crawl_channel_get)
                .put(handlers::crawl_channel_update)
                .delete(handlers::crawl_channel_delete),
        )
        .route(
            "/admin/crawl/channels/{channel}/jobs",
            post(handlers::crawl_job_create),
        )
        .route(
            "/admin/crawl/jobs/{id}/retry",
            post(handlers::crawl_job_retry),
        )
        .route(
            "/admin/crawl/channels/{channel}/messages",
            get(handlers::crawl_messages),
        )
        .route(
            "/admin/crawl/channels/{channel}/messages/action",
            post(handlers::crawl_messages_action),
        )
        .route(
            "/admin/crawl/channels/{channel}/messages/{id}",
            get(handlers::crawl_message_get),
        )
        .route(
            "/admin/crawl/settings",
            get(handlers::crawl_settings_get).put(handlers::crawl_settings_put),
        )
        .route(
            "/admin/crawl/channels/{channel}/failures",
            get(handlers::crawl_failures).post(handlers::crawl_failures_action),
        )
        .route("/health", get(handlers::health))
        .route("/hot-searches", get(handlers::hot_searches))
        .route("/monitor", get(handlers::monitor))
        .route("/search", post(handlers::search_sse))
        .route("/search/json", get(handlers::search_json))
        .route("/account/session", get(handlers::account_session))
        .route("/account/login", post(handlers::account_login))
        .route("/account/logout", post(handlers::account_logout))
        .route("/account/wechat/login", post(handlers::wechat_login))
        .route("/account/wechat/qr/start", post(handlers::wechat_qr_start))
        .route("/account/wechat/qr/poll", get(handlers::wechat_qr_poll))
        .route(
            "/account/wechat/qr/confirm",
            post(handlers::wechat_qr_confirm),
        )
        .route(
            "/account/profile",
            get(handlers::profile_get).put(handlers::profile_put),
        )
        .route(
            "/account/channels",
            get(handlers::channels_get).post(handlers::channels_put),
        )
        .route(
            "/account/channels/{channel}",
            axum::routing::delete(handlers::channel_delete),
        )
        .route(
            "/account/channels/validate",
            post(handlers::channels_validate),
        )
        .route(
            "/settings/search",
            get(handlers::settings_search_get).put(handlers::settings_search_put),
        )
        .route(
            "/settings/sources",
            get(handlers::sources_get).put(handlers::source_put),
        )
        .route(
            "/settings/sources/{id}",
            axum::routing::delete(handlers::source_delete),
        )
        .route(
            "/settings/sources/{id}/enable",
            post(handlers::source_enable),
        )
        .route(
            "/settings/sources/{id}/disable",
            post(handlers::source_disable),
        )
        .route(
            "/settings/source-template",
            get(handlers::source_template_get).put(handlers::source_template_put),
        )
        .route(
            "/settings/user-policy",
            get(handlers::user_policy_get).put(handlers::user_policy_put),
        )
        .route(
            "/settings/baidu",
            get(handlers::cloud_get).put(handlers::cloud_put),
        )
        .route(
            "/settings/quark",
            get(handlers::cloud_get).put(handlers::cloud_put),
        )
        .route("/settings/aliyun", get(handlers::cloud_get).put(handlers::cloud_put))
        .route("/settings/xunlei", get(handlers::cloud_get).put(handlers::cloud_put))
        .route("/settings/guangya", get(handlers::cloud_get).put(handlers::cloud_put))
        .route(
            "/settings/wechat",
            get(handlers::wechat_get).put(handlers::wechat_put),
        )
        .route("/settings/sources/export", get(handlers::sources_export))
        .route("/settings/sources/import", post(handlers::sources_import))
        .route(
            "/admin/account",
            get(handlers::admin_account_get).put(handlers::admin_account_put),
        )
        .route(
            "/admin/resources",
            get(handlers::admin_resources_get).post(handlers::admin_resources_post),
        )
        .route(
            "/admin/resources/enabled",
            post(handlers::admin_resources_enabled),
        )
        .route(
            "/admin/resources/batch-delete",
            post(handlers::admin_resources_batch_delete),
        )
        .route(
            "/admin/resources/check",
            post(handlers::admin_resources_check),
        )
        .route(
            "/admin/resources/cloud-delete",
            post(handlers::admin_resources_cloud_delete),
        )
        .route(
            "/admin/resources/{id}",
            get(handlers::admin_resource_get)
                .put(handlers::admin_resource_update)
                .delete(handlers::admin_resource_delete),
        )
        .route(
            "/admin/resources/{id}/links/check",
            post(crate::link_resolution::admin_resource_link_check),
        )
        .route(
            "/admin/hot-searches",
            get(handlers::admin_hot_searches_get).post(handlers::admin_hot_searches_post),
        )
        .route(
            "/admin/hot-searches/batch-delete",
            post(handlers::admin_hot_searches_batch_delete),
        )
        .route(
            "/admin/hot-searches/status",
            post(handlers::admin_hot_searches_status),
        )
        .route(
            "/admin/hot-searches/pinned",
            post(handlers::admin_hot_searches_pinned),
        )
        .route(
            "/admin/hot-searches/{term}",
            axum::routing::put(handlers::admin_hot_search_update)
                .delete(handlers::admin_hot_search_delete),
        )
        .route(
            "/admin/proxies",
            get(handlers::admin_proxies_get).post(handlers::admin_proxies_post),
        )
        .route(
            "/admin/proxies/{id}",
            axum::routing::put(handlers::admin_proxy_update).delete(handlers::admin_proxy_delete),
        )
        .route(
            "/admin/proxies/{id}/reset",
            post(handlers::admin_proxy_reset),
        )
        .route(
            "/admin/proxies/{id}/references",
            get(handlers::admin_proxy_references),
        )
        .route(
            "/admin/search-logs",
            get(handlers::admin_search_logs_get).delete(handlers::admin_search_logs_delete),
        )
        .route(
            "/admin/search-analytics",
            get(handlers::admin_analytics_get),
        )
        .route(
            "/admin/users",
            get(handlers::admin_users_get).post(handlers::admin_users_post),
        )
        .route(
            "/admin/users/{id}",
            axum::routing::delete(handlers::admin_user_delete),
        )
        .route(
            "/admin/users/{id}/enable",
            post(handlers::admin_user_enable),
        )
        .route(
            "/admin/users/{id}/disable",
            post(handlers::admin_user_disable),
        )
        .route(
            "/admin/users/{id}/channels",
            get(handlers::admin_user_channels_get).delete(handlers::admin_user_channel_delete),
        )
        .route(
            "/admin/users/{id}/sessions",
            axum::routing::delete(handlers::admin_user_sessions_delete),
        )
        .route(
            "/admin/users/{id}/search-logs",
            get(handlers::admin_user_search_logs),
        )
        .route("/admin/monitor/reset", post(handlers::admin_monitor_reset))
        .route("/sources/probe", post(handlers::source_probe))
        .fallback(handlers::api_not_found)
}

pub fn build_router(state: Arc<AppState>) -> Router {
    Router::new()
        .nest("/api", api_router())
        .route("/robots.txt", get(handlers::robots))
        .route("/sitemap.xml", get(handlers::sitemap))
        .nest_service("/assets", ServeDir::new("frontend/dist/assets"))
        .route_service("/favicon.ico", ServeFile::new("frontend/dist/favicon.ico"))
        .route_service("/og.svg", ServeFile::new("frontend/dist/og.svg"))
        .fallback_service(ServeFile::new("frontend/dist/index.html"))
        .layer(axum::middleware::from_fn(private_link_responses))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn private_link_responses(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let private = request.uri().path().starts_with("/api/links/")
        || request.uri().path() == "/api/resources/status"
        || request.uri().path().starts_with("/api/admin/cloud-accounts")
        || ["/api/settings/baidu","/api/settings/quark","/api/settings/aliyun","/api/settings/xunlei","/api/settings/guangya"].contains(&request.uri().path());
    let mut response = next.run(request).await;
    if private {
        response.headers_mut().insert(
            axum::http::header::CACHE_CONTROL,
            axum::http::HeaderValue::from_static("private, no-store"),
        );
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Method, Request, StatusCode},
    };
    use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
    use tower::ServiceExt;

    fn test_router() -> Router {
        // These route-contract tests never connect to external services. Build
        // disconnected clients from typed options so tests contain no database
        // credentials and do not depend on a developer's local .env file.
        let pool = PgPoolOptions::new().connect_lazy_with(PgConnectOptions::new());
        build_router(Arc::new(AppState::new(pool, RedisStore::disconnected())))
    }

    #[tokio::test]
    async fn registers_all_former_dynamic_api_routes_explicitly() {
        let routes = [
            "/api/admin/resources/enabled",
            "/api/admin/resources/batch-delete",
            "/api/admin/resources/check",
            "/api/admin/resources/cloud-delete",
            "/api/admin/resources/resource-id",
            "/api/admin/hot-searches/batch-delete",
            "/api/admin/hot-searches/status",
            "/api/admin/hot-searches/pinned",
            "/api/admin/hot-searches/search-term",
            "/api/admin/proxies/proxy-id",
            "/api/admin/crawl/overview",
            "/api/admin/crawl/channels/channel-id/messages/1",
            "/api/admin/crawl/settings",
            "/api/admin/crawl/channels/channel-id/failures",
            "/api/admin/proxies/proxy-id/references",
            "/api/admin/proxies/proxy-id/reset",
            "/api/admin/users/1",
            "/api/admin/users/1/enable",
            "/api/admin/users/1/disable",
            "/api/admin/users/1/channels",
            "/api/admin/users/1/sessions",
            "/api/admin/users/1/search-logs",
            "/api/settings/sources/source-id",
            "/api/settings/sources/source-id/enable",
            "/api/settings/sources/source-id/disable",
            "/api/account/channels/channel-name",
        ];
        for path in routes {
            let response = test_router()
                .oneshot(
                    Request::builder()
                        .method(Method::OPTIONS)
                        .uri(path)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::METHOD_NOT_ALLOWED,
                "route not registered: {path}"
            );
        }
    }

    #[tokio::test]
    async fn unknown_api_returns_json_404_instead_of_spa_html() {
        let response = test_router()
            .oneshot(
                Request::builder()
                    .uri("/api/does-not-exist")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            response
                .headers()
                .get("content-type")
                .and_then(|value| value.to_str().ok()),
            Some("application/json")
        );
    }
}
