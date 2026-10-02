WITH retired AS (
    UPDATE link_share_cache s
    SET state = 'expiring', cleanup_after = LEAST(cleanup_after, clock_timestamp()),
        last_error_code = 'deadline_exceeded', updated_at = now()
    FROM link_resolve_requests r
    WHERE r.subject_key = $1 AND r.request_key = $2
      AND r.deadline_at <= clock_timestamp() AND r.share_cache_id = s.id
      AND s.ownership_manifest_json->>'writerRequestKey' = r.request_key::text
      AND s.ownership_manifest_json->>'everDelivered' IS DISTINCT FROM 'true'
      AND s.state NOT IN ('cleaning', 'deleted')
      AND NOT EXISTS (
          SELECT 1 FROM link_resolve_requests delivered
          WHERE delivered.share_cache_id = s.id AND delivered.delivery = 'reshared'
            AND delivered.status = 'completed'
      )
    RETURNING s.id
)
UPDATE link_cleanup_jobs j
SET run_after = LEAST(run_after, clock_timestamp()), updated_at = now()
FROM retired WHERE j.share_cache_id = retired.id AND j.status = 'queued';
