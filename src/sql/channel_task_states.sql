SELECT c.id,j.latest_job,
 CASE WHEN NOT c.enabled OR j.status='paused' THEN 'paused'
      WHEN j.status='running' THEN 'running'
      WHEN j.status='queued' THEN 'queued'
      WHEN j.status='failed' THEN 'failed'
      ELSE 'idle' END task_state,
 now() observed_at
FROM crawl_channels c
LEFT JOIN LATERAL (
 SELECT status,jsonb_build_object('id',id,'channelId',channel_id,'kind',kind,'status',status,'pages',pages,'messages',messages,'resources',resources,'failures',failures,'nextRunAt',next_run_at,'attempts',attempts,'cursorBefore',cursor_before,'lastError',last_error,'stopReason',stop_reason,'diagnostics',diagnostics_json,'createdAt',created_at,'updatedAt',updated_at,'completedAt',completed_at) latest_job
 FROM crawl_jobs WHERE channel_id=c.id
 ORDER BY (status='running') DESC,(status IN ('queued','paused','failed')) DESC,id DESC LIMIT 1
) j ON true
WHERE $1::text[] IS NULL OR c.id=ANY($1)
