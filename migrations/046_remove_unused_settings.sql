-- Keep the API's search configuration version without its legacy configuration tables.
SET LOCAL lock_timeout='10s';
INSERT INTO policy_settings(key,value_json,updated_at)
SELECT 'search-settings-meta','{}'::jsonb,updated_at FROM search_settings WHERE id=1
ON CONFLICT(key) DO NOTHING;
DROP TABLE search_setting_sources,search_settings,system_settings,cloud_account_aliases;

-- Background checks are reconstructable from link_catalog when enabled again.
-- Preserve interactive priority-10 jobs, running leases, and all observations.
DELETE FROM link_check_jobs WHERE kind='original' AND status='queued' AND priority<10
 AND NOT COALESCE((SELECT (value_json->>'enabled')::boolean FROM policy_settings WHERE key='link-check'),false);
UPDATE link_check_enqueue_cursors SET next_check_at=NULL,link_id=NULL
WHERE NOT COALESCE((SELECT (value_json->>'enabled')::boolean FROM policy_settings WHERE key='link-check'),false);
