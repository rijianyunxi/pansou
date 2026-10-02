-- Bounded, credential-free maintenance executions and lane failures.
CREATE TABLE worker_task_runs (
 id BIGSERIAL PRIMARY KEY,
 lane TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('completed','failed')),
 error_code TEXT,
 duration_ms BIGINT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX worker_task_runs_retention ON worker_task_runs(created_at,id);
CREATE INDEX worker_task_runs_status ON worker_task_runs(status,id DESC);
CREATE INDEX worker_task_runs_lane_recent ON worker_task_runs(lane,status,created_at DESC);
CREATE INDEX link_resolve_admin_created ON link_resolve_requests(created_at DESC,id DESC);
CREATE INDEX link_check_admin_created ON link_check_jobs(created_at DESC,id DESC);
CREATE INDEX crawl_job_admin_created ON crawl_jobs(created_at DESC,id DESC);
