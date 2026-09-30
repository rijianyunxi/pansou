-- TG crawling has durable progress in PostgreSQL; Redis is only a cache.
CREATE TABLE crawl_channels (
 id TEXT PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT true,
 interval_seconds INTEGER NOT NULL DEFAULT 300 CHECK(interval_seconds BETWEEN 60 AND 86400),
 newest_message BIGINT NOT NULL DEFAULT 0, oldest_message BIGINT,
 last_synced_at TIMESTAMPTZ, next_sync_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 last_error TEXT, coverage TEXT NOT NULL DEFAULT 'pending',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE crawl_channels ADD COLUMN requested_until TIMESTAMPTZ;
CREATE TABLE crawl_jobs (
 id BIGSERIAL PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES crawl_channels(id),
 kind TEXT NOT NULL CHECK(kind IN ('sync','backfill','reparse')),
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','paused','cancelled')),
 cursor_before BIGINT, stop_at BIGINT NOT NULL DEFAULT 0, head_message BIGINT,
 pages INTEGER NOT NULL DEFAULT 0, max_pages INTEGER NOT NULL DEFAULT 500 CHECK(max_pages BETWEEN 1 AND 10000),
 messages INTEGER NOT NULL DEFAULT 0, resources INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 0, next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 lease_id UUID, lease_until TIMESTAMPTZ, last_error TEXT, stop_reason TEXT,
 diagnostics_json JSONB NOT NULL DEFAULT '{}'::jsonb,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX idx_crawl_job_active ON crawl_jobs(channel_id,kind) WHERE status IN ('queued','running','paused');
CREATE INDEX idx_crawl_job_ready ON crawl_jobs(next_run_at,id) WHERE status='queued';
CREATE TABLE source_messages (
 channel_id TEXT NOT NULL REFERENCES crawl_channels(id), message_id BIGINT NOT NULL,
 raw_html TEXT NOT NULL, raw_hash TEXT NOT NULL, published_at TIMESTAMPTZ,
 parse_version TEXT NOT NULL, parse_status TEXT NOT NULL CHECK(parse_status IN ('parsed','empty','failed','review')),
 parse_error TEXT, last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(channel_id,message_id)
);
ALTER TABLE resource_sources ADD COLUMN channel_id TEXT REFERENCES crawl_channels(id);
ALTER TABLE managed_resources ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE managed_resources ADD COLUMN fingerprint TEXT;
ALTER TABLE managed_resources ADD COLUMN published_at TIMESTAMPTZ;
ALTER TABLE managed_resources ADD COLUMN manual_override BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX idx_resource_tg_fingerprint ON managed_resources(fingerprint) WHERE origin='telegram';
CREATE TABLE resource_occurrences (
 channel_id TEXT NOT NULL, message_id BIGINT NOT NULL, resource_id TEXT NOT NULL REFERENCES managed_resources(id) ON DELETE CASCADE,
 result_json JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(channel_id,message_id,resource_id),
 FOREIGN KEY(channel_id,message_id) REFERENCES source_messages(channel_id,message_id)
);
CREATE INDEX idx_occurrence_resource ON resource_occurrences(resource_id);
CREATE TABLE resource_links (
 resource_id TEXT NOT NULL REFERENCES managed_resources(id) ON DELETE CASCADE, identity TEXT NOT NULL,
 url TEXT NOT NULL, cloud_type TEXT NOT NULL, password TEXT,
 PRIMARY KEY(resource_id,identity)
);
CREATE INDEX idx_messages_recent ON source_messages(channel_id,message_id DESC);
CREATE INDEX idx_resource_tg_name ON managed_resources USING gin(name gin_trgm_ops) WHERE origin='telegram';
CREATE INDEX idx_resource_tg_date ON managed_resources(published_at DESC,id) WHERE origin='telegram' AND enabled;
-- Character grams provide indexed candidates for short Chinese queries too.
CREATE TABLE resource_grams (
 resource_id TEXT NOT NULL REFERENCES managed_resources(id) ON DELETE CASCADE, gram TEXT NOT NULL,
 PRIMARY KEY(resource_id,gram)
);
CREATE INDEX idx_resource_gram_lookup ON resource_grams(gram,resource_id);
INSERT INTO config_revisions(scope,revision) VALUES('local-index',0) ON CONFLICT DO NOTHING;

-- Invalidate cached results for admin edits, disables and deletes as well as ingestion.
CREATE FUNCTION invalidate_local_index() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE config_revisions SET revision=revision+1 WHERE scope='local-index';
 RETURN NULL;
END $$;
CREATE TRIGGER managed_resource_revision AFTER INSERT OR UPDATE OR DELETE ON managed_resources FOR EACH STATEMENT EXECUTE FUNCTION invalidate_local_index();
CREATE FUNCTION index_resource_text() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE content TEXT;
BEGIN
 content := lower(NEW.search_text);
 DELETE FROM resource_grams WHERE resource_id=NEW.id;
 INSERT INTO resource_grams(resource_id,gram)
 SELECT NEW.id,substring(content FROM p FOR n) FROM generate_series(1,char_length(content)) p CROSS JOIN generate_series(1,2) n
 WHERE p+n-1<=char_length(content) AND btrim(substring(content FROM p FOR n))<>'' ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER managed_resource_grams AFTER INSERT OR UPDATE OF search_text ON managed_resources FOR EACH ROW EXECUTE FUNCTION index_resource_text();
