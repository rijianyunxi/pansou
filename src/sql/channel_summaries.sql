WITH selected AS MATERIALIZED (SELECT id FROM crawl_channels WHERE id=ANY($1)),
message_counts AS (
 SELECT m.channel_id,count(*) message_count,(SELECT count(*) FROM crawl_page_failures f WHERE f.channel_id=m.channel_id) failure_count
 FROM source_messages m WHERE m.channel_id=ANY($1) GROUP BY m.channel_id
),resource_counts AS (
 SELECT o.channel_id,count(DISTINCT o.resource_id COLLATE "C") resource_count
 FROM resource_occurrences o JOIN source_messages m USING(channel_id,message_id)
 JOIN managed_resources r ON r.id=o.resource_id AND r.enabled AND r.deleted_at IS NULL
 WHERE o.channel_id=ANY($1) AND m.parse_status='parsed' GROUP BY o.channel_id
)
SELECT c.id,COALESCE(m.message_count,0) message_count,COALESCE(m.failure_count,0) failure_count,
 COALESCE(r.resource_count,0) resource_count,j.latest_job
FROM selected c LEFT JOIN message_counts m ON m.channel_id=c.id LEFT JOIN resource_counts r ON r.channel_id=c.id
LEFT JOIN LATERAL(
 SELECT jsonb_build_object('id',id,'channelId',channel_id,'kind',kind,'status',status,'pages',pages,'messages',messages,'resources',resources,'failures',failures,'nextRunAt',next_run_at,'attempts',attempts,'cursorBefore',cursor_before,'lastError',last_error,'stopReason',stop_reason,'diagnostics',diagnostics_json,'createdAt',created_at,'updatedAt',updated_at,'completedAt',completed_at) latest_job
 FROM crawl_jobs WHERE channel_id=c.id ORDER BY (status='running') DESC,(status IN ('queued','paused','failed')) DESC,id DESC LIMIT 1
) j ON true;
