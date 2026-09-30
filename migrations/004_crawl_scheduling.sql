-- Keep new-message checks short; review/edit sweeps run separately in background.
ALTER TABLE crawl_channels ADD COLUMN next_review_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '6 hours';
ALTER TABLE crawl_jobs DROP CONSTRAINT crawl_jobs_kind_check;
ALTER TABLE crawl_jobs ADD CONSTRAINT crawl_jobs_kind_check CHECK(kind IN ('sync','backfill','review','reparse'));

-- A crawler tombstone must stay hidden from admin listings and future ingestion.
ALTER TABLE managed_resources ADD COLUMN deleted_at TIMESTAMPTZ;
