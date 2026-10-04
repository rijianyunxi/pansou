-- Final schema baseline, replacing historical migrations 001–043.
-- SQLx runs this file transactionally on an empty database.
-- Existing databases must be structurally verified and re-baselined before startup.

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

CREATE FUNCTION enqueue_link_aggregate() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 INSERT INTO link_aggregate_queue(resource_id)
 SELECT DISTINCT resource_id FROM resource_link_bindings WHERE link_id=NEW.id ORDER BY resource_id
 ON CONFLICT(resource_id) DO UPDATE SET updated_at=excluded.updated_at;
 RETURN NULL;
END $$;

CREATE FUNCTION enqueue_link_sync() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 INSERT INTO link_sync_queue(resource_id) VALUES(NEW.id)
 ON CONFLICT(resource_id) DO UPDATE SET updated_at=now();
 RETURN NULL;
END $$;

CREATE FUNCTION invalidate_local_index() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 UPDATE config_revisions SET revision=revision+1 WHERE scope='local-index';
 RETURN NULL;
END $$;

CREATE FUNCTION lock_local_index_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 PERFORM revision FROM config_revisions WHERE scope='local-index' FOR UPDATE;
 RETURN NULL;
END $$;

CREATE FUNCTION notify_crawl_policy_wakeup() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF COALESCE(NEW.key,OLD.key) IN ('background-workers','search') THEN
  PERFORM pg_notify('pansou_crawl_wakeup','');
 END IF;
 RETURN NULL;
END;
$$;

CREATE FUNCTION notify_crawl_wakeup() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 PERFORM pg_notify('pansou_crawl_wakeup','');
 RETURN NULL;
END;
$$;

CREATE FUNCTION notify_link_account_wakeup() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 PERFORM pg_notify('pansou_worker_settings_wakeup','');
 RETURN NULL;
END;
$$;

CREATE FUNCTION notify_worker_settings_wakeup() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF COALESCE(NEW.key,OLD.key) IN ('background-workers','link-check') THEN
  PERFORM pg_notify('pansou_worker_settings_wakeup','');
 END IF;
 RETURN NULL;
END;
$$;

CREATE FUNCTION prepare_original_check_job() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 SELECT c.provider INTO NEW.provider FROM link_catalog c WHERE c.id=NEW.link_id;
 IF NEW.kind='original' AND NEW.status='queued' THEN
  SELECT COALESCE(c.next_check_at,'infinity'::timestamptz) INTO NEW.run_after
  FROM link_catalog c WHERE c.id=NEW.link_id AND c.input_version=NEW.input_version;
  NEW.run_after:=COALESCE(NEW.run_after,'infinity'::timestamptz);
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION prune_crawl_tasks(ch text) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
DECLARE removed BIGINT;
BEGIN
 DELETE FROM crawl_message_tasks WHERE (ch IS NULL OR channel_id=ch) AND status<>'failed'
 AND task_at < (date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai');
 GET DIAGNOSTICS removed=ROW_COUNT;
 RETURN removed;
END $$;

CREATE FUNCTION reschedule_original_check_jobs() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 UPDATE link_check_jobs SET provider=NEW.provider,
  run_after=COALESCE(NEW.next_check_at,'infinity'::timestamptz)
 WHERE link_id=NEW.id AND input_version=NEW.input_version AND kind='original'
  AND status='queued'
  AND (provider,run_after) IS DISTINCT FROM
   (NEW.provider,COALESCE(NEW.next_check_at,'infinity'::timestamptz));
 RETURN NEW;
END $$;

CREATE FUNCTION resource_cloud_types(links jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
 SELECT COALESCE(jsonb_agg(provider ORDER BY provider COLLATE "C"),'[]'::jsonb)
 FROM (
  SELECT DISTINCT link->>'type' AS provider
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(links)='array' THEN links ELSE '[]'::jsonb END) AS entry(link)
  WHERE jsonb_typeof(link->'type')='string' AND link->>'type'<>''
 ) providers
$$;

CREATE FUNCTION resource_name_grams(title text) RETURNS text[]
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $_$
 SELECT COALESCE(array_agg(DISTINCT gram ORDER BY gram),'{}'::text[])
 FROM (
  SELECT substring(lower(title) FROM p FOR n) gram
  FROM generate_series(1,char_length(title)) p CROSS JOIN generate_series(1,2) n
  WHERE p+n-1<=char_length(title)
  AND substring(lower(title) FROM p FOR n)~'^[[:alnum:]]+$'
 ) pieces
$_$;

CREATE FUNCTION revise_resource_links() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NEW.links_json IS DISTINCT FROM OLD.links_json THEN
  NEW.links_revision=OLD.links_revision+1;
  NEW.link_validity=-1; NEW.link_validity_updated_at=NULL;
 END IF;
 RETURN NEW;
END $$;

CREATE TABLE auth_identities (
    provider text NOT NULL,
    provider_app_id text NOT NULL,
    subject text NOT NULL,
    provider_union_id text,
    user_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE cloud_account_aliases (
    provider text NOT NULL,
    legacy_key text NOT NULL,
    account_key text NOT NULL,
    verified_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE cloud_account_settings (
    provider text NOT NULL,
    credential text DEFAULT ''::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    account_key text,
    subject_id text,
    display_name text,
    storage_scope text DEFAULT ''::text NOT NULL,
    auth_status text DEFAULT 'unverified'::text NOT NULL,
    auth_source text DEFAULT 'import'::text NOT NULL,
    refreshable boolean DEFAULT false NOT NULL,
    token_revision bigint DEFAULT 0 NOT NULL,
    binding_epoch bigint DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone,
    next_check_at timestamp with time zone DEFAULT now() NOT NULL,
    last_verified_at timestamp with time zone,
    last_refresh_at timestamp with time zone,
    last_error_code text,
    refresh_lease uuid,
    refresh_lease_until timestamp with time zone,
    refresh_started_at timestamp with time zone,
    pending_refresh_credential text
);

CREATE TABLE cloud_delete_previews (
    token uuid NOT NULL,
    actor_id bigint NOT NULL,
    fingerprint text NOT NULL,
    files_json jsonb NOT NULL,
    used_by uuid,
    expires_at timestamp with time zone DEFAULT (now() + '00:05:00'::interval) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE cloud_drive_operations (
    request_key uuid NOT NULL,
    actor_id bigint NOT NULL,
    provider text NOT NULL,
    action text NOT NULL,
    fingerprint text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    http_status integer DEFAULT 202 NOT NULL,
    response_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '00:04:00'::interval) NOT NULL,
    CONSTRAINT cloud_drive_operations_action_check CHECK ((action = ANY (ARRAY['save'::text, 'existing'::text, 'delete'::text]))),
    CONSTRAINT cloud_drive_operations_provider_check CHECK ((provider = ANY (ARRAY['baidu'::text, 'quark'::text, 'aliyun'::text, 'xunlei'::text, 'guangya'::text]))),
    CONSTRAINT cloud_drive_operations_status_check CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text, 'uncertain'::text])))
);

