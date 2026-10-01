WITH expired AS (
 SELECT id FROM link_resolve_requests WHERE expires_at<now()
 ORDER BY expires_at,id LIMIT 1000 FOR UPDATE SKIP LOCKED
)
DELETE FROM link_resolve_requests r USING expired WHERE r.id=expired.id;
