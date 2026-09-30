-- Query indexes for the Rust/PostgreSQL architecture.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_search_logs_user_created
    ON search_logs(user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_search_logs_session_created
    ON search_logs(session_id, created_at DESC, id DESC)
    WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_search_logs_scope_created
    ON search_logs(search_scope, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_search_logs_keyword_trgm
    ON search_logs USING gin(keyword gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_managed_resources_search_trgm
    ON managed_resources USING gin(search_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_managed_resources_cloud_types
    ON managed_resources USING gin(cloud_types_json jsonb_ops);

CREATE INDEX IF NOT EXISTS idx_hot_searches_public_rank
    ON hot_searches(pinned DESC, score DESC, last_searched DESC)
    WHERE status = 'approved';
CREATE INDEX IF NOT EXISTS idx_hot_searches_term_trgm
    ON hot_searches USING gin(term gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_proxy_routes_source_ids
    ON proxy_routes USING gin(source_ids_json jsonb_ops);
CREATE INDEX IF NOT EXISTS idx_proxy_routes_enabled_priority
    ON proxy_routes(priority, id)
    WHERE enabled;
CREATE INDEX IF NOT EXISTS idx_proxy_group_nodes_weight
    ON proxy_group_nodes(group_id, weight DESC, node_id);

CREATE INDEX IF NOT EXISTS idx_users_active_created
    ON users(created_at DESC, id DESC)
    WHERE deleted_at IS NULL;