CREATE TABLE cloud_login_sessions (
    id uuid NOT NULL,
    actor_id bigint NOT NULL,
    provider text NOT NULL,
    intent text NOT NULL,
    expected_epoch bigint NOT NULL,
    status text DEFAULT 'starting'::text NOT NULL,
    qr_image text,
    error_code text,
    interval_seconds integer DEFAULT 3 NOT NULL,
    next_poll_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    poll_lease uuid,
    poll_lease_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    context_json text,
    CONSTRAINT cloud_login_sessions_intent_check CHECK ((intent = ANY (ARRAY['connect'::text, 'reauthorize'::text, 'replace'::text]))),
    CONSTRAINT cloud_login_sessions_provider_check CHECK ((provider = ANY (ARRAY['baidu'::text, 'quark'::text, 'aliyun'::text, 'xunlei'::text, 'guangya'::text])))
);

CREATE TABLE cloud_provider_policies (
    provider text NOT NULL,
    delivery_enabled boolean DEFAULT false NOT NULL,
    target_dir text,
    target_dir_name text DEFAULT ''::text NOT NULL,
    retention_seconds integer,
    delivery_min_remaining_seconds integer DEFAULT 300 NOT NULL,
    platform_share_days integer DEFAULT 7 NOT NULL,
    check_interval_seconds integer DEFAULT 2 NOT NULL,
    check_valid_seconds integer DEFAULT 86400 NOT NULL,
    check_invalid_seconds integer DEFAULT 604800 NOT NULL,
    check_daily_budget integer DEFAULT 1000 NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cloud_provider_policies_check CHECK (((delivery_enabled = false) OR ((retention_seconds IS NOT NULL) AND ((retention_seconds >= 60) AND (retention_seconds <= 2592000))))),
    CONSTRAINT cloud_provider_policies_check_daily_budget_check CHECK (((check_daily_budget >= 1) AND (check_daily_budget <= 100000))),
    CONSTRAINT cloud_provider_policies_check_interval_seconds_check CHECK (((check_interval_seconds >= 2) AND (check_interval_seconds <= 3600))),
    CONSTRAINT cloud_provider_policies_check_invalid_seconds_check CHECK (((check_invalid_seconds >= 60) AND (check_invalid_seconds <= 2592000))),
    CONSTRAINT cloud_provider_policies_check_valid_seconds_check CHECK (((check_valid_seconds >= 60) AND (check_valid_seconds <= 2592000))),
    CONSTRAINT cloud_provider_policies_delivery_min_remaining_seconds_check CHECK ((delivery_min_remaining_seconds >= 0)),
    CONSTRAINT cloud_provider_policies_platform_share_days_check CHECK ((platform_share_days = ANY (ARRAY[1, 7, 30]))),
    CONSTRAINT cloud_provider_policies_provider_check CHECK ((provider = ANY (ARRAY['baidu'::text, 'quark'::text, 'aliyun'::text, 'xunlei'::text, 'guangya'::text])))
);

CREATE TABLE config_revisions (
    scope text NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT config_revisions_revision_check CHECK ((revision >= 0))
);

CREATE TABLE crawl_channels (
    id text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    newest_message bigint DEFAULT 0 NOT NULL,
    oldest_message bigint,
    last_synced_at timestamp with time zone,
    next_sync_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error text,
    coverage text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    transform text,
    version bigint DEFAULT 1 NOT NULL,
    history_complete boolean DEFAULT false NOT NULL,
    history_cursor bigint,
    history_pages integer DEFAULT 0 NOT NULL,
    next_page_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE crawl_jobs (
    id bigint NOT NULL,
    channel_id text NOT NULL,
    kind text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    cursor_before bigint,
    stop_at bigint DEFAULT 0 NOT NULL,
    head_message bigint,
    pages integer DEFAULT 0 NOT NULL,
    messages integer DEFAULT 0 NOT NULL,
    resources integer DEFAULT 0 NOT NULL,
    failures integer DEFAULT 0 NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_run_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_id uuid,
    lease_until timestamp with time zone,
    last_error text,
    stop_reason text,
    diagnostics_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    request_key text,
    failure_id bigint,
    CONSTRAINT crawl_jobs_kind_check CHECK ((kind = ANY (ARRAY['sync'::text, 'backfill'::text, 'retry'::text]))),
    CONSTRAINT crawl_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'failed'::text, 'paused'::text, 'cancelled'::text])))
);

CREATE SEQUENCE crawl_jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE crawl_jobs_id_seq OWNED BY crawl_jobs.id;

CREATE TABLE crawl_message_tasks (
    channel_id text NOT NULL,
    message_id bigint NOT NULL,
    task_at timestamp with time zone DEFAULT now() NOT NULL,
    status text NOT NULL,
    error_message text,
    resource_ids text[] DEFAULT '{}'::text[] NOT NULL,
    CONSTRAINT crawl_message_tasks_check CHECK (((status = 'failed'::text) OR (error_message IS NULL))),
    CONSTRAINT crawl_message_tasks_status_check CHECK ((status = ANY (ARRAY['parsed'::text, 'empty'::text, 'failed'::text])))
);

CREATE TABLE crawl_page_failures (
    id bigint NOT NULL,
    channel_id text NOT NULL,
    job_id bigint,
    kind text NOT NULL,
    cursor_before bigint,
    next_cursor bigint,
    page_number integer,
    last_error text NOT NULL,
    retry_job_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crawl_page_failures_kind_check CHECK ((kind = ANY (ARRAY['sync'::text, 'backfill'::text]))),
    CONSTRAINT crawl_page_failures_page_number_check CHECK ((page_number > 0))
);

CREATE SEQUENCE crawl_page_failures_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE crawl_page_failures_id_seq OWNED BY crawl_page_failures.id;

