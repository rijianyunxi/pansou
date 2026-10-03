-- Current schema after migrations 001-030, generated from a fresh isolated database.
-- Reference / schema review only: this is NOT a replacement SQLx migration.
-- Audit and limitations: docs/database/migration-audit-v030.md
-- Contains final DDL, no application seed data and no _sqlx_migrations ledger.
-- Restoring it does not initialize an application database; keep using migrations/.
-- Never execute on a populated database.

--
-- PostgreSQL database dump
--


-- Dumped from database version 18.6
-- Dumped by pg_dump version 18.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: adjust_channel_resource_reference(text, text, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.adjust_channel_resource_reference(ch text, resource text, delta bigint) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE remaining BIGINT;
BEGIN
 IF delta>0 THEN
  INSERT INTO channel_resource_references(channel_id,resource_id,parsed_occurrences)
  VALUES(ch,resource,delta)
  ON CONFLICT(channel_id,resource_id) DO UPDATE
  SET parsed_occurrences=channel_resource_references.parsed_occurrences+EXCLUDED.parsed_occurrences
  RETURNING parsed_occurrences INTO remaining;
  IF remaining=delta THEN
   UPDATE channel_statistics SET parsed_resource_count=parsed_resource_count+1 WHERE channel_id=ch;
  END IF;
 ELSE
  UPDATE channel_resource_references SET parsed_occurrences=parsed_occurrences+delta
  WHERE channel_id=ch AND resource_id=resource RETURNING parsed_occurrences INTO remaining;
  IF remaining=0 THEN
   DELETE FROM channel_resource_references WHERE channel_id=ch AND resource_id=resource;
   UPDATE channel_statistics SET parsed_resource_count=parsed_resource_count-1 WHERE channel_id=ch;
  END IF;
 END IF;
END $$;


--
-- Name: clear_resource_cloud_types(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.clear_resource_cloud_types() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 TRUNCATE resource_cloud_type_counts;
 UPDATE config_revisions SET revision=revision+1 WHERE scope='local-index';
 RETURN NULL;
END $$;


--
-- Name: enqueue_link_sync(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enqueue_link_sync() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_TABLE_NAME='managed_resources' THEN
   INSERT INTO link_sync_queue(resource_id) VALUES(NEW.id) ON CONFLICT(resource_id) DO UPDATE SET updated_at=now();
 ELSE
   INSERT INTO link_sync_queue(resource_id) SELECT COALESCE(NEW.resource_id,OLD.resource_id)
     WHERE EXISTS(SELECT 1 FROM managed_resources WHERE id=COALESCE(NEW.resource_id,OLD.resource_id))
     ON CONFLICT(resource_id) DO UPDATE SET updated_at=now();
 END IF;
 RETURN NULL;
END $$;


--
-- Name: index_resource_text(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.index_resource_text() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE content TEXT; grams TEXT[];
BEGIN
 content:=lower(NEW.name);
 SELECT COALESCE(array_agg(DISTINCT gram),'{}'::text[]) INTO grams FROM (
 SELECT substring(content FROM p FOR n) gram FROM generate_series(1,char_length(content)) p CROSS JOIN generate_series(1,2) n
 WHERE p+n-1<=char_length(content) AND substring(content FROM p FOR n)~'^[[:alnum:]]+$'
 ) g;
 DELETE FROM resource_grams WHERE resource_id=NEW.id AND NOT(gram=ANY(grams));
 INSERT INTO resource_grams(resource_id,gram) SELECT NEW.id,unnest(grams) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $_$;


--
-- Name: initialize_channel_statistics(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.initialize_channel_statistics() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 INSERT INTO channel_statistics(channel_id) VALUES(NEW.id);
 RETURN NULL;
END $$;


--
-- Name: invalidate_local_index(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.invalidate_local_index() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 UPDATE config_revisions SET revision=revision+1 WHERE scope='local-index';
 RETURN NULL;
END $$;


--
-- Name: lock_local_index_revision(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lock_local_index_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 PERFORM revision FROM config_revisions WHERE scope='local-index' FOR UPDATE;
 RETURN NULL;
END $$;


--
-- Name: prepare_original_check_job(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prepare_original_check_job() RETURNS trigger
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


--
-- Name: reschedule_original_check_jobs(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reschedule_original_check_jobs() RETURNS trigger
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


--
-- Name: resource_cloud_types(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.resource_cloud_types(links jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
 SELECT COALESCE(jsonb_agg(provider ORDER BY provider COLLATE "C"),'[]'::jsonb)
 FROM (
  SELECT DISTINCT link->>'type' AS provider
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(links)='array' THEN links ELSE '[]'::jsonb END) AS entry(link)
  WHERE jsonb_typeof(link->'type')='string' AND link->>'type'<>''
 ) providers
$$;


--
-- Name: revise_resource_links(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.revise_resource_links() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NEW.links_json IS DISTINCT FROM OLD.links_json OR NEW.manual_override IS DISTINCT FROM OLD.manual_override THEN
  NEW.links_revision=OLD.links_revision+1; NEW.link_validity=-1; NEW.link_validity_updated_at=NULL;
 END IF;
 RETURN NEW;
END $$;


--
-- Name: sync_message_search_occurrences(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_message_search_occurrences() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE changed BIGINT;
BEGIN
 UPDATE resource_search_occurrences SET published_at=NEW.published_at,parsed=NEW.parse_status='parsed'
 WHERE channel_id=NEW.channel_id AND message_id=NEW.message_id
 AND (published_at,parsed) IS DISTINCT FROM (NEW.published_at,NEW.parse_status='parsed');
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed>0 THEN
  UPDATE config_revisions SET revision=revision+1 WHERE scope='local-index';
 END IF;
 RETURN NULL;
END $$;


--
-- Name: sync_resource_cloud_types(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_resource_cloud_types() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE old_types TEXT[]:='{}'; new_types TEXT[]:='{}'; item TEXT;
BEGIN
 IF TG_OP<>'INSERT' THEN
  IF OLD.deleted_at IS NULL THEN
   SELECT ARRAY(SELECT jsonb_array_elements_text(resource_cloud_types(OLD.links_json))) INTO old_types;
  END IF;
 END IF;
 IF TG_OP<>'DELETE' THEN
  IF NEW.deleted_at IS NULL THEN
   SELECT ARRAY(SELECT jsonb_array_elements_text(resource_cloud_types(NEW.links_json))) INTO new_types;
  END IF;
 END IF;
 FOR item IN SELECT unnest(new_types) EXCEPT SELECT unnest(old_types) LOOP
  INSERT INTO resource_cloud_type_counts VALUES(item,1)
  ON CONFLICT(cloud_type) DO UPDATE SET resource_count=resource_cloud_type_counts.resource_count+1;
 END LOOP;
 FOR item IN SELECT unnest(old_types) EXCEPT SELECT unnest(new_types) LOOP
  UPDATE resource_cloud_type_counts SET resource_count=resource_count-1 WHERE cloud_type=item;
  DELETE FROM resource_cloud_type_counts WHERE cloud_type=item AND resource_count=0;
 END LOOP;
 RETURN NULL;
END $$;


--
-- Name: sync_resource_search_document(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_resource_search_document() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 INSERT INTO resource_search_documents VALUES
 (NEW.id,NEW.origin='telegram' AND NEW.enabled AND NEW.deleted_at IS NULL,NEW.manual_override,lower(NEW.name))
 ON CONFLICT(resource_id) DO UPDATE SET active=EXCLUDED.active,
 manual_override=EXCLUDED.manual_override,name_lower=EXCLUDED.name_lower
 WHERE (resource_search_documents.active,resource_search_documents.manual_override,resource_search_documents.name_lower)
 IS DISTINCT FROM (EXCLUDED.active,EXCLUDED.manual_override,EXCLUDED.name_lower);
 RETURN NULL;
END $$;


--
-- Name: sync_resource_search_occurrence(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_resource_search_occurrence() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (OLD.channel_id,OLD.message_id,OLD.resource_id,OLD.result_json)
   IS NOT DISTINCT FROM (NEW.channel_id,NEW.message_id,NEW.resource_id,NEW.result_json) THEN
   RETURN NULL;
  END IF;
 END IF;
 -- FK actions remove/move projections, including resource cascades.
 IF TG_OP<>'DELETE' THEN
  INSERT INTO resource_search_occurrences
  SELECT NEW.resource_id,NEW.channel_id,NEW.message_id,
   lower(COALESCE(NEW.result_json->>'name','')),m.published_at,m.parse_status='parsed'
  FROM source_messages m WHERE m.channel_id=NEW.channel_id AND m.message_id=NEW.message_id
  ON CONFLICT(resource_id,channel_id,message_id) DO UPDATE
  SET name_lower=EXCLUDED.name_lower,published_at=EXCLUDED.published_at,parsed=EXCLUDED.parsed
  WHERE (resource_search_occurrences.name_lower,resource_search_occurrences.published_at,resource_search_occurrences.parsed)
   IS DISTINCT FROM (EXCLUDED.name_lower,EXCLUDED.published_at,EXCLUDED.parsed);
 END IF;
 -- Presentation edits must invalidate even if the projected name did not change.
 UPDATE config_revisions SET revision=revision+1 WHERE scope='local-index';
 RETURN NULL;
END $$;


--
-- Name: update_message_statistics(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_message_statistics() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE item RECORD; delta BIGINT;
BEGIN
 IF TG_OP='INSERT' THEN
  UPDATE channel_statistics SET message_count=message_count+1,
   parsed_count=parsed_count+(NEW.parse_status='parsed')::int,
   empty_count=empty_count+(NEW.parse_status='empty')::int,
   failed_count=failed_count+(NEW.parse_status='failed')::int
  WHERE channel_id=NEW.channel_id;
 ELSIF TG_OP='DELETE' THEN
  UPDATE channel_statistics SET message_count=message_count-1,
   parsed_count=parsed_count-(OLD.parse_status='parsed')::int,
   empty_count=empty_count-(OLD.parse_status='empty')::int,
   failed_count=failed_count-(OLD.parse_status='failed')::int
  WHERE channel_id=OLD.channel_id;
  -- Run BEFORE parent deletion. Cascaded occurrence deletes see no parent and
  -- skip their decrement, so a parsed reference is removed exactly once.
  IF OLD.parse_status='parsed' THEN
   FOR item IN SELECT resource_id FROM resource_occurrences
    WHERE channel_id=OLD.channel_id AND message_id=OLD.message_id ORDER BY resource_id
   LOOP
    PERFORM adjust_channel_resource_reference(OLD.channel_id,item.resource_id,-1);
   END LOOP;
  END IF;
 ELSE
  UPDATE channel_statistics SET
   parsed_count=parsed_count+(NEW.parse_status='parsed')::int-(OLD.parse_status='parsed')::int,
   empty_count=empty_count+(NEW.parse_status='empty')::int-(OLD.parse_status='empty')::int,
   failed_count=failed_count+(NEW.parse_status='failed')::int-(OLD.parse_status='failed')::int
  WHERE channel_id=NEW.channel_id;
  IF (OLD.parse_status='parsed') IS DISTINCT FROM (NEW.parse_status='parsed') THEN
   delta := CASE WHEN NEW.parse_status='parsed' THEN 1 ELSE -1 END;
   FOR item IN SELECT resource_id FROM resource_occurrences
    WHERE channel_id=NEW.channel_id AND message_id=NEW.message_id ORDER BY resource_id
   LOOP
    PERFORM adjust_channel_resource_reference(NEW.channel_id,item.resource_id,delta);
   END LOOP;
  END IF;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;


--
-- Name: update_occurrence_statistics(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_occurrence_statistics() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (OLD.channel_id,OLD.message_id,OLD.resource_id) IS NOT DISTINCT FROM
     (NEW.channel_id,NEW.message_id,NEW.resource_id) THEN
   RETURN NULL;
  END IF;
 END IF;
 IF TG_OP IN ('DELETE','UPDATE') THEN
  IF EXISTS(SELECT 1 FROM source_messages WHERE channel_id=OLD.channel_id
            AND message_id=OLD.message_id AND parse_status='parsed') THEN
   PERFORM adjust_channel_resource_reference(OLD.channel_id,OLD.resource_id,-1);
  END IF;
 END IF;
 IF TG_OP IN ('INSERT','UPDATE') THEN
  IF EXISTS(SELECT 1 FROM source_messages WHERE channel_id=NEW.channel_id
            AND message_id=NEW.message_id AND parse_status='parsed') THEN
   PERFORM adjust_channel_resource_reference(NEW.channel_id,NEW.resource_id,1);
  END IF;
 END IF;
 RETURN NULL;
END $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: auth_identities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_identities (
    provider text NOT NULL,
    provider_app_id text NOT NULL,
    subject text NOT NULL,
    provider_union_id text,
    user_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: channel_resource_references; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_resource_references (
    channel_id text NOT NULL,
    resource_id text NOT NULL,
    parsed_occurrences bigint NOT NULL,
    CONSTRAINT channel_resource_references_parsed_occurrences_check CHECK ((parsed_occurrences >= 0))
);


--
-- Name: channel_statistics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_statistics (
    channel_id text NOT NULL,
    message_count bigint DEFAULT 0 NOT NULL,
    parsed_resource_count bigint DEFAULT 0 NOT NULL,
    parsed_count bigint DEFAULT 0 NOT NULL,
    empty_count bigint DEFAULT 0 NOT NULL,
    failed_count bigint DEFAULT 0 NOT NULL,
    CONSTRAINT channel_statistics_empty_count_check CHECK ((empty_count >= 0)),
    CONSTRAINT channel_statistics_failed_count_check CHECK ((failed_count >= 0)),
    CONSTRAINT channel_statistics_message_count_check CHECK ((message_count >= 0)),
    CONSTRAINT channel_statistics_parsed_count_check CHECK ((parsed_count >= 0)),
    CONSTRAINT channel_statistics_parsed_resource_count_check CHECK ((parsed_resource_count >= 0))
);


--
-- Name: cloud_account_aliases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_account_aliases (
    provider text NOT NULL,
    legacy_key text NOT NULL,
    account_key text NOT NULL,
    verified_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_account_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_account_settings (
    provider text NOT NULL,
    credential text DEFAULT ''::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    credential_cipher text,
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
    pending_refresh_cipher text
);


--
-- Name: cloud_delete_previews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_delete_previews (
    token uuid NOT NULL,
    actor_id bigint NOT NULL,
    fingerprint text NOT NULL,
    files_json jsonb NOT NULL,
    used_by uuid,
    expires_at timestamp with time zone DEFAULT (now() + '00:05:00'::interval) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cloud_drive_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_drive_operations (
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


--
-- Name: cloud_login_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_login_sessions (
    id uuid NOT NULL,
    actor_id bigint NOT NULL,
    provider text NOT NULL,
    intent text NOT NULL,
    expected_epoch bigint NOT NULL,
    status text DEFAULT 'starting'::text NOT NULL,
    context_cipher text,
    qr_image text,
    error_code text,
    interval_seconds integer DEFAULT 3 NOT NULL,
    next_poll_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    poll_lease uuid,
    poll_lease_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cloud_login_sessions_intent_check CHECK ((intent = ANY (ARRAY['connect'::text, 'reauthorize'::text, 'replace'::text]))),
    CONSTRAINT cloud_login_sessions_provider_check CHECK ((provider = ANY (ARRAY['baidu'::text, 'quark'::text, 'aliyun'::text, 'xunlei'::text, 'guangya'::text])))
);


--
-- Name: cloud_provider_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cloud_provider_policies (
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


--
-- Name: config_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.config_revisions (
    scope text NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT config_revisions_revision_check CHECK ((revision >= 0))
);


--
-- Name: crawl_channels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crawl_channels (
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


--
-- Name: crawl_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crawl_jobs (
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


--
-- Name: crawl_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.crawl_jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: crawl_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.crawl_jobs_id_seq OWNED BY public.crawl_jobs.id;


--
-- Name: crawl_page_failures; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crawl_page_failures (
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


--
-- Name: crawl_page_failures_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.crawl_page_failures_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: crawl_page_failures_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.crawl_page_failures_id_seq OWNED BY public.crawl_page_failures.id;


--
-- Name: crawl_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crawl_settings (
    id integer NOT NULL,
    concurrent_channels integer DEFAULT 3 NOT NULL,
    page_delay_seconds integer DEFAULT 3 NOT NULL,
    daily_interval_seconds integer DEFAULT 300 NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    CONSTRAINT crawl_settings_concurrent_channels_check CHECK (((concurrent_channels >= 1) AND (concurrent_channels <= 32))),
    CONSTRAINT crawl_settings_daily_interval_seconds_check CHECK (((daily_interval_seconds >= 60) AND (daily_interval_seconds <= 86400))),
    CONSTRAINT crawl_settings_id_check CHECK ((id = 1)),
    CONSTRAINT crawl_settings_page_delay_seconds_check CHECK (((page_delay_seconds >= 0) AND (page_delay_seconds <= 3600)))
);


--
-- Name: hot_searches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hot_searches (
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


--
-- Name: link_catalog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.link_catalog (
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


--
-- Name: link_check_enqueue_cursors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.link_check_enqueue_cursors (
    provider text NOT NULL,
    next_check_at timestamp with time zone,
    link_id uuid,
    CONSTRAINT link_check_enqueue_cursors_check CHECK (((next_check_at IS NULL) = (link_id IS NULL))),
    CONSTRAINT link_check_enqueue_cursors_provider_check CHECK ((provider = ANY (ARRAY['baidu'::text, 'quark'::text, 'aliyun'::text, 'xunlei'::text, 'guangya'::text])))
);


--
-- Name: link_check_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.link_check_jobs (
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


--
-- Name: link_check_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.link_check_jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: link_check_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.link_check_jobs_id_seq OWNED BY public.link_check_jobs.id;


--
-- Name: link_cleanup_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.link_cleanup_jobs (
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
    CONSTRAINT link_cleanup_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'failed'::text, 'blocked'::text])))
);


--
-- Name: link_cleanup_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.link_cleanup_jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: link_cleanup_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.link_cleanup_jobs_id_seq OWNED BY public.link_cleanup_jobs.id;


--
-- Name: link_resolve_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.link_resolve_requests (
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


--
-- Name: link_share_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.link_share_cache (
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


--
-- Name: link_sync_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.link_sync_queue (
    resource_id text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: managed_resources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.managed_resources (
    id text NOT NULL,
    name text NOT NULL,
    description text,
    datetime text,
    links_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    tags_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    images_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    search_text text DEFAULT ''::text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    origin text DEFAULT 'manual'::text NOT NULL,
    fingerprint text,
    published_at timestamp with time zone,
    manual_override boolean DEFAULT false NOT NULL,
    deleted_at timestamp with time zone,
    link_validity smallint DEFAULT '-1'::integer NOT NULL,
    link_validity_updated_at timestamp with time zone,
    links_revision bigint DEFAULT 1 NOT NULL,
    CONSTRAINT managed_resources_link_validity_check CHECK ((link_validity = ANY (ARRAY['-1'::integer, 0, 1])))
);


--
-- Name: outbound_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outbound_policies (
    id bigint NOT NULL,
    source_id text,
    channel_id text,
    default_key text,
    version bigint DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    inherit boolean DEFAULT false NOT NULL,
    CONSTRAINT inherit_only_channel CHECK (((NOT inherit) OR (channel_id IS NOT NULL))),
    CONSTRAINT outbound_policies_check CHECK ((num_nonnulls(source_id, channel_id, default_key) = 1)),
    CONSTRAINT outbound_policies_default_key_check CHECK ((default_key = 'telegram'::text))
);


--
-- Name: outbound_policies_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.outbound_policies_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: outbound_policies_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.outbound_policies_id_seq OWNED BY public.outbound_policies.id;


--
-- Name: outbound_policy_nodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outbound_policy_nodes (
    policy_id bigint NOT NULL,
    node_id text NOT NULL,
    weight integer NOT NULL,
    CONSTRAINT outbound_policy_nodes_weight_check CHECK (((weight >= 0) AND (weight <= 10000)))
);


--
-- Name: policy_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.policy_settings (
    key text NOT NULL,
    value_json jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: proxy_nodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.proxy_nodes (
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


--
-- Name: resource_cloud_type_counts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resource_cloud_type_counts (
    cloud_type text NOT NULL,
    resource_count bigint NOT NULL,
    CONSTRAINT resource_cloud_type_counts_resource_count_check CHECK ((resource_count >= 0))
);


--
-- Name: resource_grams; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resource_grams (
    resource_id text NOT NULL,
    gram text NOT NULL
);


--
-- Name: resource_link_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resource_link_bindings (
    resource_id text NOT NULL,
    scope_key text NOT NULL,
    link_key text NOT NULL,
    link_id uuid NOT NULL,
    links_revision bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: resource_occurrences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resource_occurrences (
    channel_id text NOT NULL,
    message_id bigint NOT NULL,
    resource_id text NOT NULL,
    result_json jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: resource_search_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resource_search_documents (
    resource_id text NOT NULL,
    active boolean NOT NULL,
    manual_override boolean NOT NULL,
    name_lower text NOT NULL
);


--
-- Name: resource_search_occurrences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resource_search_occurrences (
    resource_id text NOT NULL,
    channel_id text NOT NULL,
    message_id bigint NOT NULL,
    name_lower text NOT NULL,
    published_at timestamp with time zone,
    parsed boolean NOT NULL
);


--
-- Name: resource_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.resource_sources (
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


--
-- Name: search_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.search_logs (
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


--
-- Name: search_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.search_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: search_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.search_logs_id_seq OWNED BY public.search_logs.id;


--
-- Name: search_setting_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.search_setting_sources (
    source_id text NOT NULL
);


--
-- Name: search_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.search_settings (
    id smallint NOT NULL,
    concurrency integer,
    sources_configured boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT search_settings_id_check CHECK ((id = 1))
);


--
-- Name: source_health; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_health (
    source_id text NOT NULL,
    snapshot_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: source_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_messages (
    channel_id text NOT NULL,
    message_id bigint NOT NULL,
    raw_hash text NOT NULL,
    published_at timestamp with time zone,
    parse_version text NOT NULL,
    parse_status text NOT NULL,
    parse_error text,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT source_messages_parse_status_check CHECK ((parse_status = ANY (ARRAY['parsed'::text, 'empty'::text, 'failed'::text])))
);


--
-- Name: source_template_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_template_settings (
    id smallint NOT NULL,
    url_template text NOT NULL,
    method text NOT NULL,
    format text NOT NULL,
    request_json jsonb,
    transform text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    CONSTRAINT source_template_settings_id_check CHECK ((id = 1))
);


--
-- Name: system_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_settings (
    id smallint NOT NULL,
    default_concurrency integer DEFAULT 8 NOT NULL,
    request_timeout_ms integer DEFAULT 15000 NOT NULL,
    cache_ttl_minutes integer DEFAULT 5 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT system_settings_id_check CHECK ((id = 1))
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
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


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: wechat_mini_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wechat_mini_settings (
    id smallint NOT NULL,
    app_id text DEFAULT ''::text NOT NULL,
    secret text DEFAULT ''::text NOT NULL,
    qr_page text DEFAULT 'pages/login/index'::text NOT NULL,
    env_version text DEFAULT 'release'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT wechat_mini_settings_id_check CHECK ((id = 1))
);


--
-- Name: worker_task_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.worker_task_runs (
    id bigint NOT NULL,
    lane text NOT NULL,
    status text NOT NULL,
    error_code text,
    duration_ms bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT worker_task_runs_status_check CHECK ((status = ANY (ARRAY['completed'::text, 'failed'::text])))
);


--
-- Name: worker_task_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.worker_task_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: worker_task_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.worker_task_runs_id_seq OWNED BY public.worker_task_runs.id;


--
-- Name: crawl_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crawl_jobs ALTER COLUMN id SET DEFAULT nextval('public.crawl_jobs_id_seq'::regclass);


--
-- Name: crawl_page_failures id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crawl_page_failures ALTER COLUMN id SET DEFAULT nextval('public.crawl_page_failures_id_seq'::regclass);


--
-- Name: link_check_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.link_check_jobs ALTER COLUMN id SET DEFAULT nextval('public.link_check_jobs_id_seq'::regclass);


--
-- Name: link_cleanup_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.link_cleanup_jobs ALTER COLUMN id SET DEFAULT nextval('public.link_cleanup_jobs_id_seq'::regclass);


--
-- Name: outbound_policies id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_policies ALTER COLUMN id SET DEFAULT nextval('public.outbound_policies_id_seq'::regclass);


--
-- Name: search_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_logs ALTER COLUMN id SET DEFAULT nextval('public.search_logs_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: worker_task_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_task_runs ALTER COLUMN id SET DEFAULT nextval('public.worker_task_runs_id_seq'::regclass);


--
-- Name: auth_identities auth_identities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_identities
    ADD CONSTRAINT auth_identities_pkey PRIMARY KEY (provider, provider_app_id, subject);


--
-- Name: auth_identities auth_identities_provider_provider_app_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_identities
    ADD CONSTRAINT auth_identities_provider_provider_app_id_user_id_key UNIQUE (provider, provider_app_id, user_id);


--
-- Name: channel_resource_references channel_resource_references_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_resource_references
    ADD CONSTRAINT channel_resource_references_pkey PRIMARY KEY (channel_id, resource_id);


--
-- Name: channel_statistics channel_statistics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_statistics
    ADD CONSTRAINT channel_statistics_pkey PRIMARY KEY (channel_id);


--
-- Name: cloud_account_aliases cloud_account_aliases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_account_aliases
    ADD CONSTRAINT cloud_account_aliases_pkey PRIMARY KEY (provider, legacy_key);


--
-- Name: cloud_account_settings cloud_account_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_account_settings
    ADD CONSTRAINT cloud_account_settings_pkey PRIMARY KEY (provider);


--
-- Name: cloud_delete_previews cloud_delete_previews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_delete_previews
    ADD CONSTRAINT cloud_delete_previews_pkey PRIMARY KEY (token);


--
-- Name: cloud_drive_operations cloud_drive_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_drive_operations
    ADD CONSTRAINT cloud_drive_operations_pkey PRIMARY KEY (request_key);


--
-- Name: cloud_login_sessions cloud_login_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_login_sessions
    ADD CONSTRAINT cloud_login_sessions_pkey PRIMARY KEY (id);


--
-- Name: cloud_provider_policies cloud_provider_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_provider_policies
    ADD CONSTRAINT cloud_provider_policies_pkey PRIMARY KEY (provider);


--
-- Name: config_revisions config_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config_revisions
    ADD CONSTRAINT config_revisions_pkey PRIMARY KEY (scope);


--
-- Name: crawl_channels crawl_channels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crawl_channels
    ADD CONSTRAINT crawl_channels_pkey PRIMARY KEY (id);


--
-- Name: crawl_jobs crawl_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crawl_jobs
    ADD CONSTRAINT crawl_jobs_pkey PRIMARY KEY (id);


--
-- Name: crawl_page_failures crawl_page_failures_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crawl_page_failures
    ADD CONSTRAINT crawl_page_failures_pkey PRIMARY KEY (id);


--
-- Name: crawl_settings crawl_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crawl_settings
    ADD CONSTRAINT crawl_settings_pkey PRIMARY KEY (id);


--
-- Name: hot_searches hot_searches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hot_searches
    ADD CONSTRAINT hot_searches_pkey PRIMARY KEY (term);


--
-- Name: link_catalog link_catalog_input_fingerprint_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.link_catalog
    ADD CONSTRAINT link_catalog_input_fingerprint_key UNIQUE (input_fingerprint);


--
-- Name: link_catalog link_catalog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.link_catalog
    ADD CONSTRAINT link_catalog_pkey PRIMARY KEY (id);


--
-- Name: link_check_enqueue_cursors link_check_enqueue_cursors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.link_check_enqueue_cursors
    ADD CONSTRAINT link_check_enqueue_cursors_pkey PRIMARY KEY (provider);


--
-- Name: link_check_jobs link_check_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.link_check_jobs
    ADD CONSTRAINT link_check_jobs_pkey PRIMARY KEY (id);


--
-- Name: link_cleanup_jobs link_cleanup_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.link_cleanup_jobs
    ADD CONSTRAINT link_cleanup_jobs_pkey PRIMARY KEY (id);


--
-- Name: link_resolve_requests link_resolve_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.link_resolve_requests
    ADD CONSTRAINT link_resolve_requests_pkey PRIMARY KEY (id);


--
-- Name: link_resolve_requests link_resolve_requests_subject_key_request_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.link_resolve_requests
    ADD CONSTRAINT link_resolve_requests_subject_key_request_key_key UNIQUE (subject_key, request_key);


--
-- Name: link_share_cache link_share_cache_link_id_input_version_target_account_key_a_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.link_share_cache
    ADD CONSTRAINT link_share_cache_link_id_input_version_target_account_key_a_key UNIQUE (link_id, input_version, target_account_key, account_revision, target_dir, policy_revision, generation);


--
-- Name: link_share_cache link_share_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.link_share_cache
    ADD CONSTRAINT link_share_cache_pkey PRIMARY KEY (id);


--
-- Name: link_sync_queue link_sync_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.link_sync_queue
    ADD CONSTRAINT link_sync_queue_pkey PRIMARY KEY (resource_id);


--
-- Name: managed_resources managed_resources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.managed_resources
    ADD CONSTRAINT managed_resources_pkey PRIMARY KEY (id);


--
-- Name: outbound_policies outbound_policies_channel_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_policies
    ADD CONSTRAINT outbound_policies_channel_id_key UNIQUE (channel_id);


--
-- Name: outbound_policies outbound_policies_default_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_policies
    ADD CONSTRAINT outbound_policies_default_key_key UNIQUE (default_key);


--
-- Name: outbound_policies outbound_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_policies
    ADD CONSTRAINT outbound_policies_pkey PRIMARY KEY (id);


--
-- Name: outbound_policies outbound_policies_source_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_policies
    ADD CONSTRAINT outbound_policies_source_id_key UNIQUE (source_id);


--
-- Name: outbound_policy_nodes outbound_policy_nodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_policy_nodes
    ADD CONSTRAINT outbound_policy_nodes_pkey PRIMARY KEY (policy_id, node_id);


--
-- Name: policy_settings policy_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_settings
    ADD CONSTRAINT policy_settings_pkey PRIMARY KEY (key);


--
-- Name: proxy_nodes proxy_nodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proxy_nodes
    ADD CONSTRAINT proxy_nodes_pkey PRIMARY KEY (id);


--
-- Name: resource_cloud_type_counts resource_cloud_type_counts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_cloud_type_counts
    ADD CONSTRAINT resource_cloud_type_counts_pkey PRIMARY KEY (cloud_type);


--
-- Name: resource_grams resource_grams_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_grams
    ADD CONSTRAINT resource_grams_pkey PRIMARY KEY (resource_id, gram);


--
-- Name: resource_link_bindings resource_link_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_link_bindings
    ADD CONSTRAINT resource_link_bindings_pkey PRIMARY KEY (resource_id, scope_key, link_key);


--
-- Name: resource_occurrences resource_occurrences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_occurrences
    ADD CONSTRAINT resource_occurrences_pkey PRIMARY KEY (channel_id, message_id, resource_id);


--
-- Name: resource_search_documents resource_search_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_search_documents
    ADD CONSTRAINT resource_search_documents_pkey PRIMARY KEY (resource_id);


--
-- Name: resource_search_occurrences resource_search_occurrences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_search_occurrences
    ADD CONSTRAINT resource_search_occurrences_pkey PRIMARY KEY (resource_id, channel_id, message_id);


--
-- Name: resource_sources resource_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_sources
    ADD CONSTRAINT resource_sources_pkey PRIMARY KEY (id);


--
-- Name: search_logs search_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_logs
    ADD CONSTRAINT search_logs_pkey PRIMARY KEY (id);


--
-- Name: search_setting_sources search_setting_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_setting_sources
    ADD CONSTRAINT search_setting_sources_pkey PRIMARY KEY (source_id);


--
-- Name: search_settings search_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_settings
    ADD CONSTRAINT search_settings_pkey PRIMARY KEY (id);


--
-- Name: source_health source_health_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_health
    ADD CONSTRAINT source_health_pkey PRIMARY KEY (source_id);


--
-- Name: source_messages source_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_messages
    ADD CONSTRAINT source_messages_pkey PRIMARY KEY (channel_id, message_id);


--
-- Name: source_template_settings source_template_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_template_settings
    ADD CONSTRAINT source_template_settings_pkey PRIMARY KEY (id);


--
-- Name: system_settings system_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_settings
    ADD CONSTRAINT system_settings_pkey PRIMARY KEY (id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_username_normalized_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_normalized_key UNIQUE (username_normalized);


--
-- Name: wechat_mini_settings wechat_mini_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wechat_mini_settings
    ADD CONSTRAINT wechat_mini_settings_pkey PRIMARY KEY (id);


--
-- Name: worker_task_runs worker_task_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_task_runs
    ADD CONSTRAINT worker_task_runs_pkey PRIMARY KEY (id);


--
-- Name: cloud_credentials_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cloud_credentials_due ON public.cloud_account_settings USING btree (next_check_at) WHERE (credential_cipher IS NOT NULL);


--
-- Name: cloud_login_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cloud_login_due ON public.cloud_login_sessions USING btree (next_poll_at) WHERE (status = ANY (ARRAY['waiting'::text, 'scanned'::text, 'verifying'::text]));


--
-- Name: cloud_login_one_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX cloud_login_one_active ON public.cloud_login_sessions USING btree (provider) WHERE (status = ANY (ARRAY['starting'::text, 'waiting'::text, 'scanned'::text, 'verifying'::text]));


--
-- Name: crawl_job_admin_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crawl_job_admin_created ON public.crawl_jobs USING btree (created_at DESC, id DESC);


--
-- Name: idx_active_resource_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_active_resource_id ON public.managed_resources USING btree (id) WHERE (enabled AND (deleted_at IS NULL));


--
-- Name: idx_admin_resource_page; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_resource_page ON public.managed_resources USING btree (updated_at DESC, id DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_channel_latest_job; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_channel_latest_job ON public.crawl_jobs USING btree (channel_id, id DESC);


--
-- Name: idx_channel_reference_resource; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_channel_reference_resource ON public.channel_resource_references USING btree (resource_id, channel_id);


--
-- Name: idx_check_expired_lease; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_check_expired_lease ON public.link_check_jobs USING btree (lease_until, id) WHERE ((kind = 'original'::text) AND (status = 'running'::text));


--
-- Name: idx_check_queued_claim; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_check_queued_claim ON public.link_check_jobs USING btree (provider, priority, run_after, id) WHERE ((kind = 'original'::text) AND (status = 'queued'::text));


--
-- Name: idx_cloud_operations_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_operations_created ON public.cloud_drive_operations USING btree (created_at DESC);


--
-- Name: idx_cloud_previews_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cloud_previews_expires ON public.cloud_delete_previews USING btree (expires_at);


--
-- Name: idx_crawl_failed_page; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_crawl_failed_page ON public.crawl_page_failures USING btree (channel_id, kind, COALESCE(cursor_before, (0)::bigint));


--
-- Name: idx_crawl_failure_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crawl_failure_channel ON public.crawl_page_failures USING btree (channel_id, id DESC);


--
-- Name: idx_crawl_job_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_crawl_job_active ON public.crawl_jobs USING btree (channel_id, kind) WHERE ((status = ANY (ARRAY['queued'::text, 'running'::text, 'paused'::text])) AND (kind <> 'retry'::text));


--
-- Name: idx_crawl_job_ready; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crawl_job_ready ON public.crawl_jobs USING btree (next_run_at, id) WHERE (status = 'queued'::text);


--
-- Name: idx_crawl_job_request_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_crawl_job_request_key ON public.crawl_jobs USING btree (channel_id, request_key) WHERE (request_key IS NOT NULL);


--
-- Name: idx_crawl_jobs_filter; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crawl_jobs_filter ON public.crawl_jobs USING btree (channel_id, status, id DESC);


--
-- Name: idx_crawl_messages_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crawl_messages_status ON public.source_messages USING btree (channel_id, parse_status, message_id DESC);


--
-- Name: idx_crawl_one_running_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_crawl_one_running_channel ON public.crawl_jobs USING btree (channel_id) WHERE (status = 'running'::text);


--
-- Name: idx_hot_searches_public_rank; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hot_searches_public_rank ON public.hot_searches USING btree (pinned DESC, score DESC, last_searched DESC) WHERE (status = 'approved'::text);


--
-- Name: idx_hot_searches_rank; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hot_searches_rank ON public.hot_searches USING btree (score DESC, last_searched DESC);


--
-- Name: idx_hot_searches_term_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hot_searches_term_trgm ON public.hot_searches USING gin (term public.gin_trgm_ops);


--
-- Name: idx_inactive_resource_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inactive_resource_id ON public.managed_resources USING btree (id) WHERE ((NOT enabled) OR (deleted_at IS NOT NULL));


--
-- Name: idx_link_catalog_recent_failure; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_link_catalog_recent_failure ON public.link_catalog USING btree (last_attempt_at DESC, id) WHERE ((failure_count > 0) AND (last_error_code IS NOT NULL));


--
-- Name: idx_link_check_completed_retention; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_link_check_completed_retention ON public.link_check_jobs USING btree (updated_at, id) WHERE (status = 'completed'::text);


--
-- Name: idx_managed_resources_cloud_types; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_managed_resources_cloud_types ON public.managed_resources USING gin (public.resource_cloud_types(links_json));


--
-- Name: idx_managed_resources_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_managed_resources_updated_at ON public.managed_resources USING btree (updated_at DESC);


--
-- Name: idx_occurrence_channel_resource; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_occurrence_channel_resource ON public.resource_occurrences USING btree (channel_id, resource_id, message_id);


--
-- Name: idx_occurrence_resource; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_occurrence_resource ON public.resource_occurrences USING btree (resource_id);


--
-- Name: idx_outbound_node_reference; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outbound_node_reference ON public.outbound_policy_nodes USING btree (node_id, policy_id);


--
-- Name: idx_resource_gram_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_resource_gram_lookup ON public.resource_grams USING btree (gram, resource_id);


--
-- Name: idx_resource_name_admin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_resource_name_admin ON public.managed_resources USING gin (name public.gin_trgm_ops) WHERE (deleted_at IS NULL);


--
-- Name: idx_resource_sources_enabled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_resource_sources_enabled ON public.resource_sources USING btree (enabled, priority, id);


--
-- Name: idx_resource_tg_fingerprint; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_resource_tg_fingerprint ON public.managed_resources USING btree (fingerprint) WHERE (origin = 'telegram'::text);


--
-- Name: idx_search_logs_keyword_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_search_logs_keyword_trgm ON public.search_logs USING gin (keyword public.gin_trgm_ops);


--
-- Name: idx_search_logs_page; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_search_logs_page ON public.search_logs USING btree (created_at DESC, id DESC);


--
-- Name: idx_search_logs_scope_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_search_logs_scope_created ON public.search_logs USING btree (search_scope, created_at DESC, id DESC);


--
-- Name: idx_search_logs_session_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_search_logs_session_created ON public.search_logs USING btree (session_id, created_at DESC, id DESC) WHERE (session_id IS NOT NULL);


--
-- Name: idx_search_logs_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_search_logs_user_created ON public.search_logs USING btree (user_id, created_at DESC, id DESC);


--
-- Name: idx_search_occurrence_message; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_search_occurrence_message ON public.resource_search_occurrences USING btree (channel_id, message_id, resource_id);


--
-- Name: idx_users_active_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_active_created ON public.users USING btree (created_at DESC, id DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_users_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_created_at ON public.users USING btree (created_at DESC);


--
-- Name: link_catalog_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX link_catalog_due ON public.link_catalog USING btree (provider, next_check_at, id);


--
-- Name: link_catalog_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX link_catalog_expiry ON public.link_catalog USING btree (valid_until, id) WHERE ((validity = ANY (ARRAY[0, 1])) AND (valid_until IS NOT NULL));


--
-- Name: link_catalog_failed_links; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX link_catalog_failed_links ON public.link_catalog USING btree (provider, id) WHERE (failure_count > 0);


--
-- Name: link_check_admin_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX link_check_admin_created ON public.link_check_jobs USING btree (created_at DESC, id DESC);


--
-- Name: link_check_admin_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX link_check_admin_status ON public.link_check_jobs USING btree (status, created_at DESC, id DESC);


--
-- Name: link_check_link_history; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX link_check_link_history ON public.link_check_jobs USING btree (link_id, created_at DESC, id DESC);


--
-- Name: link_check_original_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX link_check_original_active ON public.link_check_jobs USING btree (link_id, input_version) WHERE ((kind = 'original'::text) AND (status = ANY (ARRAY['queued'::text, 'running'::text])));


--
-- Name: link_check_share_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX link_check_share_active ON public.link_check_jobs USING btree (share_cache_id, input_version) WHERE ((kind = 'reshared'::text) AND (status = ANY (ARRAY['queued'::text, 'running'::text])));


--
-- Name: link_cleanup_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX link_cleanup_active ON public.link_cleanup_jobs USING btree (share_cache_id) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text, 'blocked'::text]));


--
-- Name: link_cleanup_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX link_cleanup_due ON public.link_cleanup_jobs USING btree (run_after, id) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));


--
-- Name: link_cleanup_management_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX link_cleanup_management_order ON public.link_cleanup_jobs USING btree (updated_at DESC, id DESC);


--
-- Name: link_resolve_admin_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX link_resolve_admin_created ON public.link_resolve_requests USING btree (created_at DESC, id DESC);


--
-- Name: link_resolve_deadline; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX link_resolve_deadline ON public.link_resolve_requests USING btree (status, deadline_at);


--
-- Name: link_resolve_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX link_resolve_expiry ON public.link_resolve_requests USING btree (expires_at);


--
-- Name: link_share_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX link_share_active ON public.link_share_cache USING btree (link_id, input_version, target_account_key, account_revision, target_dir, policy_revision) WHERE (state <> ALL (ARRAY['expiring'::text, 'cleaning'::text, 'deleted'::text]));


--
-- Name: link_share_cleanup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX link_share_cleanup ON public.link_share_cache USING btree (cleanup_after, id) WHERE (state <> 'deleted'::text);


--
-- Name: link_sync_queue_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX link_sync_queue_order ON public.link_sync_queue USING btree (updated_at, resource_id);


--
-- Name: resource_link_bindings_link; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX resource_link_bindings_link ON public.resource_link_bindings USING btree (link_id, resource_id);


--
-- Name: worker_task_runs_lane_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX worker_task_runs_lane_recent ON public.worker_task_runs USING btree (lane, status, created_at DESC);


--
-- Name: worker_task_runs_retention; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX worker_task_runs_retention ON public.worker_task_runs USING btree (created_at, id);


--
-- Name: worker_task_runs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX worker_task_runs_status ON public.worker_task_runs USING btree (status, id DESC);


--
-- Name: crawl_channels channel_statistics_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER channel_statistics_insert AFTER INSERT ON public.crawl_channels FOR EACH ROW EXECUTE FUNCTION public.initialize_channel_statistics();


--
-- Name: link_catalog link_catalog_reschedule_checks; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER link_catalog_reschedule_checks AFTER UPDATE OF provider, next_check_at ON public.link_catalog FOR EACH ROW WHEN (((old.provider IS DISTINCT FROM new.provider) OR (old.next_check_at IS DISTINCT FROM new.next_check_at))) EXECUTE FUNCTION public.reschedule_original_check_jobs();


--
-- Name: link_check_jobs link_check_prepare; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER link_check_prepare BEFORE INSERT OR UPDATE OF link_id, input_version, status ON public.link_check_jobs FOR EACH ROW EXECUTE FUNCTION public.prepare_original_check_job();


--
-- Name: managed_resources managed_resource_grams_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER managed_resource_grams_insert AFTER INSERT ON public.managed_resources FOR EACH ROW WHEN (((new.origin <> 'telegram'::text) OR new.manual_override)) EXECUTE FUNCTION public.index_resource_text();


--
-- Name: managed_resources managed_resource_grams_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER managed_resource_grams_update AFTER UPDATE OF name, manual_override ON public.managed_resources FOR EACH ROW WHEN ((((new.origin <> 'telegram'::text) OR new.manual_override) AND ((old.name IS DISTINCT FROM new.name) OR (old.manual_override IS DISTINCT FROM new.manual_override)))) EXECUTE FUNCTION public.index_resource_text();


--
-- Name: managed_resources managed_resource_revision; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER managed_resource_revision BEFORE INSERT OR DELETE OR UPDATE OF name, description, datetime, links_json, tags_json, images_json, search_text, enabled, manual_override, deleted_at, origin ON public.managed_resources FOR EACH STATEMENT EXECUTE FUNCTION public.lock_local_index_revision();


--
-- Name: managed_resources managed_resource_revision_insert_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER managed_resource_revision_insert_delete AFTER INSERT OR DELETE ON public.managed_resources FOR EACH ROW EXECUTE FUNCTION public.invalidate_local_index();


--
-- Name: managed_resources managed_resource_revision_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER managed_resource_revision_update AFTER UPDATE ON public.managed_resources FOR EACH ROW WHEN ((((((((((((old.name IS DISTINCT FROM new.name) OR (old.description IS DISTINCT FROM new.description)) OR (old.datetime IS DISTINCT FROM new.datetime)) OR (old.links_json IS DISTINCT FROM new.links_json)) OR (old.tags_json IS DISTINCT FROM new.tags_json)) OR (old.images_json IS DISTINCT FROM new.images_json)) OR (old.search_text IS DISTINCT FROM new.search_text)) OR (old.enabled IS DISTINCT FROM new.enabled)) OR (old.manual_override IS DISTINCT FROM new.manual_override)) OR (old.deleted_at IS DISTINCT FROM new.deleted_at)) OR (old.origin IS DISTINCT FROM new.origin))) EXECUTE FUNCTION public.invalidate_local_index();


--
-- Name: source_messages message_search_lock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER message_search_lock BEFORE UPDATE OF published_at ON public.source_messages FOR EACH STATEMENT EXECUTE FUNCTION public.lock_local_index_revision();


--
-- Name: source_messages message_statistics_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER message_statistics_delete BEFORE DELETE ON public.source_messages FOR EACH ROW EXECUTE FUNCTION public.update_message_statistics();


--
-- Name: source_messages message_statistics_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER message_statistics_insert AFTER INSERT ON public.source_messages FOR EACH ROW EXECUTE FUNCTION public.update_message_statistics();


--
-- Name: source_messages message_statistics_lock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER message_statistics_lock BEFORE INSERT OR DELETE OR UPDATE OF parse_status ON public.source_messages FOR EACH STATEMENT EXECUTE FUNCTION public.lock_local_index_revision();


--
-- Name: source_messages message_statistics_status; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER message_statistics_status AFTER UPDATE OF parse_status ON public.source_messages FOR EACH ROW WHEN ((old.parse_status IS DISTINCT FROM new.parse_status)) EXECUTE FUNCTION public.update_message_statistics();


--
-- Name: resource_occurrences occurrence_commit_lock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER occurrence_commit_lock BEFORE INSERT OR DELETE OR UPDATE ON public.resource_occurrences FOR EACH STATEMENT EXECUTE FUNCTION public.lock_local_index_revision();


--
-- Name: resource_occurrences occurrence_statistics; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER occurrence_statistics AFTER INSERT OR DELETE OR UPDATE OF channel_id, message_id, resource_id ON public.resource_occurrences FOR EACH ROW EXECUTE FUNCTION public.update_occurrence_statistics();


--
-- Name: managed_resources resource_cloud_types_insert_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER resource_cloud_types_insert_delete AFTER INSERT OR DELETE ON public.managed_resources FOR EACH ROW EXECUTE FUNCTION public.sync_resource_cloud_types();


--
-- Name: managed_resources resource_cloud_types_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER resource_cloud_types_truncate AFTER TRUNCATE ON public.managed_resources FOR EACH STATEMENT EXECUTE FUNCTION public.clear_resource_cloud_types();


--
-- Name: managed_resources resource_cloud_types_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER resource_cloud_types_update AFTER UPDATE OF links_json, deleted_at ON public.managed_resources FOR EACH ROW WHEN (((old.links_json IS DISTINCT FROM new.links_json) OR (old.deleted_at IS DISTINCT FROM new.deleted_at))) EXECUTE FUNCTION public.sync_resource_cloud_types();


--
-- Name: managed_resources revise_resource_links; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER revise_resource_links BEFORE UPDATE OF links_json, manual_override ON public.managed_resources FOR EACH ROW EXECUTE FUNCTION public.revise_resource_links();


--
-- Name: managed_resources search_document_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER search_document_insert AFTER INSERT ON public.managed_resources FOR EACH ROW EXECUTE FUNCTION public.sync_resource_search_document();


--
-- Name: managed_resources search_document_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER search_document_update AFTER UPDATE OF name, origin, enabled, deleted_at, manual_override ON public.managed_resources FOR EACH ROW WHEN ((((((old.name IS DISTINCT FROM new.name) OR (old.origin IS DISTINCT FROM new.origin)) OR (old.enabled IS DISTINCT FROM new.enabled)) OR (old.deleted_at IS DISTINCT FROM new.deleted_at)) OR (old.manual_override IS DISTINCT FROM new.manual_override))) EXECUTE FUNCTION public.sync_resource_search_document();


--
-- Name: source_messages search_message_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER search_message_update AFTER UPDATE OF parse_status, published_at ON public.source_messages FOR EACH ROW WHEN (((old.parse_status IS DISTINCT FROM new.parse_status) OR (old.published_at IS DISTINCT FROM new.published_at))) EXECUTE FUNCTION public.sync_message_search_occurrences();


--
-- Name: resource_occurrences search_occurrence_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER search_occurrence_change AFTER INSERT OR DELETE OR UPDATE ON public.resource_occurrences FOR EACH ROW EXECUTE FUNCTION public.sync_resource_search_occurrence();


--
-- Name: managed_resources sync_managed_links; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sync_managed_links AFTER INSERT OR UPDATE OF links_json, manual_override ON public.managed_resources FOR EACH ROW EXECUTE FUNCTION public.enqueue_link_sync();


--
-- Name: resource_occurrences sync_occurrence_links; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sync_occurrence_links AFTER INSERT OR DELETE OR UPDATE ON public.resource_occurrences FOR EACH ROW EXECUTE FUNCTION public.enqueue_link_sync();


--
-- Name: auth_identities auth_identities_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_identities
    ADD CONSTRAINT auth_identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: channel_resource_references channel_resource_references_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_resource_references
    ADD CONSTRAINT channel_resource_references_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.crawl_channels(id) ON DELETE CASCADE;


--
-- Name: channel_statistics channel_statistics_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_statistics
    ADD CONSTRAINT channel_statistics_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.crawl_channels(id) ON DELETE CASCADE;


--
-- Name: cloud_delete_previews cloud_delete_previews_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_delete_previews
    ADD CONSTRAINT cloud_delete_previews_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id);


--
-- Name: cloud_delete_previews cloud_delete_previews_used_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_delete_previews
    ADD CONSTRAINT cloud_delete_previews_used_by_fkey FOREIGN KEY (used_by) REFERENCES public.cloud_drive_operations(request_key);


--
-- Name: cloud_drive_operations cloud_drive_operations_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_drive_operations
    ADD CONSTRAINT cloud_drive_operations_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id);


--
-- Name: cloud_login_sessions cloud_login_sessions_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cloud_login_sessions
    ADD CONSTRAINT cloud_login_sessions_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id);


--
-- Name: crawl_jobs crawl_jobs_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crawl_jobs
    ADD CONSTRAINT crawl_jobs_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.crawl_channels(id);


--
-- Name: crawl_jobs crawl_jobs_failure_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crawl_jobs
    ADD CONSTRAINT crawl_jobs_failure_id_fkey FOREIGN KEY (failure_id) REFERENCES public.crawl_page_failures(id) ON DELETE SET NULL;


--
-- Name: crawl_page_failures crawl_page_failures_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crawl_page_failures
    ADD CONSTRAINT crawl_page_failures_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.crawl_channels(id) ON DELETE CASCADE;


--
-- Name: crawl_page_failures crawl_page_failures_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crawl_page_failures
    ADD CONSTRAINT crawl_page_failures_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.crawl_jobs(id) ON DELETE SET NULL;


--
-- Name: crawl_page_failures crawl_page_failures_retry_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crawl_page_failures
    ADD CONSTRAINT crawl_page_failures_retry_job_id_fkey FOREIGN KEY (retry_job_id) REFERENCES public.crawl_jobs(id) ON DELETE SET NULL;


--
-- Name: link_check_jobs link_check_jobs_link_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.link_check_jobs
    ADD CONSTRAINT link_check_jobs_link_id_fkey FOREIGN KEY (link_id) REFERENCES public.link_catalog(id);


--
-- Name: link_check_jobs link_check_jobs_share_cache_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.link_check_jobs
    ADD CONSTRAINT link_check_jobs_share_cache_id_fkey FOREIGN KEY (share_cache_id) REFERENCES public.link_share_cache(id);


--
-- Name: link_cleanup_jobs link_cleanup_jobs_share_cache_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.link_cleanup_jobs
    ADD CONSTRAINT link_cleanup_jobs_share_cache_id_fkey FOREIGN KEY (share_cache_id) REFERENCES public.link_share_cache(id);


--
-- Name: link_resolve_requests link_resolve_requests_link_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.link_resolve_requests
    ADD CONSTRAINT link_resolve_requests_link_id_fkey FOREIGN KEY (link_id) REFERENCES public.link_catalog(id);


--
-- Name: link_resolve_requests link_resolve_requests_share_cache_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.link_resolve_requests
    ADD CONSTRAINT link_resolve_requests_share_cache_id_fkey FOREIGN KEY (share_cache_id) REFERENCES public.link_share_cache(id);


--
-- Name: link_resolve_requests link_resolve_requests_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.link_resolve_requests
    ADD CONSTRAINT link_resolve_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: link_share_cache link_share_cache_link_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.link_share_cache
    ADD CONSTRAINT link_share_cache_link_id_fkey FOREIGN KEY (link_id) REFERENCES public.link_catalog(id);


--
-- Name: link_sync_queue link_sync_queue_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.link_sync_queue
    ADD CONSTRAINT link_sync_queue_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES public.managed_resources(id) ON DELETE CASCADE;


--
-- Name: outbound_policies outbound_policies_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_policies
    ADD CONSTRAINT outbound_policies_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.crawl_channels(id) ON DELETE CASCADE;


--
-- Name: outbound_policies outbound_policies_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_policies
    ADD CONSTRAINT outbound_policies_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.resource_sources(id) ON DELETE CASCADE;


--
-- Name: outbound_policy_nodes outbound_policy_nodes_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_policy_nodes
    ADD CONSTRAINT outbound_policy_nodes_node_id_fkey FOREIGN KEY (node_id) REFERENCES public.proxy_nodes(id) ON DELETE RESTRICT;


--
-- Name: outbound_policy_nodes outbound_policy_nodes_policy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_policy_nodes
    ADD CONSTRAINT outbound_policy_nodes_policy_id_fkey FOREIGN KEY (policy_id) REFERENCES public.outbound_policies(id) ON DELETE CASCADE;


--
-- Name: resource_grams resource_grams_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_grams
    ADD CONSTRAINT resource_grams_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES public.managed_resources(id) ON DELETE CASCADE;


--
-- Name: resource_link_bindings resource_link_bindings_link_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_link_bindings
    ADD CONSTRAINT resource_link_bindings_link_id_fkey FOREIGN KEY (link_id) REFERENCES public.link_catalog(id);


--
-- Name: resource_link_bindings resource_link_bindings_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_link_bindings
    ADD CONSTRAINT resource_link_bindings_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES public.managed_resources(id) ON DELETE CASCADE;


--
-- Name: resource_occurrences resource_occurrences_channel_id_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_occurrences
    ADD CONSTRAINT resource_occurrences_channel_id_message_id_fkey FOREIGN KEY (channel_id, message_id) REFERENCES public.source_messages(channel_id, message_id);


--
-- Name: resource_occurrences resource_occurrences_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_occurrences
    ADD CONSTRAINT resource_occurrences_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES public.managed_resources(id) ON DELETE CASCADE;


--
-- Name: resource_search_documents resource_search_documents_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_search_documents
    ADD CONSTRAINT resource_search_documents_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES public.managed_resources(id) ON DELETE CASCADE;


--
-- Name: resource_search_occurrences resource_search_occurrences_channel_id_message_id_resource_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_search_occurrences
    ADD CONSTRAINT resource_search_occurrences_channel_id_message_id_resource_fkey FOREIGN KEY (channel_id, message_id, resource_id) REFERENCES public.resource_occurrences(channel_id, message_id, resource_id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: resource_sources resource_sources_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.resource_sources
    ADD CONSTRAINT resource_sources_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.crawl_channels(id);


--
-- Name: search_logs search_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_logs
    ADD CONSTRAINT search_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: source_messages source_messages_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_messages
    ADD CONSTRAINT source_messages_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.crawl_channels(id);


--
-- PostgreSQL database dump complete
--


