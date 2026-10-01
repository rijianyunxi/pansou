WITH expired AS (
 SELECT id FROM link_check_jobs WHERE status='completed' AND updated_at<now()-interval '7 days'
 ORDER BY updated_at,id LIMIT 1000 FOR UPDATE SKIP LOCKED
)
DELETE FROM link_check_jobs j USING expired WHERE j.id=expired.id;
