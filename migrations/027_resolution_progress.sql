ALTER TABLE link_resolve_requests
    ADD COLUMN progress_stage TEXT NOT NULL DEFAULT 'queued'
    CHECK (progress_stage IN ('queued', 'checking', 'transferring', 'sharing', 'reusing'));