CREATE TABLE crawl_settings (
    id integer NOT NULL,
    concurrent_channels integer DEFAULT 3 NOT NULL,
    page_delay_seconds integer DEFAULT 3 NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    daily_cron text DEFAULT '0 */10 * * * *'::text NOT NULL,
    CONSTRAINT crawl_settings_concurrent_channels_check CHECK (((concurrent_channels >= 1) AND (concurrent_channels <= 32))),
    CONSTRAINT crawl_settings_daily_cron_check CHECK (((daily_cron IS NULL) OR ((length(daily_cron) >= 1) AND (length(daily_cron) <= 200)))),
    CONSTRAINT crawl_settings_id_check CHECK ((id = 1)),
    CONSTRAINT crawl_settings_page_delay_seconds_check CHECK (((page_delay_seconds >= 0) AND (page_delay_seconds <= 3600))),
    CONSTRAINT crawl_settings_six_field_cron CHECK ((cardinality(regexp_split_to_array(TRIM(BOTH FROM daily_cron), '\s+'::text)) = 6))
);

CREATE TABLE hot_searches (
    term text NOT NULL,
    normalized_term text DEFAULT ''::text NOT NULL,
    score bigint DEFAULT 0 NOT NULL,
    last_searched timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'approved'::text NOT NULL,
    source text DEFAULT 'auto'::text NOT NULL,
    pinned boolean DEFAULT false NOT NULL,
    manual_weight integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE link_aggregate_queue (
    resource_id text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE link_catalog (
    id uuid NOT NULL,
    provider text NOT NULL,
    identity text NOT NULL,
    original_url text NOT NULL,
    original_password text,
    input_fingerprint text NOT NULL,
    input_version bigint DEFAULT 1 NOT NULL,
    validity smallint DEFAULT '-1'::integer NOT NULL,
    checked_at timestamp with time zone,
    valid_until timestamp with time zone,
    last_attempt_at timestamp with time zone,
    next_check_at timestamp with time zone,
    last_error_code text,
    failure_count integer DEFAULT 0 NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT link_catalog_failure_count_check CHECK ((failure_count >= 0)),
    CONSTRAINT link_catalog_validity_check CHECK ((validity = ANY (ARRAY['-1'::integer, 0, 1])))
);

CREATE TABLE link_check_enqueue_cursors (
    provider text NOT NULL,
    next_check_at timestamp with time zone,
    link_id uuid,
    CONSTRAINT link_check_enqueue_cursors_check CHECK (((next_check_at IS NULL) = (link_id IS NULL))),
    CONSTRAINT link_check_enqueue_cursors_provider_check CHECK ((provider = ANY (ARRAY['baidu'::text, 'quark'::text, 'aliyun'::text, 'xunlei'::text, 'guangya'::text])))
);

CREATE TABLE link_check_jobs (
    id bigint NOT NULL,
    link_id uuid NOT NULL,
    input_version bigint NOT NULL,
    kind text NOT NULL,
    share_cache_id uuid,
    status text DEFAULT 'queued'::text NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    run_after timestamp with time zone DEFAULT now() NOT NULL,
    lease_token uuid,
    lease_until timestamp with time zone,
    last_error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    provider text NOT NULL,
    CONSTRAINT link_check_jobs_check CHECK ((((kind = 'original'::text) AND (share_cache_id IS NULL)) OR ((kind = 'reshared'::text) AND (share_cache_id IS NOT NULL)))),
    CONSTRAINT link_check_jobs_kind_check CHECK ((kind = ANY (ARRAY['original'::text, 'reshared'::text]))),
    CONSTRAINT link_check_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'failed'::text]))),
    CONSTRAINT link_check_original_priority CHECK (((kind <> 'original'::text) OR (priority = ANY (ARRAY[0, 1, 10]))))
);

CREATE SEQUENCE link_check_jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE link_check_jobs_id_seq OWNED BY link_check_jobs.id;

CREATE TABLE link_cleanup_jobs (
    id bigint NOT NULL,
    share_cache_id uuid NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    stage text DEFAULT 'verify'::text NOT NULL,
    progress_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    run_after timestamp with time zone NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    lease_token uuid,
    lease_until timestamp with time zone,
    last_error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT link_cleanup_jobs_stage_check CHECK ((stage = ANY (ARRAY['verify'::text, 'revoke_shares'::text, 'delete_files'::text, 'verify_deleted'::text]))),
    CONSTRAINT link_cleanup_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'failed'::text, 'blocked'::text, 'ignored'::text])))
);

CREATE SEQUENCE link_cleanup_jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE link_cleanup_jobs_id_seq OWNED BY link_cleanup_jobs.id;

CREATE TABLE link_resolve_requests (
    id uuid NOT NULL,
    request_key uuid NOT NULL,
    subject_key text NOT NULL,
    user_id bigint,
    request_fingerprint text NOT NULL,
    link_id uuid NOT NULL,
    share_cache_id uuid,
    authorization_json jsonb NOT NULL,
    status text NOT NULL,
    delivery text,
    reason_code text,
    result_kind text,
    response_json jsonb,
    deadline_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    expires_at timestamp with time zone DEFAULT (now() + '7 days'::interval) NOT NULL,
    progress_stage text DEFAULT 'queued'::text NOT NULL,
    CONSTRAINT link_resolve_requests_progress_stage_check CHECK ((progress_stage = ANY (ARRAY['queued'::text, 'checking'::text, 'transferring'::text, 'sharing'::text, 'reusing'::text]))),
    CONSTRAINT link_resolve_requests_result_kind_check CHECK ((result_kind = ANY (ARRAY['available'::text, 'unavailable'::text]))),
    CONSTRAINT link_resolve_requests_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'failed'::text])))
);

CREATE TABLE link_share_cache (
    id uuid NOT NULL,
    link_id uuid NOT NULL,
    input_version bigint NOT NULL,
    target_account_key text NOT NULL,
    account_revision bigint NOT NULL,
    policy_revision bigint NOT NULL,
    target_dir text NOT NULL,
    state text NOT NULL,
    generation integer DEFAULT 1 NOT NULL,
    owned_dir_id text,
    owned_dir_path text,
    ownership_manifest_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    upstream_share_ids_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    retention_seconds integer NOT NULL,
    cleanup_after timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone,
    target_files_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    upstream_task_id text,
    share_url text,
    share_password text,
    share_validity smallint DEFAULT '-1'::integer NOT NULL,
    share_checked_at timestamp with time zone,
    share_valid_until timestamp with time zone,
    share_expires_at timestamp with time zone,
    lease_token uuid,
    lease_until timestamp with time zone,
    last_error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT link_share_cache_check CHECK (((state <> 'ready'::text) OR (length(share_url) > 0))),
    CONSTRAINT link_share_cache_generation_check CHECK ((generation > 0)),
    CONSTRAINT link_share_cache_retention_seconds_check CHECK ((retention_seconds > 0)),
    CONSTRAINT link_share_cache_share_validity_check CHECK ((share_validity = ANY (ARRAY['-1'::integer, 0, 1]))),
    CONSTRAINT link_share_cache_state_check CHECK ((state = ANY (ARRAY['saving'::text, 'saved'::text, 'sharing'::text, 'ready'::text, 'invalid'::text, 'uncertain'::text, 'failed'::text, 'expiring'::text, 'cleaning'::text, 'deleted'::text])))
);

