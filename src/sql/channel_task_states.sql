WITH capacity AS (
 SELECT (SELECT count(*) FROM crawl_jobs WHERE status='running') < concurrent_channels AS available
 FROM crawl_settings WHERE id=1
)
SELECT c.id,j.latest_job,
 CASE WHEN NOT c.enabled OR j.status='paused' THEN 'paused'
      WHEN j.status='running' THEN 'running'
      WHEN j.status='queued' AND j.kind='sync' AND c.last_synced_at IS NOT NULL AND NOT $2 THEN 'idle'
      WHEN j.status='queued' AND j.attempts>0 AND GREATEST(j.next_run_at,c.next_page_at)>now() THEN 'backoff'
      WHEN j.status='queued' AND (GREATEST(j.next_run_at,c.next_page_at)>now() OR capacity.available) THEN 'running'
      WHEN j.status='queued' THEN 'queued'
      WHEN j.status='failed' THEN 'failed'
      ELSE 'idle' END task_state,
 CASE WHEN NOT c.enabled OR j.status='paused' THEN 'paused'
      WHEN j.status='running' THEN 'fetching'
      WHEN j.status='queued' AND j.kind='sync' AND c.last_synced_at IS NOT NULL AND NOT $2 THEN 'cron_wait'
      WHEN j.status='queued' AND j.attempts>0 AND GREATEST(j.next_run_at,c.next_page_at)>now() THEN 'backoff'
      WHEN j.status='queued' AND GREATEST(j.next_run_at,c.next_page_at)>now() THEN 'page_wait'
      WHEN j.status='queued' AND capacity.available THEN 'ready'
      WHEN j.status='queued' THEN 'queued'
      ELSE NULL END task_phase,
 now() observed_at
FROM crawl_channels c
CROSS JOIN capacity
LEFT JOIN LATERAL (
 SELECT status,kind,attempts,next_run_at,jsonb_build_object('id',id,'channelId',channel_id,'kind',kind,'status',status,'pages',pages,'messages',messages,'resources',resources,'failures',failures,'nextRunAt',next_run_at,'attempts',attempts,'cursorBefore',cursor_before,'lastError',last_error,'stopReason',stop_reason,'diagnostics',diagnostics_json,'createdAt',created_at,'updatedAt',updated_at,'completedAt',completed_at) latest_job
 FROM crawl_jobs WHERE channel_id=c.id
 ORDER BY (status='running') DESC,(status IN ('queued','paused','failed')) DESC,id DESC LIMIT 1
) j ON true
WHERE $1::text[] IS NULL OR c.id=ANY($1)
