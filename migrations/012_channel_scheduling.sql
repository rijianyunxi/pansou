-- System ingestion and user-submitted live searches are independent.
CREATE TABLE crawl_settings (
 id INTEGER PRIMARY KEY CHECK(id=1),
 concurrent_channels INTEGER NOT NULL DEFAULT 3 CHECK(concurrent_channels BETWEEN 1 AND 32),
 page_delay_seconds INTEGER NOT NULL DEFAULT 3 CHECK(page_delay_seconds BETWEEN 0 AND 3600),
 daily_interval_seconds INTEGER NOT NULL DEFAULT 300 CHECK(daily_interval_seconds BETWEEN 60 AND 86400),
 version BIGINT NOT NULL DEFAULT 1
);
INSERT INTO crawl_settings(id) VALUES(1);
ALTER TABLE crawl_channels ADD COLUMN history_complete BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE crawl_channels ADD COLUMN history_cursor BIGINT;
ALTER TABLE crawl_channels ADD COLUMN history_pages INTEGER NOT NULL DEFAULT 0;
ALTER TABLE crawl_channels ADD COLUMN next_page_at TIMESTAMPTZ NOT NULL DEFAULT now();
UPDATE crawl_channels c SET history_complete=COALESCE(j.stop_reason='accessible_history_end',false),history_cursor=j.cursor_before,history_pages=j.pages
FROM (SELECT DISTINCT ON(channel_id) * FROM crawl_jobs WHERE kind='backfill' ORDER BY channel_id,id DESC) j WHERE c.id=j.channel_id;
DELETE FROM crawl_jobs WHERE kind IN ('review','reparse','reparse_message');
-- Only explicitly maintained channels remain ingestion channels; never publish user-only data.
DELETE FROM resource_occurrences WHERE channel_id IN (SELECT id FROM crawl_channels WHERE NOT managed);
DELETE FROM source_messages WHERE channel_id IN (SELECT id FROM crawl_channels WHERE NOT managed);
DELETE FROM crawl_jobs WHERE channel_id IN (SELECT id FROM crawl_channels WHERE NOT managed);
DELETE FROM resource_sources WHERE kind='telegram';
DELETE FROM crawl_channels WHERE NOT managed;
UPDATE crawl_channels SET enabled=false WHERE archived;
UPDATE crawl_jobs SET status='queued',completed_at=NULL,stop_reason=NULL WHERE kind='backfill' AND status='completed' AND stop_reason='page_budget_reached';
ALTER TABLE crawl_jobs DROP CONSTRAINT crawl_job_target;
DROP INDEX idx_crawl_job_active;
ALTER TABLE crawl_jobs DROP COLUMN target_message_id;
ALTER TABLE crawl_jobs DROP COLUMN max_pages;
ALTER TABLE crawl_jobs DROP CONSTRAINT crawl_jobs_kind_check;
ALTER TABLE crawl_jobs ADD CONSTRAINT crawl_jobs_kind_check CHECK(kind IN ('sync','backfill','retry'));
CREATE UNIQUE INDEX idx_crawl_job_active ON crawl_jobs(channel_id,kind) WHERE status IN ('queued','running','paused') AND kind<>'retry';
CREATE TABLE crawl_page_failures (
 id BIGSERIAL PRIMARY KEY,
 channel_id TEXT NOT NULL REFERENCES crawl_channels(id) ON DELETE CASCADE,
 job_id BIGINT REFERENCES crawl_jobs(id) ON DELETE SET NULL,
 kind TEXT NOT NULL CHECK(kind IN ('sync','backfill')),
 cursor_before BIGINT,
 next_cursor BIGINT,
 page_number INTEGER CHECK(page_number>0),
 last_error TEXT NOT NULL,
 retry_job_id BIGINT REFERENCES crawl_jobs(id) ON DELETE SET NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_crawl_failed_page ON crawl_page_failures(channel_id,kind,COALESCE(cursor_before,0));
CREATE INDEX idx_crawl_failure_channel ON crawl_page_failures(channel_id,id DESC);
ALTER TABLE crawl_jobs ADD COLUMN failure_id BIGINT REFERENCES crawl_page_failures(id) ON DELETE SET NULL;
INSERT INTO crawl_page_failures(channel_id,job_id,kind,cursor_before,page_number,last_error)
 SELECT channel_id,id,kind,cursor_before,pages+1,COALESCE(last_error,'旧任务未成功') FROM crawl_jobs WHERE status='failed'
 ON CONFLICT DO NOTHING;
-- Old review entries have a message ID but no original request page. Preserve an explicit
-- message anchor; NULL page_number means "message-located page", not a fabricated ordinal.
INSERT INTO crawl_page_failures(channel_id,kind,cursor_before,page_number,last_error)
 SELECT channel_id,'backfill',message_id+1,NULL,COALESCE(parse_error,'旧消息解析未成功')
 FROM source_messages WHERE parse_status IN ('failed','review') ON CONFLICT DO NOTHING;
UPDATE source_messages SET parse_status='failed' WHERE parse_status='review';
ALTER TABLE source_messages DROP CONSTRAINT source_messages_parse_status_check;
ALTER TABLE source_messages ADD CONSTRAINT source_messages_parse_status_check CHECK(parse_status IN ('parsed','empty','failed'));
DROP INDEX idx_crawl_review;
ALTER TABLE crawl_channels DROP COLUMN managed;
ALTER TABLE crawl_channels DROP COLUMN archived;
ALTER TABLE crawl_channels DROP COLUMN requested_until;
ALTER TABLE crawl_channels DROP COLUMN interval_seconds;
ALTER TABLE crawl_channels DROP COLUMN next_review_at;
UPDATE config_revisions SET revision=revision+1 WHERE scope='local-index';