CREATE TABLE link_sync_queue (
    resource_id text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE managed_resources (
    id text NOT NULL,
    name text NOT NULL,
    description text,
    datetime text,
    links_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    images_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    origin text DEFAULT 'manual'::text NOT NULL,
    fingerprint text,
    published_at timestamp with time zone,
    link_validity smallint DEFAULT '-1'::integer NOT NULL,
    link_validity_updated_at timestamp with time zone,
    links_revision bigint DEFAULT 1 NOT NULL,
    source_channel_ids text[] DEFAULT '{}'::text[] NOT NULL,
    source_channel_id text,
    source_message_id bigint,
    name_grams text[] GENERATED ALWAYS AS (resource_name_grams(name)) STORED,
    CONSTRAINT managed_resources_link_validity_check CHECK ((link_validity = ANY (ARRAY['-1'::integer, 0, 1])))
);

CREATE TABLE outbound_policies (
    id bigint NOT NULL,
    source_id text,
    channel_id text,
    version bigint DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT outbound_policy_owner CHECK ((num_nonnulls(source_id, channel_id) = 1))
);

CREATE SEQUENCE outbound_policies_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE outbound_policies_id_seq OWNED BY outbound_policies.id;

CREATE TABLE outbound_policy_nodes (
    policy_id bigint NOT NULL,
    node_id text NOT NULL,
    weight integer NOT NULL,
    CONSTRAINT outbound_policy_nodes_weight_check CHECK (((weight >= 0) AND (weight <= 10000)))
);

CREATE TABLE policy_settings (
    key text NOT NULL,
    value_json jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE proxy_nodes (
    id text NOT NULL,
    name text NOT NULL,
    base_url text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    daily_limit integer DEFAULT 0 NOT NULL,
    quota_day date,
    quota_used integer DEFAULT 0 NOT NULL,
    circuit_state text DEFAULT 'closed'::text NOT NULL,
    failure_count integer DEFAULT 0 NOT NULL,
    probe_in_flight boolean DEFAULT false NOT NULL,
    opened_until timestamp with time zone,
    last_status integer,
    last_error text,
    last_success_at timestamp with time zone,
    last_failure_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    probe_lease_until timestamp with time zone,
    kind text DEFAULT 'proxy'::text NOT NULL,
    CONSTRAINT proxy_node_kind_url CHECK ((((kind = 'direct'::text) AND (id = 'direct'::text) AND (base_url = ''::text) AND enabled AND (daily_limit = 0)) OR ((kind = 'proxy'::text) AND (id <> 'direct'::text) AND (base_url <> ''::text)))),
    CONSTRAINT proxy_nodes_kind_check CHECK ((kind = ANY (ARRAY['proxy'::text, 'direct'::text])))
);

CREATE TABLE resource_link_bindings (
    resource_id text NOT NULL,
    link_key text NOT NULL,
    link_id uuid NOT NULL,
    links_revision bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE resource_sources (
    id text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    url text NOT NULL,
    method text NOT NULL,
    format text NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    request_json jsonb,
    transform text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    channel_id text,
    kind text DEFAULT 'live'::text NOT NULL,
    CONSTRAINT resource_sources_format_check CHECK ((format = ANY (ARRAY['json'::text, 'html'::text, 'text'::text]))),
    CONSTRAINT resource_sources_kind_check CHECK ((kind = ANY (ARRAY['live'::text, 'telegram'::text]))),
    CONSTRAINT resource_sources_method_check CHECK ((method = ANY (ARRAY['GET'::text, 'POST'::text])))
);

CREATE TABLE search_logs (
    id bigint NOT NULL,
    session_id text,
    user_id bigint,
    keyword text NOT NULL,
    ip text NOT NULL,
    search_scope text NOT NULL,
    channels_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    source_ids_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text DEFAULT 'started'::text NOT NULL,
    result_count integer DEFAULT 0 NOT NULL,
    has_results boolean DEFAULT false NOT NULL,
    source_result_counts_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    completed_at timestamp with time zone,
    outcome_recorded boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE search_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE search_logs_id_seq OWNED BY search_logs.id;

CREATE TABLE search_setting_sources (
    source_id text NOT NULL
);

CREATE TABLE search_settings (
    id smallint NOT NULL,
    concurrency integer,
    sources_configured boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT search_settings_id_check CHECK ((id = 1))
);

CREATE TABLE source_health (
    source_id text NOT NULL,
    snapshot_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE system_settings (
    id smallint NOT NULL,
    default_concurrency integer DEFAULT 8 NOT NULL,
    request_timeout_ms integer DEFAULT 15000 NOT NULL,
    cache_ttl_minutes integer DEFAULT 5 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT system_settings_id_check CHECK ((id = 1))
);

CREATE TABLE users (
    id bigint NOT NULL,
    username text NOT NULL,
    username_normalized text NOT NULL,
    password_hash text NOT NULL,
    nickname text,
    role text DEFAULT 'user'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    custom_channels_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    custom_channels_updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_login_ip text,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);

CREATE SEQUENCE users_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE users_id_seq OWNED BY users.id;

CREATE TABLE wechat_mini_settings (
    id smallint NOT NULL,
    app_id text DEFAULT ''::text NOT NULL,
    secret text DEFAULT ''::text NOT NULL,
    qr_page text DEFAULT 'pages/login/index'::text NOT NULL,
    env_version text DEFAULT 'release'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT wechat_mini_settings_id_check CHECK ((id = 1))
);

CREATE TABLE worker_lane_metrics (
    lane text NOT NULL,
    processed bigint DEFAULT 0 NOT NULL,
    runs bigint DEFAULT 0 NOT NULL,
    failures bigint DEFAULT 0 NOT NULL,
    last_duration_ms bigint DEFAULT 0 NOT NULL,
    last_success_at timestamp with time zone,
    last_error_at timestamp with time zone,
    last_error_code text
);

CREATE TABLE worker_schedule_slots (
    task text NOT NULL,
    next_run_at timestamp with time zone NOT NULL
);

CREATE TABLE worker_task_runs (
    id bigint NOT NULL,
    lane text NOT NULL,
    status text NOT NULL,
    error_code text,
    duration_ms bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT worker_task_runs_status_check CHECK ((status = ANY (ARRAY['completed'::text, 'failed'::text])))
);

CREATE SEQUENCE worker_task_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE worker_task_runs_id_seq OWNED BY worker_task_runs.id;

ALTER TABLE ONLY crawl_jobs ALTER COLUMN id SET DEFAULT nextval('crawl_jobs_id_seq'::regclass);

ALTER TABLE ONLY crawl_page_failures ALTER COLUMN id SET DEFAULT nextval('crawl_page_failures_id_seq'::regclass);

ALTER TABLE ONLY link_check_jobs ALTER COLUMN id SET DEFAULT nextval('link_check_jobs_id_seq'::regclass);

ALTER TABLE ONLY link_cleanup_jobs ALTER COLUMN id SET DEFAULT nextval('link_cleanup_jobs_id_seq'::regclass);

ALTER TABLE ONLY outbound_policies ALTER COLUMN id SET DEFAULT nextval('outbound_policies_id_seq'::regclass);

ALTER TABLE ONLY search_logs ALTER COLUMN id SET DEFAULT nextval('search_logs_id_seq'::regclass);

ALTER TABLE ONLY users ALTER COLUMN id SET DEFAULT nextval('users_id_seq'::regclass);

ALTER TABLE ONLY worker_task_runs ALTER COLUMN id SET DEFAULT nextval('worker_task_runs_id_seq'::regclass);

ALTER TABLE ONLY auth_identities
    ADD CONSTRAINT auth_identities_pkey PRIMARY KEY (provider, provider_app_id, subject);

ALTER TABLE ONLY auth_identities
    ADD CONSTRAINT auth_identities_provider_provider_app_id_user_id_key UNIQUE (provider, provider_app_id, user_id);

ALTER TABLE ONLY cloud_account_aliases
    ADD CONSTRAINT cloud_account_aliases_pkey PRIMARY KEY (provider, legacy_key);

ALTER TABLE ONLY cloud_account_settings
    ADD CONSTRAINT cloud_account_settings_pkey PRIMARY KEY (provider);

ALTER TABLE ONLY cloud_delete_previews
    ADD CONSTRAINT cloud_delete_previews_pkey PRIMARY KEY (token);

ALTER TABLE ONLY cloud_drive_operations
    ADD CONSTRAINT cloud_drive_operations_pkey PRIMARY KEY (request_key);

ALTER TABLE ONLY cloud_login_sessions
    ADD CONSTRAINT cloud_login_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY cloud_provider_policies
    ADD CONSTRAINT cloud_provider_policies_pkey PRIMARY KEY (provider);

ALTER TABLE ONLY config_revisions
    ADD CONSTRAINT config_revisions_pkey PRIMARY KEY (scope);

ALTER TABLE ONLY crawl_channels
    ADD CONSTRAINT crawl_channels_pkey PRIMARY KEY (id);

ALTER TABLE ONLY crawl_jobs
    ADD CONSTRAINT crawl_jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY crawl_message_tasks
    ADD CONSTRAINT crawl_message_tasks_pkey PRIMARY KEY (channel_id, message_id);

ALTER TABLE ONLY crawl_page_failures
    ADD CONSTRAINT crawl_page_failures_pkey PRIMARY KEY (id);

ALTER TABLE ONLY crawl_settings
    ADD CONSTRAINT crawl_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY hot_searches
    ADD CONSTRAINT hot_searches_pkey PRIMARY KEY (term);

ALTER TABLE ONLY link_aggregate_queue
    ADD CONSTRAINT link_aggregate_queue_pkey PRIMARY KEY (resource_id);

ALTER TABLE ONLY link_catalog
    ADD CONSTRAINT link_catalog_input_fingerprint_key UNIQUE (input_fingerprint);

ALTER TABLE ONLY link_catalog
    ADD CONSTRAINT link_catalog_pkey PRIMARY KEY (id);

ALTER TABLE ONLY link_check_enqueue_cursors
    ADD CONSTRAINT link_check_enqueue_cursors_pkey PRIMARY KEY (provider);

ALTER TABLE ONLY link_check_jobs
    ADD CONSTRAINT link_check_jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY link_cleanup_jobs
    ADD CONSTRAINT link_cleanup_jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY link_resolve_requests
    ADD CONSTRAINT link_resolve_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY link_resolve_requests
    ADD CONSTRAINT link_resolve_requests_subject_key_request_key_key UNIQUE (subject_key, request_key);

ALTER TABLE ONLY link_share_cache
    ADD CONSTRAINT link_share_cache_link_id_input_version_target_account_key_a_key UNIQUE (link_id, input_version, target_account_key, account_revision, target_dir, policy_revision, generation);

ALTER TABLE ONLY link_share_cache
    ADD CONSTRAINT link_share_cache_pkey PRIMARY KEY (id);

ALTER TABLE ONLY link_sync_queue
    ADD CONSTRAINT link_sync_queue_pkey PRIMARY KEY (resource_id);

ALTER TABLE ONLY managed_resources
    ADD CONSTRAINT managed_resources_pkey PRIMARY KEY (id);

ALTER TABLE ONLY outbound_policies
    ADD CONSTRAINT outbound_policies_channel_id_key UNIQUE (channel_id);

ALTER TABLE ONLY outbound_policies
    ADD CONSTRAINT outbound_policies_pkey PRIMARY KEY (id);

ALTER TABLE ONLY outbound_policies
    ADD CONSTRAINT outbound_policies_source_id_key UNIQUE (source_id);

ALTER TABLE ONLY outbound_policy_nodes
    ADD CONSTRAINT outbound_policy_nodes_pkey PRIMARY KEY (policy_id, node_id);

ALTER TABLE ONLY policy_settings
    ADD CONSTRAINT policy_settings_pkey PRIMARY KEY (key);

ALTER TABLE ONLY proxy_nodes
    ADD CONSTRAINT proxy_nodes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY resource_link_bindings
    ADD CONSTRAINT resource_link_bindings_pkey PRIMARY KEY (resource_id, link_key);

ALTER TABLE ONLY resource_sources
    ADD CONSTRAINT resource_sources_pkey PRIMARY KEY (id);

ALTER TABLE ONLY search_logs
    ADD CONSTRAINT search_logs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY search_setting_sources
    ADD CONSTRAINT search_setting_sources_pkey PRIMARY KEY (source_id);

ALTER TABLE ONLY search_settings
    ADD CONSTRAINT search_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY source_health
    ADD CONSTRAINT source_health_pkey PRIMARY KEY (source_id);

ALTER TABLE ONLY system_settings
    ADD CONSTRAINT system_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY users
    ADD CONSTRAINT users_username_normalized_key UNIQUE (username_normalized);

ALTER TABLE ONLY wechat_mini_settings
    ADD CONSTRAINT wechat_mini_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY worker_lane_metrics
    ADD CONSTRAINT worker_lane_metrics_pkey PRIMARY KEY (lane);

ALTER TABLE ONLY worker_schedule_slots
    ADD CONSTRAINT worker_schedule_slots_pkey PRIMARY KEY (task);

ALTER TABLE ONLY worker_task_runs
    ADD CONSTRAINT worker_task_runs_pkey PRIMARY KEY (id);

CREATE INDEX cloud_login_due ON cloud_login_sessions USING btree (next_poll_at) WHERE (status = ANY (ARRAY['waiting'::text, 'scanned'::text, 'verifying'::text]));

CREATE UNIQUE INDEX cloud_login_one_active ON cloud_login_sessions USING btree (provider) WHERE (status = ANY (ARRAY['starting'::text, 'waiting'::text, 'scanned'::text, 'verifying'::text]));

CREATE INDEX crawl_job_admin_created ON crawl_jobs USING btree (created_at DESC, id DESC);

CREATE INDEX idx_active_resource_id ON managed_resources USING btree (id) WHERE enabled;

CREATE INDEX idx_admin_resource_page ON managed_resources USING btree (updated_at DESC, id DESC);

CREATE INDEX idx_channel_latest_job ON crawl_jobs USING btree (channel_id, id DESC);

CREATE INDEX idx_check_expired_lease ON link_check_jobs USING btree (lease_until, id) WHERE ((kind = 'original'::text) AND (status = 'running'::text));

CREATE INDEX idx_check_queued_claim ON link_check_jobs USING btree (provider, priority, run_after, id) WHERE ((kind = 'original'::text) AND (status = 'queued'::text));

CREATE INDEX idx_cloud_operations_created ON cloud_drive_operations USING btree (created_at DESC);

CREATE INDEX idx_cloud_previews_expires ON cloud_delete_previews USING btree (expires_at);

CREATE UNIQUE INDEX idx_crawl_failed_page ON crawl_page_failures USING btree (channel_id, kind, COALESCE(cursor_before, (0)::bigint));

CREATE INDEX idx_crawl_failure_channel ON crawl_page_failures USING btree (channel_id, id DESC);

CREATE UNIQUE INDEX idx_crawl_job_active ON crawl_jobs USING btree (channel_id, kind) WHERE ((status = ANY (ARRAY['queued'::text, 'running'::text, 'paused'::text])) AND (kind <> 'retry'::text));

CREATE INDEX idx_crawl_job_ready ON crawl_jobs USING btree (next_run_at, id) WHERE (status = 'queued'::text);

CREATE UNIQUE INDEX idx_crawl_job_request_key ON crawl_jobs USING btree (channel_id, request_key) WHERE (request_key IS NOT NULL);

CREATE INDEX idx_crawl_jobs_filter ON crawl_jobs USING btree (channel_id, status, id DESC);

CREATE UNIQUE INDEX idx_crawl_one_running_channel ON crawl_jobs USING btree (channel_id) WHERE (status = 'running'::text);

CREATE INDEX idx_crawl_tasks_expiry ON crawl_message_tasks USING btree (task_at) WHERE (status <> 'failed'::text);

CREATE INDEX idx_crawl_tasks_time ON crawl_message_tasks USING btree (channel_id, task_at DESC, message_id DESC);

CREATE INDEX idx_hot_searches_public_rank ON hot_searches USING btree (pinned DESC, score DESC, last_searched DESC) WHERE (status = 'approved'::text);

CREATE INDEX idx_hot_searches_rank ON hot_searches USING btree (score DESC, last_searched DESC);

CREATE INDEX idx_hot_searches_term_trgm ON hot_searches USING gin (term gin_trgm_ops);

CREATE INDEX idx_link_catalog_recent_failure ON link_catalog USING btree (last_attempt_at DESC, id) WHERE ((failure_count > 0) AND (last_error_code IS NOT NULL));

CREATE INDEX idx_link_check_completed_retention ON link_check_jobs USING btree (updated_at, id) WHERE (status = 'completed'::text);

CREATE INDEX idx_managed_resources_cloud_types ON managed_resources USING gin (resource_cloud_types(links_json));

CREATE INDEX idx_outbound_node_reference ON outbound_policy_nodes USING btree (node_id, policy_id);

CREATE INDEX idx_resource_name_admin ON managed_resources USING gin (name gin_trgm_ops);

CREATE INDEX idx_resource_name_grams ON managed_resources USING gin (name_grams) WHERE ((origin = 'telegram'::text) AND enabled);

CREATE INDEX idx_resource_search_date ON managed_resources USING btree (published_at DESC NULLS LAST, id) WHERE ((origin = 'telegram'::text) AND enabled);

CREATE INDEX idx_resource_source_channels ON managed_resources USING gin (source_channel_ids);

CREATE INDEX idx_resource_sources_enabled ON resource_sources USING btree (enabled, priority, id);

CREATE UNIQUE INDEX idx_resource_tg_fingerprint ON managed_resources USING btree (fingerprint) WHERE (origin = 'telegram'::text);

CREATE INDEX idx_search_logs_keyword_trgm ON search_logs USING gin (keyword gin_trgm_ops);

CREATE INDEX idx_search_logs_page ON search_logs USING btree (created_at DESC, id DESC);

CREATE INDEX idx_search_logs_scope_created ON search_logs USING btree (search_scope, created_at DESC, id DESC);

CREATE INDEX idx_search_logs_session_created ON search_logs USING btree (session_id, created_at DESC, id DESC) WHERE (session_id IS NOT NULL);

CREATE INDEX idx_search_logs_user_created ON search_logs USING btree (user_id, created_at DESC, id DESC);

CREATE INDEX idx_users_active_created ON users USING btree (created_at DESC, id DESC) WHERE (deleted_at IS NULL);

CREATE INDEX idx_users_created_at ON users USING btree (created_at DESC);

CREATE INDEX link_catalog_due ON link_catalog USING btree (provider, next_check_at, id);

CREATE INDEX link_catalog_expiry ON link_catalog USING btree (valid_until, id) WHERE ((validity = ANY (ARRAY[0, 1])) AND (valid_until IS NOT NULL));

CREATE INDEX link_catalog_failed_links ON link_catalog USING btree (provider, id) WHERE (failure_count > 0);

CREATE INDEX link_check_admin_created ON link_check_jobs USING btree (created_at DESC, id DESC);

CREATE INDEX link_check_admin_status ON link_check_jobs USING btree (status, created_at DESC, id DESC);

CREATE INDEX link_check_link_history ON link_check_jobs USING btree (link_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX link_check_original_active ON link_check_jobs USING btree (link_id, input_version) WHERE ((kind = 'original'::text) AND (status = ANY (ARRAY['queued'::text, 'running'::text])));

CREATE UNIQUE INDEX link_check_share_active ON link_check_jobs USING btree (share_cache_id, input_version) WHERE ((kind = 'reshared'::text) AND (status = ANY (ARRAY['queued'::text, 'running'::text])));

CREATE UNIQUE INDEX link_cleanup_active ON link_cleanup_jobs USING btree (share_cache_id) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text, 'blocked'::text]));

CREATE INDEX link_cleanup_due ON link_cleanup_jobs USING btree (run_after, id) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));

CREATE INDEX link_cleanup_management_order ON link_cleanup_jobs USING btree (updated_at DESC, id DESC);

CREATE INDEX link_resolve_active_deadline ON link_resolve_requests USING btree (deadline_at, subject_key) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));

