WITH completed AS (
UPDATE link_resolve_requests
SET status = 'completed', response_json = $3,
    delivery = $4, reason_code = $5, result_kind = $6,
    completed_at = now(), updated_at = now()
WHERE subject_key = $1 AND request_key = $2
  AND status IN ('queued', 'running') AND response_json IS NULL
  AND (NOT $7 OR deadline_at > clock_timestamp())
RETURNING response_json, share_cache_id, delivery
), delivered AS (
    UPDATE link_share_cache s
    SET ownership_manifest_json = ownership_manifest_json || '{"everDelivered":true}'::jsonb
    FROM completed c WHERE c.share_cache_id = s.id AND c.delivery = 'reshared'
)
SELECT response_json FROM completed;
