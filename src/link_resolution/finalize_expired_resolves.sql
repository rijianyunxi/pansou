UPDATE link_resolve_requests r
SET status='completed',response_json=p.result,
 delivery=p.result->>'delivery',reason_code=p.result->>'reasonCode',
 result_kind=CASE WHEN p.result->>'status'='unavailable' THEN 'unavailable' ELSE 'available' END,
 completed_at=now(),updated_at=now()
FROM jsonb_to_recordset($1::jsonb) AS p(subject text,key uuid,result jsonb)
WHERE r.subject_key=p.subject AND r.request_key=p.key
 AND r.status IN('queued','running') AND r.response_json IS NULL
 AND r.deadline_at<=clock_timestamp();