CREATE INDEX link_resolve_admin_created ON link_resolve_requests USING btree (created_at DESC, id DESC);

CREATE INDEX link_resolve_deadline ON link_resolve_requests USING btree (status, deadline_at);

CREATE INDEX link_resolve_expiry ON link_resolve_requests USING btree (expires_at);

CREATE UNIQUE INDEX link_share_active ON link_share_cache USING btree (link_id, input_version, target_account_key, account_revision, target_dir, policy_revision) WHERE (state <> ALL (ARRAY['expiring'::text, 'cleaning'::text, 'deleted'::text]));

CREATE INDEX link_share_cleanup ON link_share_cache USING btree (cleanup_after, id) WHERE (state <> 'deleted'::text);

CREATE INDEX link_sync_queue_order ON link_sync_queue USING btree (updated_at, resource_id);

CREATE INDEX resource_link_bindings_link ON resource_link_bindings USING btree (link_id, resource_id);

CREATE INDEX worker_task_runs_lane_recent ON worker_task_runs USING btree (lane, status, created_at DESC);

CREATE INDEX worker_task_runs_retention ON worker_task_runs USING btree (created_at, id);

CREATE INDEX worker_task_runs_status ON worker_task_runs USING btree (status, id DESC);

CREATE TRIGGER crawl_channels_wakeup AFTER INSERT OR DELETE OR UPDATE OF enabled, next_sync_at, next_page_at, history_complete, history_cursor ON crawl_channels FOR EACH ROW EXECUTE FUNCTION notify_crawl_wakeup();

CREATE TRIGGER crawl_jobs_wakeup AFTER INSERT OR DELETE OR UPDATE OF status, next_run_at, lease_until ON crawl_jobs FOR EACH ROW EXECUTE FUNCTION notify_crawl_wakeup();

CREATE TRIGGER crawl_settings_wakeup AFTER UPDATE ON crawl_settings FOR EACH ROW EXECUTE FUNCTION notify_crawl_wakeup();

CREATE TRIGGER crawl_switch_wakeup AFTER INSERT OR DELETE OR UPDATE ON policy_settings FOR EACH ROW EXECUTE FUNCTION notify_crawl_policy_wakeup();

CREATE TRIGGER link_account_insert_delete_wakeup AFTER INSERT OR DELETE ON cloud_account_settings FOR EACH ROW EXECUTE FUNCTION notify_link_account_wakeup();

CREATE TRIGGER link_account_update_wakeup AFTER UPDATE OF auth_status, binding_epoch ON cloud_account_settings FOR EACH ROW WHEN (((old.auth_status IS DISTINCT FROM new.auth_status) OR (old.binding_epoch IS DISTINCT FROM new.binding_epoch))) EXECUTE FUNCTION notify_link_account_wakeup();

CREATE TRIGGER link_catalog_aggregate AFTER UPDATE OF validity, valid_until, checked_at ON link_catalog FOR EACH ROW WHEN ((((old.validity IS DISTINCT FROM new.validity) OR (old.valid_until IS DISTINCT FROM new.valid_until)) OR (old.checked_at IS DISTINCT FROM new.checked_at))) EXECUTE FUNCTION enqueue_link_aggregate();

CREATE TRIGGER link_catalog_reschedule_checks AFTER UPDATE OF provider, next_check_at ON link_catalog FOR EACH ROW WHEN (((old.provider IS DISTINCT FROM new.provider) OR (old.next_check_at IS DISTINCT FROM new.next_check_at))) EXECUTE FUNCTION reschedule_original_check_jobs();

CREATE TRIGGER link_check_prepare BEFORE INSERT OR UPDATE OF link_id, input_version, status ON link_check_jobs FOR EACH ROW EXECUTE FUNCTION prepare_original_check_job();

CREATE TRIGGER managed_resource_revision BEFORE INSERT OR DELETE OR UPDATE OF name, description, datetime, links_json, images_json, enabled, origin, source_channel_ids, published_at ON managed_resources FOR EACH STATEMENT EXECUTE FUNCTION lock_local_index_revision();

CREATE TRIGGER managed_resource_revision_insert_delete AFTER INSERT OR DELETE ON managed_resources FOR EACH ROW EXECUTE FUNCTION invalidate_local_index();

CREATE TRIGGER managed_resource_revision_truncate AFTER TRUNCATE ON managed_resources FOR EACH STATEMENT EXECUTE FUNCTION invalidate_local_index();

CREATE TRIGGER managed_resource_revision_update AFTER UPDATE ON managed_resources FOR EACH ROW WHEN ((((((((((old.name IS DISTINCT FROM new.name) OR (old.description IS DISTINCT FROM new.description)) OR (old.datetime IS DISTINCT FROM new.datetime)) OR (old.links_json IS DISTINCT FROM new.links_json)) OR (old.images_json IS DISTINCT FROM new.images_json)) OR (old.enabled IS DISTINCT FROM new.enabled)) OR (old.origin IS DISTINCT FROM new.origin)) OR (old.source_channel_ids IS DISTINCT FROM new.source_channel_ids)) OR (old.published_at IS DISTINCT FROM new.published_at))) EXECUTE FUNCTION invalidate_local_index();

CREATE TRIGGER revise_resource_links BEFORE UPDATE OF links_json ON managed_resources FOR EACH ROW EXECUTE FUNCTION revise_resource_links();

CREATE TRIGGER sync_managed_links AFTER INSERT OR UPDATE OF links_json ON managed_resources FOR EACH ROW EXECUTE FUNCTION enqueue_link_sync();

CREATE TRIGGER worker_settings_wakeup AFTER INSERT OR DELETE OR UPDATE ON policy_settings FOR EACH ROW EXECUTE FUNCTION notify_worker_settings_wakeup();

ALTER TABLE ONLY auth_identities
    ADD CONSTRAINT auth_identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE ONLY cloud_delete_previews
    ADD CONSTRAINT cloud_delete_previews_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES users(id);

ALTER TABLE ONLY cloud_delete_previews
    ADD CONSTRAINT cloud_delete_previews_used_by_fkey FOREIGN KEY (used_by) REFERENCES cloud_drive_operations(request_key);

ALTER TABLE ONLY cloud_drive_operations
    ADD CONSTRAINT cloud_drive_operations_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES users(id);

ALTER TABLE ONLY cloud_login_sessions
    ADD CONSTRAINT cloud_login_sessions_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES users(id);

ALTER TABLE ONLY crawl_jobs
    ADD CONSTRAINT crawl_jobs_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES crawl_channels(id);

ALTER TABLE ONLY crawl_jobs
    ADD CONSTRAINT crawl_jobs_failure_id_fkey FOREIGN KEY (failure_id) REFERENCES crawl_page_failures(id) ON DELETE SET NULL;

ALTER TABLE ONLY crawl_message_tasks
    ADD CONSTRAINT crawl_message_tasks_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES crawl_channels(id) ON DELETE CASCADE;

ALTER TABLE ONLY crawl_page_failures
    ADD CONSTRAINT crawl_page_failures_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES crawl_channels(id) ON DELETE CASCADE;

ALTER TABLE ONLY crawl_page_failures
    ADD CONSTRAINT crawl_page_failures_job_id_fkey FOREIGN KEY (job_id) REFERENCES crawl_jobs(id) ON DELETE SET NULL;

ALTER TABLE ONLY crawl_page_failures
    ADD CONSTRAINT crawl_page_failures_retry_job_id_fkey FOREIGN KEY (retry_job_id) REFERENCES crawl_jobs(id) ON DELETE SET NULL;

ALTER TABLE ONLY link_aggregate_queue
    ADD CONSTRAINT link_aggregate_queue_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES managed_resources(id) ON DELETE CASCADE;

ALTER TABLE ONLY link_check_jobs
    ADD CONSTRAINT link_check_jobs_link_id_fkey FOREIGN KEY (link_id) REFERENCES link_catalog(id);

ALTER TABLE ONLY link_check_jobs
    ADD CONSTRAINT link_check_jobs_share_cache_id_fkey FOREIGN KEY (share_cache_id) REFERENCES link_share_cache(id);

ALTER TABLE ONLY link_cleanup_jobs
    ADD CONSTRAINT link_cleanup_jobs_share_cache_id_fkey FOREIGN KEY (share_cache_id) REFERENCES link_share_cache(id);

ALTER TABLE ONLY link_resolve_requests
    ADD CONSTRAINT link_resolve_requests_link_id_fkey FOREIGN KEY (link_id) REFERENCES link_catalog(id);

ALTER TABLE ONLY link_resolve_requests
    ADD CONSTRAINT link_resolve_requests_share_cache_id_fkey FOREIGN KEY (share_cache_id) REFERENCES link_share_cache(id);

ALTER TABLE ONLY link_resolve_requests
    ADD CONSTRAINT link_resolve_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE ONLY link_share_cache
    ADD CONSTRAINT link_share_cache_link_id_fkey FOREIGN KEY (link_id) REFERENCES link_catalog(id);

ALTER TABLE ONLY link_sync_queue
    ADD CONSTRAINT link_sync_queue_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES managed_resources(id) ON DELETE CASCADE;

ALTER TABLE ONLY outbound_policies
    ADD CONSTRAINT outbound_policies_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES crawl_channels(id) ON DELETE CASCADE;

ALTER TABLE ONLY outbound_policies
    ADD CONSTRAINT outbound_policies_source_id_fkey FOREIGN KEY (source_id) REFERENCES resource_sources(id) ON DELETE CASCADE;

ALTER TABLE ONLY outbound_policy_nodes
    ADD CONSTRAINT outbound_policy_nodes_node_id_fkey FOREIGN KEY (node_id) REFERENCES proxy_nodes(id) ON DELETE RESTRICT;

ALTER TABLE ONLY outbound_policy_nodes
    ADD CONSTRAINT outbound_policy_nodes_policy_id_fkey FOREIGN KEY (policy_id) REFERENCES outbound_policies(id) ON DELETE CASCADE;

ALTER TABLE ONLY resource_link_bindings
    ADD CONSTRAINT resource_link_bindings_link_id_fkey FOREIGN KEY (link_id) REFERENCES link_catalog(id);

ALTER TABLE ONLY resource_link_bindings
    ADD CONSTRAINT resource_link_bindings_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES managed_resources(id) ON DELETE CASCADE;

ALTER TABLE ONLY resource_sources
    ADD CONSTRAINT resource_sources_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES crawl_channels(id);

ALTER TABLE ONLY search_logs
    ADD CONSTRAINT search_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

-- Built-in defaults only; no resources, users, credentials, or historical jobs.
INSERT INTO config_revisions(scope,revision) VALUES ('sources',0),('local-index',0);
INSERT INTO system_settings(id) VALUES (1);
INSERT INTO search_settings(id) VALUES (1);
INSERT INTO crawl_settings(id) VALUES (1);
INSERT INTO proxy_nodes(id,name,base_url,enabled,kind) VALUES ('direct','直连','',true,'direct');
INSERT INTO policy_settings(key,value_json) VALUES ('link-check','{"enabled":false}');
INSERT INTO cloud_provider_policies(provider)
 SELECT unnest(ARRAY['baidu','quark','aliyun','xunlei','guangya']);
INSERT INTO link_check_enqueue_cursors(provider)
 SELECT unnest(ARRAY['baidu','quark','aliyun','xunlei','guangya']);
